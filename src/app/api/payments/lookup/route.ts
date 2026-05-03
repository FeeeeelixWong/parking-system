import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handler, json } from "@/lib/api-handler";
import { getStripe } from "@/lib/stripe";
import { processCheckoutSession } from "@/lib/stripe-checkout-service";

const LookupQuery = z.object({
  cs: z.string().min(1).max(200),
});

async function findPayment(cs: string) {
  return prisma.payment.findFirst({
    where: { stripeCheckoutSessionId: cs },
    include: {
      session: { select: { id: true, driverId: true, status: true } },
    },
  });
}

/**
 * GET /api/payments/lookup?cs=cs_...
 *
 * Polled by /payment-complete after a Stripe Checkout redirect. Returns the
 * Payment row written by the webhook. If the webhook hasn't arrived yet (e.g.
 * local dev without Stripe CLI), falls back to retrieving the Stripe Checkout
 * Session directly and processing it synchronously — same idempotent logic
 * the webhook handler uses, so a later webhook delivery is a safe no-op.
 */
export const GET = handler(
  { query: LookupQuery },
  async ({ query }) => {
    const cs = query.cs;

    // Fast path: webhook already wrote the row.
    const existing = await findPayment(cs);
    if (existing) {
      return json({
        status: "ready",
        payment: {
          id: existing.id,
          type: existing.type,
          amount: existing.amount,
          stripePaymentIntentId: existing.stripePaymentIntentId,
          stripeChargeId: existing.stripeChargeId,
        },
        session: existing.session,
      });
    }

    // Fallback: check Stripe directly.
    // If the checkout session is complete and paid, process it now
    // (idempotent — the same function the webhook calls).
    try {
      const stripe = getStripe();
      const stripeSession = await stripe.checkout.sessions.retrieve(cs);

      if (
        stripeSession.status === "complete" &&
        stripeSession.payment_status === "paid"
      ) {
        await processCheckoutSession(stripeSession, `lookup_${cs}`);

        // Re-fetch after processing.
        const created = await findPayment(cs);
        if (created) {
          return json({
            status: "ready",
            payment: {
              id: created.id,
              type: created.type,
              amount: created.amount,
              stripePaymentIntentId: created.stripePaymentIntentId,
              stripeChargeId: created.stripeChargeId,
            },
            session: created.session,
          });
        }
      }
    } catch {
      // Stripe API error or processing failure — fall through to 404 so
      // the client keeps polling (the webhook may still arrive).
    }

    return json({ status: "pending" }, { status: 404 });
  },
);
