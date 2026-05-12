import { test } from "@playwright/test";
import { disconnectDb, resetDb } from "../support/db";
import { authenticateAdmin } from "../support/app-api";
import { createWorld } from "../support/world";
import { seedPaidDailyActiveSession } from "../support/scenarios/daily";
import {
  seedOrphanedPaymentSession,
  seedStuckActiveSession,
} from "../support/scenarios/reconcile";
import {
  expectNeedsReviewCode,
} from "../support/assertions/reconcile";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed reconcile tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// PAYMENT-004: positive DB payment with no Stripe charge → critical warning
// ---------------------------------------------------------------------------

test("PAYMENT-004: payment without Stripe charge appears in Needs Review as DB_PAYMENT_WITHOUT_STRIPE_CHARGE", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: ACTIVE session, payment amount=$30, no stripeChargeId, no stripePaymentIntentId.
  // Simulates a webhook that was never received after a manual or legacy payment entry.
  const { session, payment } = await seedOrphanedPaymentSession(world, { amount: 30 });

  await authenticateAdmin(request);

  await expectNeedsReviewCode(
    request,
    "DB_PAYMENT_WITHOUT_STRIPE_CHARGE",
    { sessionId: session.id, paymentId: payment.id },
  );

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// QB-001: Stripe charge exists but no QB receipt → warning
// ---------------------------------------------------------------------------

test("QB-001: payment with Stripe charge but no QB receipt appears in Needs Review as QB_RECEIPT_MISSING", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: ACTIVE session, payment has stripeChargeId and stripePaymentIntentId
  // but no qbSalesReceiptId — simulates a successful Stripe charge with a failed/
  // missing QB Sales Receipt write.
  const { session } = await seedPaidDailyActiveSession(world, { amount: 30 });

  await authenticateAdmin(request);

  await expectNeedsReviewCode(
    request,
    "QB_RECEIPT_MISSING",
    { sessionId: session.id },
  );

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// OVERSTAY-005: ACTIVE session past expectedEnd + grace → stuck-cron warning
// ---------------------------------------------------------------------------

test("OVERSTAY-005: ACTIVE session past expectedEnd + grace appears in Needs Review as ACTIVE_SESSION_PAST_EXPECTED_END", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: ACTIVE session, expectedEnd 2 hours ago. The DB row is still ACTIVE
  // because the cron has not run. The reconcile check fires once expectedEnd +
  // gracePeriodMinutes (15 min default) is exceeded.
  const { session } = await seedStuckActiveSession(world);

  await authenticateAdmin(request);

  await expectNeedsReviewCode(
    request,
    "ACTIVE_SESSION_PAST_EXPECTED_END",
    { sessionId: session.id },
  );

  await world.cleanup();
});
