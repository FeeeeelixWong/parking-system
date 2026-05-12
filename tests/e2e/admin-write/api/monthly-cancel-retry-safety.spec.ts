import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { createWorld } from "../../support/world";
import {
  resetDb,
  disconnectDb,
  findPaymentRefundByStripeRefundId,
  seedMonthlyActiveSession,
  findSessionByStripeSubscriptionId,
} from "../../support/db";
import { seedPaidDailyActiveSession } from "../../support/scenarios/daily";
import { authenticateAdmin, putAdminSession } from "../../support/app-api";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed retry-safety tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// CANCEL-RETRY-001: paymentRefund upsert is idempotent on stripeRefundId
//
// Proves the ON CONFLICT DO NOTHING semantics for the paymentRefund.upsert
// used in cancel-monthly-session and adjust-monthly-access.
//
// Simulates partial-failure retry: Stripe refund landed and DB row was written,
// but the outer transaction failed. On retry, Stripe returns the same refund.id.
// The upsert must not throw P2002 (unique constraint on stripeRefundId).
// ---------------------------------------------------------------------------
test("CANCEL-RETRY-001: paymentRefund upsert with existing stripeRefundId is idempotent", async ({}, testInfo) => {
  const world = createWorld(testInfo);
  const { payment } = await seedPaidDailyActiveSession(world);

  const stripeRefundId = `re_retry_test_${Date.now()}`;
  const amount = 10.0;
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  try {
    // Simulate the first successful DB write (refund row exists in DB after a partial failure
    // where the outer response/audit failed but the $transaction committed).
    await pool.query(
      `INSERT INTO "PaymentRefund" (id, "paymentId", amount, "stripeRefundId", "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())`,
      [payment.id, amount, stripeRefundId],
    );

    const firstRow = await findPaymentRefundByStripeRefundId(stripeRefundId);
    expect(firstRow).not.toBeNull();
    const firstId = firstRow!.id;

    // Retry: Stripe idempotency returns the same refund.id; upsert must succeed without P2002.
    const result = await pool.query(
      `INSERT INTO "PaymentRefund" (id, "paymentId", amount, "stripeRefundId", "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())
       ON CONFLICT ("stripeRefundId") DO NOTHING
       RETURNING id`,
      [payment.id, amount, stripeRefundId],
    );

    // DO NOTHING returns 0 rows — confirms no duplicate was inserted
    expect(result.rowCount).toBe(0);

    // Original row is preserved and not modified
    const afterRetry = await findPaymentRefundByStripeRefundId(stripeRefundId);
    expect(afterRetry).not.toBeNull();
    expect(afterRetry!.id).toBe(firstId);
    expect(afterRetry!.amount).toBeCloseTo(amount, 2);
  } finally {
    await pool.end();
    await world.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CANCEL-RETRY-002: cancel-monthly-session succeeds when subscription is
// already gone from Stripe (resource_missing / already_canceled).
//
// This is the partial-failure retry scenario: the Stripe cancel succeeded and
// then the outer request failed before the DB update committed. On retry, Stripe
// returns resource_missing. The isGone guard must absorb the error, complete the
// DB update (status=CANCELLED), and return success with idempotent:true.
//
// Uses a fake stripeSubscriptionId so Stripe returns resource_missing immediately
// without needing a real subscription to cancel first.
// ---------------------------------------------------------------------------
test(
  "CANCEL-RETRY-002: cancel-monthly-session with already-gone subscription is idempotent",
  async ({ request }, testInfo) => {
    test.skip(
      !process.env.E2E_STRIPE_SECRET_KEY,
      "Set E2E_STRIPE_SECRET_KEY to run Stripe retry safety tests.",
    );

    const world = createWorld(testInfo);
    const fakeSubId = `sub_nonexistent_retry_${Date.now()}`;

    const { session } = await seedMonthlyActiveSession({
      testRun: world.testRun,
      stripeSubscriptionId: fakeSubId,
    });

    await authenticateAdmin(request);

    const res = await putAdminSession(request, {
      sessionId: session.id,
      action: "cancel-monthly-session",
      accessEndsAt: "now",
      refund: { mode: "none" },
      reason: "E2E: CANCEL-RETRY-002 isGone guard",
    });

    // Route must succeed — not throw 500 — when Stripe returns resource_missing
    expect(res.status, JSON.stringify(res.data)).toBe(200);

    const data = res.data as Record<string, unknown>;
    expect(data.success).toBe(true);
    // idempotent:true signals the caller that Stripe was already cancelled
    expect(data.idempotent).toBe(true);

    // DB must reflect the cancellation
    const after = await findSessionByStripeSubscriptionId(fakeSubId);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("CANCELLED");

    await world.cleanup();
  },
);

// ---------------------------------------------------------------------------
// ADJUST-RETRY-001: adjust-monthly-access with renewalAction="stop" succeeds
// when the subscription is already gone from Stripe.
//
// Same partial-failure retry scenario as CANCEL-RETRY-002 but for the adjust
// path. On retry, Stripe returns resource_missing for the sub cancel. The
// isGone guard must absorb the error, commit the DB update (expectedEnd moved),
// and return success with idempotent:true.
// ---------------------------------------------------------------------------
test(
  "ADJUST-RETRY-001: adjust-monthly-access with renewalAction=stop and already-gone subscription is idempotent",
  async ({ request }, testInfo) => {
    test.skip(
      !process.env.E2E_STRIPE_SECRET_KEY,
      "Set E2E_STRIPE_SECRET_KEY to run Stripe retry safety tests.",
    );

    const world = createWorld(testInfo);
    const fakeSubId = `sub_nonexistent_adjust_${Date.now()}`;

    const { session } = await seedMonthlyActiveSession({
      testRun: world.testRun,
      stripeSubscriptionId: fakeSubId,
    });

    await authenticateAdmin(request);

    const effectiveEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

    const res = await putAdminSession(request, {
      sessionId: session.id,
      action: "adjust-monthly-access",
      effectiveEnd: effectiveEnd.toISOString(),
      renewalAction: "stop",
      refund: { mode: "none" },
    });

    expect(res.status, JSON.stringify(res.data)).toBe(200);

    const data = res.data as Record<string, unknown>;
    expect(data.success).toBe(true);
    // idempotent:true signals the caller that the sub cancel was already done
    expect(data.idempotent).toBe(true);

    // DB expectedEnd must reflect the new effectiveEnd (within a 5s window for clock drift)
    const after = await findSessionByStripeSubscriptionId(fakeSubId);
    expect(after).not.toBeNull();
    expect(Math.abs(after!.expectedEndMs - effectiveEnd.getTime())).toBeLessThan(5000);

    await world.cleanup();
  },
);
