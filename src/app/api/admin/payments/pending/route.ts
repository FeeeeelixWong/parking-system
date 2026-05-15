import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getStripe, stripeConfigured } from "@/lib/stripe";
import { handler, json } from "@/lib/api-handler";
import Stripe from "stripe";

const DEMO_ID_RE = /^demo_[a-z0-9-]+_\d{8}_\d{6}_[a-z0-9]{4}$/i;
const PendingQuery = z.object({
  demoId: z.string().trim().max(80).optional().transform((v) =>
    v && DEMO_ID_RE.test(v) ? v : undefined,
  ),
});

export type PendingPaymentItem = {
  sessionId: string;
  driver: { id: string; name: string };
  vehicle: { type: string; licensePlate: string | null } | null;
  spot: { label: string } | null;
  billingStatus: "PAYMENT_FAILED" | "DELINQUENT";
  stripeSubscriptionId: string;
  invoiceId: string | null;
  invoiceAmount: number | null;   // dollars
  periodStart: string | null;     // ISO — billing period this invoice covers
  lastAttemptAt: string | null;   // ISO — when the last charge attempt was made
  nextRetryAt: string | null;     // ISO — next scheduled retry (null = no more)
  attemptCount: number;
};

export const GET = handler({ query: PendingQuery }, async ({ query }) => {
  await requireAdmin();

  const { demoId } = query;

  const sessions = await prisma.session.findMany({
    where: {
      billingStatus: { in: ["PAYMENT_FAILED", "DELINQUENT"] },
      ...(demoId ? { driver: { email: { contains: demoId } } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: {
      driver: { select: { id: true, name: true } },
      vehicle: { select: { type: true, licensePlate: true } },
      spot: { select: { label: true } },
      payments: {
        select: { stripeSubscriptionId: true, stripeInvoiceId: true },
      },
    },
  });

  if (!sessions.length) return json<{ items: PendingPaymentItem[] }>({ items: [] });

  const stripeOk = stripeConfigured();
  const stripe = stripeOk ? getStripe() : null;

  const items = await Promise.all(
    sessions.map(async (session) => {
      const subId = session.payments.find((p) => p.stripeSubscriptionId)?.stripeSubscriptionId;

      const base: PendingPaymentItem = {
        sessionId: session.id,
        driver: session.driver,
        vehicle: session.vehicle,
        spot: session.spot,
        billingStatus: session.billingStatus as "PAYMENT_FAILED" | "DELINQUENT",
        stripeSubscriptionId: subId ?? "",
        invoiceId: null,
        invoiceAmount: null,
        periodStart: null,
        lastAttemptAt: null,
        nextRetryAt: null,
        attemptCount: 0,
      };

      if (!subId || !stripe) return base;

      try {
        const sub = await stripe.subscriptions.retrieve(subId, {
          expand: ["latest_invoice"],
        });

        const invoice = sub.latest_invoice as Stripe.Invoice | null;
        if (!invoice || typeof invoice === "string") return base;

        // Resolve last charge attempt time via InvoicePayments API
        // (invoice.payment_intent was removed in newer Stripe API versions).
        let lastAttemptAt: string | null = null;
        try {
          const invoicePayments = await stripe.invoicePayments.list({
            invoice: invoice.id,
            limit: 1,
          });
          const invPayment = invoicePayments.data[0];
          if (invPayment) {
            const piRef = invPayment.payment?.payment_intent;
            const piId = typeof piRef === "string" ? piRef : piRef?.id ?? null;
            if (piId) {
              const pi = await stripe.paymentIntents.retrieve(piId, {
                expand: ["latest_charge"],
              });
              const charge = pi.latest_charge;
              if (charge && typeof charge !== "string" && charge.created) {
                lastAttemptAt = new Date(charge.created * 1000).toISOString();
              }
            }
          }
        } catch {
          // Skip last-attempt enrichment gracefully.
        }

        return {
          ...base,
          invoiceId: invoice.id,
          invoiceAmount: invoice.amount_due / 100,
          periodStart: invoice.period_start
            ? new Date(invoice.period_start * 1000).toISOString()
            : null,
          lastAttemptAt,
          nextRetryAt: invoice.next_payment_attempt
            ? new Date(invoice.next_payment_attempt * 1000).toISOString()
            : null,
          attemptCount: invoice.attempt_count ?? 0,
        };
      } catch {
        return base;
      }
    }),
  );

  return json<{ items: PendingPaymentItem[] }>({ items });
});
