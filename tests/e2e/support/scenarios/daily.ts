import { seedActiveDriverSession, seedCancelledPaidSession, seedPaidActiveSession, seedExpiredActiveSession, seedPaidMultiDayActiveSession, seedOverstaySessionWithPayment } from "../db";
import type { World } from "../world";

type SeedDailyOverrides = {
  phone?: string;
  name?: string;
  deviceLabel?: string;
};

type SeedCancelledPaidOverrides = {
  phone?: string;
  name?: string;
  amount?: number;
  stripeChargeId?: string;
  cancellationDisposition?: "N_A" | "REFUND_FULL" | "REFUND_PARTIAL_UNUSED" | "REFUND_PARTIAL_CUSTOM" | "RETAINED_INTENTIONAL";
};

type SeedPaidActiveOverrides = {
  phone?: string;
  name?: string;
  amount?: number;
  stripeChargeId?: string;
  stripePaymentIntentId?: string;
};

/**
 * Seed a daily ACTIVE session as a test precondition.
 *
 * Use this when the test is NOT about the check-in creation flow — e.g. testing
 * gate access, extensions, cancellations, or reconcile checks. When the test IS
 * about check-in, drive the UI flow instead.
 *
 * All created rows include `testRunId` via `world.testRun` for traceability.
 */
export async function seedDailyActiveSession(
  world: World,
  overrides?: SeedDailyOverrides,
) {
  return seedActiveDriverSession({
    testRun: world.testRun,
    phone: overrides?.phone,
    name: overrides?.name,
    deviceLabel: overrides?.deviceLabel,
  });
}

/**
 * Seed a CANCELLED daily session with a positive completed Stripe charge.
 *
 * Use this when the test is about reconcile classification of cancelled
 * sessions — not about the cancellation flow itself. The `cancellationDisposition`
 * defaults to "N_A" (unreconciled), which triggers CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE.
 * Set it to a non-N_A value to assert the warning is suppressed.
 */
export async function seedCancelledPaidDailySession(
  world: World,
  overrides?: SeedCancelledPaidOverrides,
) {
  return seedCancelledPaidSession({
    testRun: world.testRun,
    phone: overrides?.phone,
    name: overrides?.name,
    amount: overrides?.amount,
    stripeChargeId: overrides?.stripeChargeId,
    cancellationDisposition: overrides?.cancellationDisposition,
  });
}

/**
 * Seed an ACTIVE daily session with a completed Stripe charge (amount > 0).
 *
 * Use this when the test is about admin cancellation flows — not about the
 * check-in or payment creation flow. The session is ACTIVE so the admin can
 * cancel it through the UI.
 */
export async function seedPaidDailyActiveSession(
  world: World,
  overrides?: SeedPaidActiveOverrides,
) {
  return seedPaidActiveSession({
    testRun: world.testRun,
    phone: overrides?.phone,
    name: overrides?.name,
    amount: overrides?.amount,
    stripeChargeId: overrides?.stripeChargeId,
    stripePaymentIntentId: overrides?.stripePaymentIntentId,
  });
}

/**
 * Seed an ACTIVE daily session whose expectedEnd is 2 hours in the past.
 *
 * DB status is still ACTIVE (cron has not run). Effective status is OVERSTAY
 * because expectedEnd < now. The entry page will show the overstay/settle screen.
 * The reconcile check will flag ACTIVE_SESSION_PAST_EXPECTED_END.
 *
 * Use for OVERSTAY-002 (entry-page denial) and OVERSTAY-005 (stuck-cron reconcile).
 */
export async function seedOverstayEffectiveSession(
  world: World,
  overrides?: { phone?: string; name?: string },
) {
  return seedExpiredActiveSession({
    testRun: world.testRun,
    phone: overrides?.phone,
    name: overrides?.name,
  });
}

/**
 * Seed an ACTIVE session with a 2-day paid CHECKIN (days=2, amount=$60 by default).
 *
 * Use for ADJUST-002 — a 2-day session is required because the Adjust UI
 * UnitStepper has min=1/max=origDays. A 1-day session can't be shortened
 * (min === max === 1), so ADJUST-002 must start with at least 2 days.
 */
export async function seedPaidMultiDayDailySession(
  world: World,
  overrides?: { phone?: string; name?: string; days?: number; amount?: number },
) {
  return seedPaidMultiDayActiveSession({
    testRun: world.testRun,
    phone: overrides?.phone,
    name: overrides?.name,
    days: overrides?.days,
    amount: overrides?.amount,
  });
}

/**
 * Seed an ACTIVE session that is effectively overstay (expectedEnd 3h ago)
 * with a CHECKIN payment (Stripe IDs) and an OVERSTAY payment created NOW.
 *
 * Use for ADMIN-002 — the close action backdated to 2h ago should delete
 * the OVERSTAY payment (createdAt NOW > closedAt 2h ago) and complete the session.
 */
export async function seedOverstaySessionWithCleanupPayment(
  world: World,
  overrides?: { phone?: string; name?: string; checkinAmount?: number; overstayAmount?: number },
) {
  return seedOverstaySessionWithPayment({
    testRun: world.testRun,
    phone: overrides?.phone,
    name: overrides?.name,
    checkinAmount: overrides?.checkinAmount,
    overstayAmount: overrides?.overstayAmount,
  });
}
