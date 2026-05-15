import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import {
  findOrCreateCustomer,
  writeSalesReceipt,
  writeRefundReceipt,
  QBAuthError,
} from "@/lib/quickbooks";
import { assignSpot } from "@/lib/spots";
import { addDays, addMonths, ceilDays } from "@/lib/rates";
import { log as audit } from "@/lib/audit";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type SessionPurpose = "CHECKIN" | "MONTHLY_CHECKIN" | "EXTENSION" | "OVERSTAY";

export type CheckoutMetadata = {
  driverId?: string;
  vehicleId?: string;
  sessionId?: string;
  sessionPurpose?: SessionPurpose;
  durationType?: "DAILY" | "MONTHLY";
  days?: string;
  months?: string;
  termsVersion?: string;
  overstayAuthorized?: string;
  licensePlate?: string;
  vehicleType?: string;
};

// ---------------------------------------------------------------------------
// Public helpers reused by the webhook for non-checkout events
// ---------------------------------------------------------------------------

export function vehicleTypeLabel(type: string | undefined): string {
  return type === "BOBTAIL" ? "Bobtail" : "Truck/trailer";
}

export function plateSuffix(plate: string | undefined): string {
  return plate ? ` - Plate ${plate}` : "";
}

export async function writeSalesReceiptSafe(args: {
  driverId: string;
  amount: number;
  description: string;
  stripeEventId: string;
  stripeChargeId: string;
}) {
  try {
    const driver = await prisma.driver.findUnique({ where: { id: args.driverId } });
    if (!driver) throw new Error(`Driver ${args.driverId} not found for Sales Receipt`);

    let customerId = driver.qbCustomerId;
    if (!customerId) {
      const customer = await findOrCreateCustomer({
        name: driver.name,
        phone: driver.phone,
        email: driver.email ?? undefined,
      });
      customerId = customer.Id;
      await prisma.driver.update({
        where: { id: driver.id },
        data: { qbCustomerId: customerId },
      });
    }

    const receipt = await writeSalesReceipt({
      customerId,
      amount: args.amount,
      description: args.description,
      stripeEventId: args.stripeEventId,
      stripeChargeId: args.stripeChargeId,
    });

    // Store the QB receipt ID and amount so the admin can deep-link and reconcile.
    await prisma.payment.updateMany({
      where: { stripeChargeId: args.stripeChargeId },
      data: { qbSalesReceiptId: receipt.Id, qbSalesReceiptAmount: args.amount },
    });

    await audit({
      action: "SALES_RECEIPT_WRITTEN",
      driverId: args.driverId,
      details: `QB Sales Receipt ${receipt.DocNumber} (id ${receipt.Id}) for $${args.amount.toFixed(2)} (charge ${args.stripeChargeId})`,
    });
  } catch (err) {
    const isAuthError = err instanceof QBAuthError;
    const message = isAuthError
      ? `QB not connected: ${err.message}`
      : err instanceof Error ? err.message : "unknown error";
    console.error("[QB] Sales Receipt write failed:", err);
    await audit({
      action: "SALES_RECEIPT_FAILED",
      driverId: args.driverId,
      details: `QB write failed for charge ${args.stripeChargeId}: ${message}. Reconcile manually.`,
    });
    // QBAuthError means QB isn't connected — retrying won't help, swallow it.
    // Any other error is unexpected; rethrow so webhook returns 500 and Stripe retries.
    if (!isAuthError) throw err;
  }
}

// ---------------------------------------------------------------------------
// Private helpers — only used by processCheckoutSession
// ---------------------------------------------------------------------------

function salesReceiptDescription(purpose: SessionPurpose, metadata: CheckoutMetadata): string {
  const vt = vehicleTypeLabel(metadata.vehicleType);
  const plate = plateSuffix(metadata.licensePlate);
  switch (purpose) {
    case "CHECKIN":
      return `${vt} parking - check-in, ${metadata.days ?? "?"}d${plate}`;
    case "MONTHLY_CHECKIN":
      return `${vt} parking - monthly, month 1 of ${metadata.months ?? "?"}${plate}`;
    case "EXTENSION":
      return `${vt} parking - extension, ${metadata.days ?? "?"}d${plate}`;
    case "OVERSTAY":
      return `${vt} parking - overstay, ${metadata.days ?? "?"}d${plate}`;
  }
}

async function handleCheckin(args: {
  metadata: CheckoutMetadata;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  amount: number;
}) {
  const { metadata, checkoutSessionId, paymentIntentId, chargeId, amount } = args;
  if (!metadata.driverId || !metadata.vehicleId || !metadata.days || !metadata.termsVersion) {
    throw new Error("CHECKIN metadata incomplete");
  }
  const days = parseInt(metadata.days, 10);
  if (!Number.isFinite(days) || days <= 0) throw new Error("CHECKIN invalid days");

  const vehicle = await prisma.vehicle.findUnique({ where: { id: metadata.vehicleId } });
  if (!vehicle) throw new Error(`CHECKIN vehicle ${metadata.vehicleId} not found`);

  const existingActive = await prisma.session.findFirst({
    where: { vehicleId: vehicle.id, status: { in: ["ACTIVE", "OVERSTAY"] } },
  });
  if (existingActive) {
    // Race: driver already has a session. Don't create another, but do write
    // the Payment row so the refund path has a handle.
    await prisma.payment.create({
      data: {
        sessionId: existingActive.id,
        type: "CHECKIN",
        amount,
        days,
        stripeCheckoutSessionId: checkoutSessionId,
        stripePaymentIntentId: paymentIntentId,
        stripeChargeId: chargeId,
      },
    });
    return;
  }

  const now = new Date();
  const expectedEnd = addDays(now, days);

  // Atomic: FOR UPDATE SKIP LOCKED in assignSpot locks the spot row; session.create
  // claims it — both inside the same transaction so no concurrent check-in can race.
  const txResult = await prisma.$transaction(async (tx) => {
    const spot = await assignSpot(vehicle.type, tx);
    if (!spot) return null;
    const created = await tx.session.create({
      data: {
        driverId: metadata.driverId!,
        vehicleId: vehicle.id,
        spotId: spot.id,
        expectedEnd,
        termsVersion: metadata.termsVersion,
        overstayAuthorized: metadata.overstayAuthorized === "true",
        payments: {
          create: {
            type: "CHECKIN",
            amount,
            days,
            stripeCheckoutSessionId: checkoutSessionId,
            stripePaymentIntentId: paymentIntentId,
            stripeChargeId: chargeId,
          },
        },
      },
    });
    return { session: created, spotLabel: spot.label };
  });

  if (!txResult) {
    await audit({
      action: "SALES_RECEIPT_FAILED",
      driverId: metadata.driverId,
      details: `No spot available after CHECKIN payment captured. cs=${checkoutSessionId}, amount=$${amount.toFixed(2)}. Manual refund required.`,
    });
    throw new Error("No spot available after successful payment — admin must refund");
  }
  const { session, spotLabel } = txResult;

  await audit({
    action: "CHECKIN",
    sessionId: session.id,
    driverId: session.driverId,
    vehicleId: session.vehicleId,
    spotId: session.spotId,
    details: `Checked in for ${days}d, paid $${amount.toFixed(2)}, spot: ${spotLabel}, plate: ${vehicle.licensePlate ?? "–"}, terms:v${metadata.termsVersion}`,
  });
}

async function handleMonthlyCheckin(args: {
  metadata: CheckoutMetadata;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  subscriptionId: string | null;
  invoiceId: string | null;
  amount: number;
}) {
  const { metadata, checkoutSessionId, paymentIntentId, chargeId, subscriptionId, invoiceId, amount } = args;
  if (!metadata.driverId || !metadata.vehicleId || !metadata.termsVersion) {
    throw new Error("MONTHLY_CHECKIN metadata incomplete");
  }
  if (!subscriptionId) throw new Error("MONTHLY_CHECKIN missing subscriptionId");

  const vehicle = await prisma.vehicle.findUnique({ where: { id: metadata.vehicleId } });
  if (!vehicle) throw new Error(`MONTHLY_CHECKIN vehicle ${metadata.vehicleId} not found`);

  const existingActive = await prisma.session.findFirst({
    where: { vehicleId: vehicle.id, status: { in: ["ACTIVE", "OVERSTAY"] } },
  });
  if (existingActive) {
    await prisma.payment.create({
      data: {
        sessionId: existingActive.id,
        type: "MONTHLY_CHECKIN",
        amount,
        stripeCheckoutSessionId: checkoutSessionId,
        stripePaymentIntentId: paymentIntentId,
        stripeChargeId: chargeId,
        stripeSubscriptionId: subscriptionId,
        stripeInvoiceId: invoiceId,
      },
    });
    return;
  }

  const now = new Date();
  const initialMonths = metadata.months ? parseInt(metadata.months, 10) : 1;
  const expectedEnd = addMonths(now, initialMonths);

  const txResult = await prisma.$transaction(async (tx) => {
    const spot = await assignSpot(vehicle.type, tx);
    if (!spot) return null;
    const created = await tx.session.create({
      data: {
        driverId: metadata.driverId!,
        vehicleId: vehicle.id,
        spotId: spot.id,
        expectedEnd,
        termsVersion: metadata.termsVersion,
        overstayAuthorized: metadata.overstayAuthorized === "true",
        payments: {
          create: {
            type: "MONTHLY_CHECKIN",
            amount,
            stripeCheckoutSessionId: checkoutSessionId,
            stripePaymentIntentId: paymentIntentId,
            stripeChargeId: chargeId,
            stripeSubscriptionId: subscriptionId,
            stripeInvoiceId: invoiceId,
          },
        },
      },
    });
    return { session: created, spotLabel: spot.label };
  });

  if (!txResult) {
    await audit({
      action: "SALES_RECEIPT_FAILED",
      driverId: metadata.driverId,
      details: `No spot available after MONTHLY_CHECKIN payment. sub=${subscriptionId}, cs=${checkoutSessionId}. Manual refund + subscription cancel required.`,
    });
    throw new Error("No spot available after successful monthly signup");
  }
  const { session, spotLabel } = txResult;

  // Set cancel_at on the subscription so Stripe auto-cancels after the
  // pre-selected period and stops charging the driver.
  const cancelAt = Math.floor(expectedEnd.getTime() / 1000);
  await getStripe().subscriptions.update(subscriptionId, { cancel_at: cancelAt });

  await audit({
    action: "SUBSCRIPTION_CREATED",
    sessionId: session.id,
    driverId: session.driverId,
    details: `Monthly subscription created: sub=${subscriptionId}, first month $${amount.toFixed(2)}, cancel_at=${expectedEnd.toISOString()}`,
  });
  await audit({
    action: "CHECKIN",
    sessionId: session.id,
    driverId: session.driverId,
    vehicleId: session.vehicleId,
    spotId: session.spotId,
    details: `Monthly checkin, spot: ${spotLabel}, plate: ${vehicle.licensePlate ?? "–"}, terms:v${metadata.termsVersion}`,
  });
}

async function handleExtension(args: {
  metadata: CheckoutMetadata;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  amount: number;
}) {
  const { metadata, checkoutSessionId, paymentIntentId, chargeId, amount } = args;
  if (!metadata.sessionId || !metadata.days) {
    throw new Error("EXTENSION metadata incomplete");
  }
  const days = parseInt(metadata.days, 10);
  if (!Number.isFinite(days) || days <= 0) throw new Error("EXTENSION invalid days");

  const session = await prisma.session.findUnique({ where: { id: metadata.sessionId } });
  if (!session) throw new Error(`EXTENSION session ${metadata.sessionId} not found`);

  const newExpectedEnd = addDays(session.expectedEnd, days);
  const newStatus = session.status === "OVERSTAY" ? "ACTIVE" : session.status;

  await prisma.$transaction([
    prisma.session.update({
      where: { id: session.id },
      data: {
        expectedEnd: newExpectedEnd,
        status: newStatus,
        reminderSent: false,
      },
    }),
    prisma.payment.create({
      data: {
        sessionId: session.id,
        type: "EXTENSION",
        amount,
        days,
        stripeCheckoutSessionId: checkoutSessionId,
        stripePaymentIntentId: paymentIntentId,
        stripeChargeId: chargeId,
      },
    }),
  ]);

  await audit({
    action: "EXTEND",
    sessionId: session.id,
    driverId: session.driverId,
    details: `Extended ${days}d, paid $${amount.toFixed(2)}, new expiry: ${newExpectedEnd.toISOString()}`,
  });
}

async function handleOverstay(args: {
  metadata: CheckoutMetadata;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  amount: number;
}) {
  const { metadata, checkoutSessionId, paymentIntentId, chargeId, amount } = args;
  if (!metadata.sessionId) throw new Error("OVERSTAY metadata incomplete");

  const session = await prisma.session.findUnique({
    where: { id: metadata.sessionId },
    include: { vehicle: true, spot: true },
  });
  if (!session) throw new Error(`OVERSTAY session ${metadata.sessionId} not found`);

  const now = new Date();
  const daysOverstay = ceilDays(session.expectedEnd, now);

  await prisma.$transaction([
    prisma.session.update({
      where: { id: session.id },
      data: { status: "COMPLETED", endedAt: now },
    }),
    prisma.payment.create({
      data: {
        sessionId: session.id,
        type: "OVERSTAY",
        amount,
        days: daysOverstay > 0 ? daysOverstay : null,
        stripeCheckoutSessionId: checkoutSessionId,
        stripePaymentIntentId: paymentIntentId,
        stripeChargeId: chargeId,
      },
    }),
  ]);

  await audit({
    action: "OVERSTAY_PAYMENT",
    sessionId: session.id,
    driverId: session.driverId,
    vehicleId: session.vehicleId,
    details: `Overstay ${daysOverstay}d, paid $${amount.toFixed(2)}, plate: ${session.vehicle.licensePlate}`,
  });
  await audit({
    action: "CHECKOUT",
    sessionId: session.id,
    driverId: session.driverId,
    vehicleId: session.vehicleId,
    spotId: session.spotId,
    details: `Checked out from spot ${session.spot.label}, plate: ${session.vehicle.licensePlate}`,
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Process a completed Stripe Checkout Session — called from both the webhook
 * handler and the /api/payments/lookup fallback (when the webhook hasn't
 * arrived yet). Idempotent: no-ops if the Payment row already exists for
 * this checkout session.
 */
export async function processCheckoutSession(
  session: Stripe.Checkout.Session,
  eventId: string,
): Promise<void> {
  // Parse metadata early — needed for the QB retry in the idempotency path.
  const metadata = (session.metadata ?? {}) as CheckoutMetadata;
  const purpose = metadata.sessionPurpose as SessionPurpose | undefined;

  // Idempotency: if the Payment row already exists the DB write succeeded.
  // Re-attempt the QB receipt write if it's still missing — this handles the
  // case where a prior run wrote the Payment but QB failed; Stripe retried the
  // webhook, and we retry just the QB write.
  const existing = await prisma.payment.findFirst({
    where: { stripeCheckoutSessionId: session.id },
  });
  if (existing) {
    if (!existing.qbSalesReceiptId && existing.stripeChargeId && metadata.driverId && purpose) {
      await writeSalesReceiptSafe({
        driverId: metadata.driverId,
        amount: existing.amount,
        description: salesReceiptDescription(purpose, metadata),
        stripeEventId: eventId,
        stripeChargeId: existing.stripeChargeId,
      });
    }
    return;
  }

  if (!metadata.driverId) {
    throw new Error(`checkout.session missing driverId metadata (cs=${session.id})`);
  }
  if (!purpose) {
    throw new Error(`checkout.session missing sessionPurpose metadata (cs=${session.id})`);
  }

  const stripe = getStripe();

  let paymentIntentId: string | null = null;
  let chargeId: string | null = null;
  let subscriptionId: string | null = null;
  let invoiceId: string | null = null;

  if (session.mode === "payment") {
    paymentIntentId = typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;
    if (paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
    }
  } else if (session.mode === "subscription") {
    subscriptionId = typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id ?? null;
    if (subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
      const latestInvoice = sub.latest_invoice as Stripe.Invoice | null;
      invoiceId = latestInvoice?.id ?? null;
      // In the clover API, invoice.payment_intent is gone. Use InvoicePayments API.
      if (invoiceId) {
        const invoicePayments = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 1 });
        const invoicePayment = invoicePayments.data[0];
        if (invoicePayment) {
          const piRef = invoicePayment.payment?.payment_intent;
          paymentIntentId = typeof piRef === "string" ? piRef : piRef?.id ?? null;
          if (paymentIntentId) {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
            chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
          }
        }
      }
    }
  }

  const amountCents = session.amount_total ?? 0;
  const amountDollars = amountCents / 100;

  switch (purpose) {
    case "CHECKIN":
      await handleCheckin({ metadata, checkoutSessionId: session.id, paymentIntentId, chargeId, amount: amountDollars });
      break;
    case "MONTHLY_CHECKIN":
      await handleMonthlyCheckin({ metadata, checkoutSessionId: session.id, paymentIntentId, chargeId, subscriptionId, invoiceId, amount: amountDollars });
      break;
    case "EXTENSION":
      await handleExtension({ metadata, checkoutSessionId: session.id, paymentIntentId, chargeId, amount: amountDollars });
      break;
    case "OVERSTAY":
      await handleOverstay({ metadata, checkoutSessionId: session.id, paymentIntentId, chargeId, amount: amountDollars });
      break;
  }

  if (chargeId) {
    await writeSalesReceiptSafe({
      driverId: metadata.driverId,
      amount: amountDollars,
      description: salesReceiptDescription(purpose, metadata),
      stripeEventId: eventId,
      stripeChargeId: chargeId,
    });
  }
}

// ---------------------------------------------------------------------------
// Refund helpers — shared by webhook and admin routes
// ---------------------------------------------------------------------------

export async function writeRefundReceiptSafe(args: {
  driverId: string;
  amount: number;
  description: string;
  stripeEventId: string;
  stripeRefundId: string;
  stripeChargeId?: string;
  qbSalesReceiptId?: string;
}) {
  try {
    const driver = await prisma.driver.findUnique({ where: { id: args.driverId } });
    if (!driver) throw new Error(`Driver ${args.driverId} not found for Refund Receipt`);

    let customerId = driver.qbCustomerId;
    if (!customerId) {
      const customer = await findOrCreateCustomer({
        name: driver.name,
        phone: driver.phone,
        email: driver.email ?? undefined,
      });
      customerId = customer.Id;
      await prisma.driver.update({
        where: { id: driver.id },
        data: { qbCustomerId: customerId },
      });
    }

    const receipt = await writeRefundReceipt({
      customerId,
      amount: args.amount,
      description: args.description,
      stripeEventId: args.stripeEventId,
      stripeRefundId: args.stripeRefundId,
      stripeChargeId: args.stripeChargeId,
      linkedSalesReceiptId: args.qbSalesReceiptId,
    });

    // Store the QB receipt ID and amount on the PaymentRefund row for deep-linking and reconcile.
    await prisma.paymentRefund.updateMany({
      where: { stripeRefundId: args.stripeRefundId },
      data: { qbRefundReceiptId: receipt.Id, qbRefundReceiptAmount: args.amount },
    });

    const salesRef = args.qbSalesReceiptId ? ` for Sales Receipt ${args.qbSalesReceiptId}` : "";
    await audit({
      action: "REFUND_ISSUED",
      driverId: args.driverId,
      details: `QB Refund Receipt ${receipt.DocNumber} (id ${receipt.Id}) for $${args.amount.toFixed(2)} (refund ${args.stripeRefundId})${salesRef}`,
    });
  } catch (err) {
    const isAuthError = err instanceof QBAuthError;
    const message = isAuthError
      ? `QB not connected: ${err.message}`
      : err instanceof Error ? err.message : "unknown error";
    console.error("[QB] Refund Receipt write failed:", err);
    await audit({
      action: "SALES_RECEIPT_FAILED",
      driverId: args.driverId,
      details: `QB Refund Receipt failed for refund ${args.stripeRefundId}: ${message}. Reconcile manually.`,
    });
    // QBAuthError means QB isn't connected — retrying won't help, swallow it.
    // Any other error is unexpected; rethrow so webhook returns 500 and Stripe retries.
    if (!isAuthError) throw err;
  }
}

export function refundDescription(payment: {
  type: string;
  days: number | null;
  session: { vehicle: { type: string; licensePlate: string | null } };
}): string {
  const vt = vehicleTypeLabel(payment.session.vehicle.type);
  const plate = plateSuffix(payment.session.vehicle.licensePlate ?? undefined);
  const typeMap: Record<string, string> = {
    CHECKIN: `check-in, ${payment.days ?? "?"}d`,
    EXTENSION: `extension, ${payment.days ?? "?"}d`,
    OVERSTAY: `overstay, ${payment.days ?? "?"}d`,
    MONTHLY_CHECKIN: "monthly",
    MONTHLY_RENEWAL: "monthly renewal",
  };
  const detail = typeMap[payment.type] ?? payment.type.toLowerCase();
  return `Refund - ${vt} parking, ${detail}${plate}`;
}

/**
 * Process a Stripe Charge refund — called from both the `charge.refunded`
 * webhook and the admin refund endpoint (fallback when webhook is delayed).
 * Idempotent: `PaymentRefund.upsert` on `stripeRefundId` is safe to call
 * twice; the Payment status update is a no-op if already at REFUNDED.
 */
export async function processChargeRefund(charge: Stripe.Charge, eventId: string): Promise<void> {
  let payment = await prisma.payment.findFirst({
    where: { stripeChargeId: charge.id },
    include: { session: { include: { driver: true, vehicle: true } } },
  });
  // Fallback: if stripeChargeId wasn't written (missed checkout webhook), try PI.
  if (!payment && charge.payment_intent) {
    const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id;
    payment = await prisma.payment.findFirst({
      where: { stripePaymentIntentId: piId },
      include: { session: { include: { driver: true, vehicle: true } } },
    });
    if (payment) {
      await prisma.payment.update({ where: { id: payment.id }, data: { stripeChargeId: charge.id } });
    }
  }
  if (!payment) {
    console.warn(`[stripe] processChargeRefund: unknown charge ${charge.id} (PI: ${charge.payment_intent})`);
    return;
  }

  const totalRefundedCents = charge.amount_refunded;
  const totalRefunded = totalRefundedCents / 100;
  const allRefunds = charge.refunds?.data ?? [];

  const newStatus = totalRefundedCents >= charge.amount
    ? "REFUNDED"
    : totalRefundedCents > 0
      ? "PARTIALLY_REFUNDED"
      : payment.status;

  await prisma.payment.update({
    where: { id: payment.id },
    data: { refundedAmount: totalRefunded, refundedAt: new Date(), status: newStatus },
  });

  // Upsert a PaymentRefund row for every refund on this charge so we never
  // miss one regardless of how many times this function is called.
  for (const r of allRefunds) {
    await prisma.paymentRefund.upsert({
      where: { stripeRefundId: r.id },
      update: {},
      create: { paymentId: payment.id, amount: r.amount / 100, stripeRefundId: r.id },
    });
  }

  await audit({
    action: "REFUND_ISSUED",
    sessionId: payment.sessionId,
    driverId: payment.session.driverId,
    details: `Charge ${charge.id} — total refunded: $${totalRefunded.toFixed(2)} across ${allRefunds.length} refund(s)`,
  });

  // Write a QB Refund Receipt for each refund that doesn't have one yet.
  for (const r of allRefunds) {
    const existing = await prisma.paymentRefund.findUnique({ where: { stripeRefundId: r.id } });
    if (existing?.qbRefundReceiptId) continue; // already written
    await writeRefundReceiptSafe({
      driverId: payment.session.driverId,
      amount: r.amount / 100,
      description: refundDescription(payment),
      stripeEventId: eventId,
      stripeRefundId: r.id,
      stripeChargeId: charge.id,
      qbSalesReceiptId: payment.qbSalesReceiptId ?? undefined,
    });
  }
}
