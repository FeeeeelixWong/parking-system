import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { constructWebhookEvent, getStripe, StripeConfigError } from "@/lib/stripe";
import { log as audit } from "@/lib/audit";
import { classifySubscriptionDeletion } from "@/lib/billing-access";
import {
  processCheckoutSession,
  processChargeRefund,
  writeSalesReceiptSafe,
  vehicleTypeLabel,
  plateSuffix,
} from "@/lib/stripe-checkout-service";

/**
 * Stripe webhook — the authoritative driver for payment state.
 *
 * Every incoming event is:
 *   1. Signature-verified (signed with STRIPE_WEBHOOK_SECRET).
 *   2. Idempotency-checked via the StripeEvent table (duplicate event.id
 *      short-circuits with STRIPE_WEBHOOK_REPLAYED audit).
 *   3. Dispatched to a handler that writes our Payment row, creates/updates
 *      the Session, and mirrors the outcome to QuickBooks as a Sales Receipt
 *      or Refund Receipt.
 *
 * Handler failures throw; the request returns 500 so Stripe retries. The
 * StripeEvent row is NOT written until all side effects succeed — a partial
 * failure shouldn't block a subsequent retry from completing the work.
 *
 * QB auth failures (QBAuthError — QB not connected) are caught and audited
 * without failing the webhook. All other QB errors propagate so the webhook
 * returns 500 and Stripe retries the event — the StripeEvent row is not
 * written until all side effects succeed, so the retry is safe.
 */
export async function POST(req: NextRequest) {
  // Stripe requires the raw request body for signature verification. Next's
  // NextRequest.text() gives us the unparsed body.
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (err) {
    if (err instanceof StripeConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    // Signature verification failed — 400 per Stripe docs (don't retry).
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Idempotency: if we've already processed this event, short-circuit with
  // a replayed audit. We don't fail — Stripe expects 2xx so it stops retrying.
  const existing = await prisma.stripeEvent.findUnique({ where: { id: event.id } });
  if (existing) {
    await audit({
      action: "STRIPE_WEBHOOK_REPLAYED",
      details: `${event.type} event ${event.id} — already processed at ${existing.processedAt.toISOString()}`,
    });
    await prisma.settings.update({
      where: { id: "default" },
      data: { lastStripeWebhookAt: new Date() },
    });
    return NextResponse.json({ received: true, replayed: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event);
        break;
      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(event);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event);
        break;
      case "charge.refunded":
        await handleChargeRefunded(event);
        break;
      case "charge.dispute.created":
        await handleChargeDisputed(event);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event);
        break;
      default:
        // Unhandled event types are still recorded so the replay-check works.
        // No side effect beyond the audit + event row.
        break;
    }

    await prisma.stripeEvent.upsert({
      where: { id: event.id },
      create: { id: event.id, type: event.type, payload: event as unknown as object },
      update: {},
    });

    await prisma.settings.update({
      where: { id: "default" },
      data: { lastStripeWebhookAt: new Date() },
    });

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[stripe-webhook] handler failed:", event.type, event.id, err);
    // Return 500 so Stripe retries. StripeEvent row is not written, so the
    // retry will re-run the handler.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "handler failed" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Primary creation event for all four session purposes. Stripe fires this
 * once the Checkout UI reports success, regardless of mode (payment or
 * subscription).
 *
 * For one-time (mode=payment): the PaymentIntent carries the charge; we
 * dispatch by metadata.sessionPurpose.
 * For subscription (mode=subscription): the subscription's first invoice
 * is already paid when this fires; we treat it as MONTHLY_CHECKIN and
 * subsequent renewals come in via `invoice.payment_succeeded`.
 */
async function handleCheckoutSessionCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  await processCheckoutSession(session, event.id);
}

/**
 * Fires for every paid subscription invoice — both the first
 * (billing_reason="subscription_create") and all renewals.
 *
 * For subscription_create: the Payment + Session rows were already written by
 * checkout.session.completed, so we skip those writes. However, the charge
 * may not have been resolved when that event fired, so we use this event
 * (where the charge is always present) to write the QB Sales Receipt if still
 * missing.
 *
 * For renewals: advance expectedEnd, create MONTHLY_RENEWAL Payment, write QB receipt.
 */
async function handleInvoicePaymentSucceeded(event: Stripe.Event) {
  // `invoice.subscription` and `invoice.payment_intent` were removed from
  // the Stripe.Invoice base type in SDK v20. Cast to access.
  const invoice = event.data.object as Stripe.Invoice & {
    subscription?: string | Stripe.Subscription | null;
    payment_intent?: string | Stripe.PaymentIntent | null;
  };

  const subscriptionId = typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription?.id ?? null;
  if (!subscriptionId) return;

  // Resolve chargeId via the InvoicePayments API.
  // In the clover API (2025-09-30), invoice.charge and invoice.payment_intent
  // were removed from the Invoice object and moved to InvoicePayment.payment.
  const stripe = getStripe();
  let chargeId: string | null = null;
  let paymentIntentId: string | null = null;
  const invoicePayments = await stripe.invoicePayments.list({ invoice: invoice.id, limit: 1 });
  const invoicePayment = invoicePayments.data[0];
  if (invoicePayment) {
    const piRef = invoicePayment.payment?.payment_intent;
    paymentIntentId = typeof piRef === "string" ? piRef : piRef?.id ?? null;
    if (paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
    }
  }

  const amount = (invoice.amount_paid ?? 0) / 100;

  // Fetch subscription metadata to get the contracted total months (N).
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const totalMonths = parseInt(sub.metadata?.months ?? "1", 10);

  if (invoice.billing_reason === "subscription_create") {
    // Payment + Session already created by checkout.session.completed.
    // Write the QB receipt now using the invoice payment row (lookup by invoiceId).
    if (!chargeId) return;
    const payment = await prisma.payment.findFirst({
      where: { stripeInvoiceId: invoice.id },
      include: { session: { include: { vehicle: true } } },
    });
    if (!payment || payment.qbSalesReceiptId) return; // already written or not found

    // Backfill stripeChargeId — it was null at checkout time (charge hadn't settled yet).
    // Do this before writeSalesReceiptSafe so the updateMany({ where: stripeChargeId }) finds the row.
    if (!payment.stripeChargeId) {
      await prisma.payment.update({ where: { id: payment.id }, data: { stripeChargeId: chargeId } });
    }

    const vt0 = vehicleTypeLabel(payment.session.vehicle.type);
    const plate0 = plateSuffix(payment.session.vehicle.licensePlate ?? undefined);
    await writeSalesReceiptSafe({
      driverId: payment.session.driverId,
      amount: payment.amount,
      description: `${vt0} parking — monthly, month 1 of ${totalMonths}${plate0}`,
      stripeEventId: event.id,
      stripeChargeId: chargeId,
    });
    return;
  }

  // Renewal path — find the session via the first subscription payment.
  const firstPayment = await prisma.payment.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
    orderBy: { createdAt: "asc" },
    include: { session: { include: { vehicle: true } } },
  });
  if (!firstPayment) {
    console.warn(`[stripe-webhook] invoice.payment_succeeded for unknown subscription ${subscriptionId}`);
    return;
  }

  const session = firstPayment.session;

  // Skip if the session was already admin-cancelled — the subscription should have been
  // cancelled in Stripe at the same time, but this guards against race conditions.
  if (session.status === "CANCELLED" || session.status === "COMPLETED") return;

  // Count existing monthly payments to determine position before creating the new one.
  const existingMonthlyCount = await prisma.payment.count({
    where: { sessionId: session.id, type: { in: ["MONTHLY_CHECKIN", "MONTHLY_RENEWAL"] } },
  });
  const renewalPosition = existingMonthlyCount + 1; // new payment will be this position

  // Idempotency: if the Payment row already exists, the DB write succeeded on
  // a prior delivery. Re-attempt the QB receipt write if it's still missing.
  const existingRenewal = await prisma.payment.findFirst({
    where: { stripeInvoiceId: invoice.id, type: "MONTHLY_RENEWAL" },
  });
  if (existingRenewal) {
    if (chargeId && !existingRenewal.qbSalesReceiptId) {
      const vtR2 = vehicleTypeLabel(firstPayment.session.vehicle.type);
      const plateR2 = plateSuffix(firstPayment.session.vehicle.licensePlate ?? undefined);
      // existingMonthlyCount includes the already-created renewal, so it equals the position.
      await writeSalesReceiptSafe({
        driverId: session.driverId,
        amount: existingRenewal.amount,
        description: `${vtR2} parking — monthly, month ${existingMonthlyCount} of ${totalMonths}${plateR2}`,
        stripeEventId: event.id,
        stripeChargeId: chargeId,
      });
    }
    return;
  }

  // expectedEnd was set to the full contracted period at session creation — do NOT advance it.
  // Each MONTHLY_RENEWAL is a payment milestone within that period; the slot was already reserved.
  await prisma.$transaction([
    prisma.session.update({
      where: { id: session.id },
      data: { reminderSent: false, billingStatus: "CURRENT" },
    }),
    prisma.payment.create({
      data: {
        sessionId: session.id,
        type: "MONTHLY_RENEWAL",
        amount,
        stripePaymentIntentId: paymentIntentId,
        stripeChargeId: chargeId,
        stripeSubscriptionId: subscriptionId,
        stripeInvoiceId: invoice.id,
      },
    }),
  ]);

  if (chargeId) {
    const vtR = vehicleTypeLabel(firstPayment.session.vehicle.type);
    const plateR = plateSuffix(firstPayment.session.vehicle.licensePlate ?? undefined);
    await writeSalesReceiptSafe({
      driverId: session.driverId,
      amount,
      description: `${vtR} parking — monthly, month ${renewalPosition} of ${totalMonths}${plateR}`,
      stripeEventId: event.id,
      stripeChargeId: chargeId,
    });
  }
}

async function handleInvoicePaymentFailed(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice & {
    subscription?: string | Stripe.Subscription | null;
  };
  const subscriptionId = typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription?.id ?? null;
  if (!subscriptionId) return;

  const firstPayment = await prisma.payment.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
    include: { session: true },
  });
  if (!firstPayment) return;

  await prisma.session.update({
    where: { id: firstPayment.session.id },
    data: { billingStatus: "PAYMENT_FAILED", billingFailedAt: new Date() },
  });

  await audit({
    action: "RECURRING_CHARGE_FAILED",
    sessionId: firstPayment.session.id,
    driverId: firstPayment.session.driverId,
    details: `Invoice ${invoice.id} payment failed — subscription ${subscriptionId}. Stripe will retry per its dunning schedule.`,
  });
}

async function handleChargeRefunded(event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;
  await processChargeRefund(charge, event.id);
}

async function handleChargeDisputed(event: Stripe.Event) {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;

  const payment = await prisma.payment.findFirst({
    where: { stripeChargeId: chargeId },
    include: { session: true },
  });
  if (!payment) return;

  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: "DISPUTED" },
  });

  await audit({
    action: "PAYMENT_DISPUTED",
    sessionId: payment.sessionId,
    driverId: payment.session.driverId,
    details: `Dispute opened on charge ${chargeId}: ${dispute.reason}. Respond via https://dashboard.stripe.com/disputes/${dispute.id}`,
  });
}

async function handleSubscriptionDeleted(event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription;

  const firstPayment = await prisma.payment.findFirst({
    where: { stripeSubscriptionId: sub.id },
    include: {
      session: {
        select: {
          id: true,
          driverId: true,
          status: true,
          billingCancelledByAdmin: true,
          expectedEnd: true,
        },
      },
    },
  });
  if (!firstPayment) return;

  const session = firstPayment.session;
  const now = new Date();
  const classification = classifySubscriptionDeletion(sub, session, now);

  switch (classification.kind) {
    case "already_ended":
      // Session is CANCELLED or COMPLETED — no further mutation needed.
      return;

    case "admin_planned": {
      if (!classification.accessEnded) {
        // Custom access window still open — suppress any delinquency signal, leave ACTIVE.
        return;
      }
      // Paid period has elapsed — close cleanly as COMPLETED (not CANCELLED, to avoid
      // false-positive CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE in reconcile).
      const newEnd = session.expectedEnd < now ? session.expectedEnd : now;
      await prisma.session.update({
        where: { id: session.id },
        data: {
          status: "COMPLETED",
          ...(newEnd < session.expectedEnd ? { expectedEnd: newEnd } : {}),
        },
      });
      await audit({
        action: "SUBSCRIPTION_CANCELED",
        sessionId: session.id,
        driverId: session.driverId,
        details: `Subscription ${sub.id} canceled at period end — admin-planned (not delinquency). Paid period elapsed; session closed cleanly as COMPLETED.`,
      });
      return;
    }

    case "payment_failed": {
      const newEnd = session.expectedEnd < now ? session.expectedEnd : now;
      await prisma.session.update({
        where: { id: session.id },
        data: {
          billingStatus: "DELINQUENT",
          billingDelinquentAt: now,
          ...(newEnd < session.expectedEnd ? { expectedEnd: newEnd } : {}),
        },
      });
      await audit({
        action: "SUBSCRIPTION_CANCELED",
        sessionId: session.id,
        driverId: session.driverId,
        details: `Subscription ${sub.id} canceled due to payment failure (dunning exhausted). Access ends ${newEnd.toISOString()}. If driver is on property, cron will detect overstay.`,
      });
      return;
    }

    case "payment_disputed": {
      // TODO: Add a dedicated DISPUTED billingStatus and SUBSCRIPTION_ENDED_OUTSIDE_APP
      // Needs Review code for dispute-driven cancellations. For now DELINQUENT blocks gate.
      const newEnd = session.expectedEnd < now ? session.expectedEnd : now;
      await prisma.session.update({
        where: { id: session.id },
        data: {
          billingStatus: "DELINQUENT",
          billingDelinquentAt: now,
          ...(newEnd < session.expectedEnd ? { expectedEnd: newEnd } : {}),
        },
      });
      await audit({
        action: "SUBSCRIPTION_CANCELED",
        sessionId: session.id,
        driverId: session.driverId,
        details: `Subscription ${sub.id} canceled due to payment dispute — not ordinary dunning. Review the dispute in the Stripe dashboard. Access blocked pending resolution.`,
      });
      return;
    }

    case "planned_expiry": {
      if (!classification.accessEnded) {
        // cancel_at_period_end or cancellation_requested with future expectedEnd —
        // the period hasn't elapsed yet; leave session ACTIVE.
        return;
      }
      // Natural expiry (cancel_at = expectedEnd set at checkout, or cancellation_requested)
      // with the access period now elapsed — close cleanly as COMPLETED.
      const newEnd = session.expectedEnd < now ? session.expectedEnd : now;
      await prisma.session.update({
        where: { id: session.id },
        data: {
          status: "COMPLETED",
          ...(newEnd < session.expectedEnd ? { expectedEnd: newEnd } : {}),
        },
      });
      await audit({
        action: "SUBSCRIPTION_CANCELED",
        sessionId: session.id,
        driverId: session.driverId,
        details: `Subscription ${sub.id} ended at planned expiry (cancel_at / cancellation_requested). Session closed cleanly as COMPLETED.`,
      });
      return;
    }

    case "unknown": {
      // TODO: Add SUBSCRIPTION_ENDED_OUTSIDE_APP Needs Review code.
      // No clear payment failure signal — do not auto-DELINQUENT. If the period has elapsed,
      // close as COMPLETED; otherwise leave ACTIVE and surface the anomaly via audit.
      if (classification.accessEnded) {
        const newEnd = session.expectedEnd < now ? session.expectedEnd : now;
        await prisma.session.update({
          where: { id: session.id },
          data: {
            status: "COMPLETED",
            ...(newEnd < session.expectedEnd ? { expectedEnd: newEnd } : {}),
          },
        });
      }
      await audit({
        action: "SUBSCRIPTION_CANCELED",
        sessionId: session.id,
        driverId: session.driverId,
        // Stable prefix [SUB_DEL:UNKNOWN] — the needs-review feed queries on this prefix
        // to surface the deletion for admin review. Do not change without updating
        // src/app/api/admin/reconcile/needs-review/route.ts.
        details: `[SUB_DEL:UNKNOWN] Subscription ${sub.id} ended with unknown reason — outside expected app flow. Manual review required. Session ${classification.accessEnded ? "closed as COMPLETED" : "left ACTIVE until expectedEnd"}.`,
      });
      return;
    }
  }
}
