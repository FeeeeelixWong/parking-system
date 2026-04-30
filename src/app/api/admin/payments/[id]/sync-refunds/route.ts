import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getStripe, stripeConfigured } from "@/lib/stripe";
import { handler, json, notFound, conflict } from "@/lib/api-handler";
import { processChargeRefund } from "@/lib/stripe-checkout-service";

/**
 * POST /api/admin/payments/[id]/sync-refunds
 * Re-fetch the Stripe charge and re-run processChargeRefund.
 * Idempotent — safe to call repeatedly.
 */
export const POST = handler({}, async ({ params }) => {
  await requireAdmin();
  if (!stripeConfigured()) throw conflict("Stripe is not configured");

  const id = params.id;
  if (!id) throw notFound("Payment not found");

  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) throw notFound("Payment not found");
  if (!payment.stripePaymentIntentId) throw conflict("No Stripe PaymentIntent on this payment");

  const stripe = getStripe();

  let chargeId = payment.stripeChargeId;
  if (!chargeId) {
    const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId, {
      expand: ["latest_charge"],
    });
    chargeId = typeof pi.latest_charge === "string"
      ? pi.latest_charge
      : (pi.latest_charge as { id: string } | null)?.id ?? null;
    if (chargeId) {
      await prisma.payment.update({ where: { id }, data: { stripeChargeId: chargeId } });
    }
  }
  if (!chargeId) throw conflict("No charge found for this PaymentIntent");

  const charge = await stripe.charges.retrieve(chargeId, { expand: ["refunds"] });
  await processChargeRefund(charge, `admin_sync_${id}`);

  const updated = await prisma.payment.findUnique({
    where: { id },
    select: { refundedAmount: true, status: true, refunds: true },
  });

  return json({ ok: true, refundedAmount: updated?.refundedAmount, status: updated?.status });
});
