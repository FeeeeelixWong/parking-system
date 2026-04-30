import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { listRecentCharges, stripeConfigured } from "@/lib/stripe";
import { handler, json, conflict } from "@/lib/api-handler";

/**
 * POST /api/admin/stripe-reconcile — read-only divergence check.
 *
 * Unlike the old QB reconciliation (which wrote state back from QB to our
 * DB), this endpoint NEVER mutates Payment rows. The webhook is the only
 * writer of payment state; reconciliation just compares both sides and
 * flags missing links for an admin to investigate.
 *
 * What we check:
 *   1. Stripe charges (last 90 days) that don't have a matching Payment row
 *      with the same stripeChargeId. Usually means a webhook was missed
 *      (Stripe retries automatically, so this should be rare).
 *   2. Payment rows (same window) with a stripeChargeId that no longer
 *      exists in Stripe (e.g. test-mode cleanup). Rarer still.
 *
 * Results are written to Settings.stripeReconcileFlaggedIds (an array of
 * Stripe charge IDs) so the admin dashboard can surface them persistently.
 */
export const POST = handler({}, async () => {
  await requireAdmin();
  if (!stripeConfigured()) {
    throw conflict("Stripe is not configured");
  }

  const stripeCharges = await listRecentCharges(90);
  const stripeIds = new Set(stripeCharges.map((c) => c.id));

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const dbPayments = await prisma.payment.findMany({
    where: {
      createdAt: { gte: ninetyDaysAgo },
      stripeChargeId: { not: null },
    },
    select: { id: true, stripeChargeId: true, amount: true, createdAt: true },
  });
  const dbIds = new Set(
    dbPayments
      .map((p) => p.stripeChargeId)
      .filter((id): id is string => id !== null),
  );

  const inStripeNotDb = Array.from(stripeIds).filter((id) => !dbIds.has(id));
  const inDbNotStripe = Array.from(dbIds).filter((id) => !stripeIds.has(id));

  const flagged = [...inStripeNotDb, ...inDbNotStripe];

  await prisma.settings.update({
    where: { id: "default" },
    data: {
      lastStripeReconcileAt: new Date(),
      stripeReconcileFlaggedIds: flagged,
    },
  });

  return json({
    stripeChargesChecked: stripeCharges.length,
    dbPaymentsChecked: dbPayments.length,
    inStripeNotDb,
    inDbNotStripe,
    flaggedCount: flagged.length,
  });
});
