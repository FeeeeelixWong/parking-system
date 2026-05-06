import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { refundPaymentIntent, stripeConfigured, getStripe } from "@/lib/stripe";
import { log as audit } from "@/lib/audit";
import { handler, json, notFound, conflict } from "@/lib/api-handler";
import { AdminRefundSchema } from "@/lib/schemas";
import { processChargeRefund } from "@/lib/stripe-checkout-service";

/**
 * POST /api/admin/refund — admin-initiated Stripe refund.
 *
 * This route does NOT mutate the `Payment` row. It only calls Stripe's
 * Refund API. The `charge.refunded` webhook is the single writer of
 * `stripeRefundId`, `refundedAmount`, `refundedAt`, and `status`, and is
 * also responsible for writing the QB Refund Receipt. Keeping that writer
 * single-threaded through the webhook is what makes partial refunds +
 * Stripe-initiated refunds (e.g. from the dashboard) behave the same way
 * as admin-initiated ones.
 *
 * The admin UI polls the Payment row for `refundedAt` to update.
 */
export const POST = handler(
  { body: AdminRefundSchema },
  async ({ body }) => {
    await requireAdmin();
    if (!stripeConfigured()) {
      throw conflict("Stripe is not configured");
    }

    const payment = await prisma.payment.findUnique({
      where: { id: body.paymentId },
    });
    if (!payment) throw notFound("Payment not found");

    if (!payment.stripePaymentIntentId) {
      // Legacy QB payments have no PI to refund via Stripe. Admin must
      // handle those from QB directly.
      throw conflict(
        "This payment predates the Stripe rewrite. Refund it from QuickBooks directly.",
      );
    }

    if (payment.status === "REFUNDED") {
      throw conflict("This payment is already fully refunded");
    }
    if (payment.status === "DISPUTED") {
      throw conflict(
        "This payment is in dispute — respond via Stripe dashboard before refunding",
      );
    }

    const amountCents = body.amount != null ? Math.round(body.amount * 100) : "full";
    const refund = await refundPaymentIntent({
      paymentIntentId: payment.stripePaymentIntentId,
      amount: body.amount,
      reason: body.reason,
      idempotencyKey: `admin_refund_${payment.id}_${amountCents}`,
    });

    await audit({
      action: "REFUND_ISSUED",
      sessionId: payment.sessionId,
      details: `ADMIN initiated refund ${refund.id} for $${(body.amount ?? payment.amount).toFixed(2)} on payment ${payment.id} (PI ${payment.stripePaymentIntentId})${body.reason ? ` — reason: ${body.reason}` : ""}`,
    });

    // Process the refund synchronously so the UI reflects it immediately,
    // even when the charge.refunded webhook hasn't arrived yet (e.g. local
    // dev without Stripe CLI forwarding). The webhook handler is idempotent
    // so a later delivery is a safe no-op.
    try {
      const stripe = getStripe();
      let chargeId = payment.stripeChargeId;
      if (!chargeId) {
        // stripeChargeId is set by the checkout.session.completed webhook; if
        // that webhook was missed, fall back to resolving via the PI.
        const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId, {
          expand: ["latest_charge"],
        });
        chargeId = typeof pi.latest_charge === "string"
          ? pi.latest_charge
          : (pi.latest_charge as { id: string } | null)?.id ?? null;
        if (chargeId) {
          await prisma.payment.update({ where: { id: payment.id }, data: { stripeChargeId: chargeId } });
        }
      }
      if (!chargeId) throw new Error("Could not resolve charge ID from PI");
      const charge = await stripe.charges.retrieve(chargeId, { expand: ["refunds"] });
      await processChargeRefund(charge, `admin_refund_${refund.id}`);
    } catch (err) {
      // Best-effort — webhook will catch up if this fails.
      console.error("[admin/refund] synchronous processChargeRefund failed:", err);
    }

    return json({
      refundId: refund.id,
      status: refund.status,
      amount: refund.amount / 100,
    });
  },
);
