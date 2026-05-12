// ---------------------------------------------------------------------------
// Subscription deletion classification
// ---------------------------------------------------------------------------

/** Narrow input type — compatible with Stripe.Subscription from the Node SDK. */
export interface SubDeletionInput {
  id: string;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean;
  cancellation_details?: { reason?: string | null } | null;
}

export type SubscriptionDeletionClass =
  | { kind: "already_ended" }
  | { kind: "admin_planned"; accessEnded: boolean }
  | { kind: "payment_failed" }
  | { kind: "payment_disputed" }
  | { kind: "planned_expiry"; accessEnded: boolean }
  | { kind: "unknown"; accessEnded: boolean };

/**
 * Classifies why a Stripe subscription was deleted so the webhook handler can
 * take the appropriate action without treating every deletion as delinquency.
 *
 * Priority order:
 * 1. Session already closed (CANCELLED/COMPLETED) → no-op.
 * 2. Admin-flagged (billingCancelledByAdmin) → admin_planned. This is our own flag,
 *    set before calling Stripe, and is more trustworthy than Stripe's cancellation_details.
 * 3. Stripe-reported reason: payment_failed / payment_disputed / cancellation_requested.
 * 4. Structural signal: cancel_at or cancel_at_period_end present → planned_expiry.
 *    This covers monthly checkouts that set cancel_at = expectedEnd at creation.
 * 5. Unknown → conservative (close if expired, leave open if not; never auto-DELINQUENT).
 */
export function classifySubscriptionDeletion(
  sub: SubDeletionInput,
  session: { status: string; billingCancelledByAdmin: boolean; expectedEnd: Date },
  now: Date,
): SubscriptionDeletionClass {
  if (session.status === "CANCELLED" || session.status === "COMPLETED") {
    return { kind: "already_ended" };
  }

  if (session.billingCancelledByAdmin) {
    // 1-hour tolerance: Stripe period-end webhooks can arrive up to ~30 min after the period
    // boundary; 1 hour gives headroom without masking real access. Custom-access windows set
    // by adjust-monthly-access are days away, well above this threshold. A deletion webhook
    // arriving within the final hour will complete the session early — intentional and
    // acceptable given the period is effectively over.
    const ACCESS_ENDED_TOLERANCE_MS = 60 * 60 * 1000;
    const accessEnded = session.expectedEnd.getTime() <= now.getTime() + ACCESS_ENDED_TOLERANCE_MS;
    return { kind: "admin_planned", accessEnded };
  }

  const reason = sub.cancellation_details?.reason ?? null;

  if (reason === "payment_failed") return { kind: "payment_failed" };
  if (reason === "payment_disputed") return { kind: "payment_disputed" };

  // Stripe-planned termination: cancellation_requested (includes our own Stripe API calls),
  // cancel_at (set at monthly checkout = expectedEnd), or cancel_at_period_end.
  if (reason === "cancellation_requested" || sub.cancel_at != null || sub.cancel_at_period_end) {
    const accessEnded = session.expectedEnd.getTime() <= now.getTime();
    return { kind: "planned_expiry", accessEnded };
  }

  // Reason unknown — conservative: never auto-DELINQUENT without a payment failure signal.
  const accessEnded = session.expectedEnd.getTime() <= now.getTime();
  return { kind: "unknown", accessEnded };
}

// ---------------------------------------------------------------------------
// Gate access check
// ---------------------------------------------------------------------------

/**
 * Returns true if gate access should be denied based on the session's billing status,
 * the configured admin policy, and (for after_grace_days) how long ago the failure occurred.
 *
 * DELINQUENT always blocks. PAYMENT_FAILED blocks according to policy:
 * - immediate_on_payment_failed: blocks right away
 * - after_grace_days: blocks inline if billingFailedAt + graceDays <= now (mirrors cron logic).
 *   FAILS CLOSED on a null billingFailedAt — this protects against legacy rows (written
 *   before the column existed) and corrupt rows (where status flipped to PAYMENT_FAILED
 *   without a timestamp) that would otherwise keep gate access open indefinitely. Admin
 *   restores access by clearing billingStatus to "CURRENT".
 * - on_subscription_deleted: PAYMENT_FAILED alone never blocks
 */
export function isAccessBlocked(
  billingStatus: "CURRENT" | "PAYMENT_FAILED" | "DELINQUENT",
  policy: string,
  billingFailedAt?: Date | null,
  graceDays?: number,
): boolean {
  if (billingStatus === "DELINQUENT") return true;
  if (billingStatus === "PAYMENT_FAILED" && policy === "immediate_on_payment_failed") return true;
  if (billingStatus === "PAYMENT_FAILED" && policy === "after_grace_days") {
    if (billingFailedAt == null) return true;
    if (graceDays == null) return true;
    if (billingFailedAt.getTime() + graceDays * 86400000 <= Date.now()) return true;
  }
  return false;
}
