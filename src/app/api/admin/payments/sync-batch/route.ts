import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getStripe, stripeConfigured } from "@/lib/stripe";
import { handler, json } from "@/lib/api-handler";
import { processChargeRefund } from "@/lib/stripe-checkout-service";

const Body = z.object({
  paymentIds: z.array(z.string()).max(100),
});

/**
 * POST /api/admin/payments/sync-batch
 * Fetch each payment's Stripe charge and run processChargeRefund (idempotent).
 * Called automatically after every sessions/payments data load so the DB
 * stays in sync with Stripe without relying solely on webhook delivery.
 */
export const POST = handler({ body: Body }, async ({ body }) => {
  await requireAdmin();
  if (!stripeConfigured()) return json({ synced: 0 });

  const stripe = getStripe();

  const payments = await prisma.payment.findMany({
    where: {
      id: { in: body.paymentIds },
      stripePaymentIntentId: { not: null },
    },
    select: { id: true, stripeChargeId: true, stripePaymentIntentId: true, refundedAmount: true, status: true },
  });

  let synced = 0;
  const failed: string[] = [];

  await Promise.allSettled(payments.map(async (p) => {
    try {
      let chargeId = p.stripeChargeId;
      if (!chargeId) {
        const pi = await stripe.paymentIntents.retrieve(p.stripePaymentIntentId!, {
          expand: ["latest_charge"],
        });
        chargeId = typeof pi.latest_charge === "string"
          ? pi.latest_charge
          : (pi.latest_charge as { id: string } | null)?.id ?? null;
        if (chargeId) {
          await prisma.payment.update({ where: { id: p.id }, data: { stripeChargeId: chargeId } });
        }
      }
      if (!chargeId) return;
      const charge = await stripe.charges.retrieve(chargeId, { expand: ["refunds"] });

      // Skip if Stripe and DB already agree — avoids a no-op DB write.
      const stripeRefundedCents = charge.amount_refunded ?? 0;
      const dbRefundedCents = Math.round(p.refundedAmount * 100);
      if (stripeRefundedCents === dbRefundedCents && p.status === (stripeRefundedCents >= charge.amount ? "REFUNDED" : p.status)) return;

      await processChargeRefund(charge, `batch_sync_${p.id}`);
      synced++;
    } catch {
      failed.push(p.id);
    }
  }));

  return json({ synced, failed });
});
