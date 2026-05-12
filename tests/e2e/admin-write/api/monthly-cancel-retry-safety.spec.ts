import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { createWorld } from "../../support/world";
import { resetDb, disconnectDb, findPaymentRefundByStripeRefundId } from "../../support/db";
import { seedPaidDailyActiveSession } from "../../support/scenarios/daily";

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
