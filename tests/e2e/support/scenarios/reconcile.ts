import {
  seedActiveSessionWithOrphanedPayment,
  seedExpiredActiveSession,
} from "../db";
import type { World } from "../world";

type SeedOrphanedPaymentOverrides = {
  phone?: string;
  name?: string;
  amount?: number;
};

/**
 * Seed an ACTIVE session with a positive COMPLETED payment that has no Stripe IDs.
 *
 * Use this when the test is about the DB_PAYMENT_WITHOUT_STRIPE_CHARGE Needs Review check.
 * The payment is intentionally missing stripeChargeId and stripePaymentIntentId —
 * simulating a webhook that was never received after a manual or legacy payment row.
 */
export async function seedOrphanedPaymentSession(
  world: World,
  overrides?: SeedOrphanedPaymentOverrides,
) {
  return seedActiveSessionWithOrphanedPayment({
    testRun: world.testRun,
    phone: overrides?.phone,
    name: overrides?.name,
    amount: overrides?.amount,
  });
}

/**
 * Seed an ACTIVE session whose expectedEnd is 2 hours in the past.
 *
 * DB status is ACTIVE (cron has not run). Effective status is OVERSTAY.
 * The reconcile ACTIVE_SESSION_PAST_EXPECTED_END check fires once the session
 * is past expectedEnd + gracePeriodMinutes (default 15 min).
 *
 * Use for OVERSTAY-005 (stuck-cron reconcile flag).
 */
export async function seedStuckActiveSession(
  world: World,
  overrides?: { phone?: string; name?: string },
) {
  return seedExpiredActiveSession({
    testRun: world.testRun,
    phone: overrides?.phone,
    name: overrides?.name,
  });
}
