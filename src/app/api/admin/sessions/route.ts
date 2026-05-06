import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { log as audit } from "@/lib/audit";
import { handler, json, notFound, conflict } from "@/lib/api-handler";
import { assignSpot } from "@/lib/spots";
import { getSettings } from "@/lib/settings";
import { dailyRate, monthlyRate, addDays, addMonths } from "@/lib/rates";
import { getStripe, refundPaymentIntent, stripeConfigured } from "@/lib/stripe";
import { processChargeRefund } from "@/lib/stripe-checkout-service";

// ---------------------------------------------------------------------------
// PUT: edit a session (extend time, change status)
// ---------------------------------------------------------------------------
const SessionEditBody = z.object({
  sessionId: z.string().min(1),
  action: z.enum(["extend", "cancel", "close", "adjust", "cancel-subscription", "cancel-monthly-session"]),
  // For extend: how many days to add
  days: z.number().int().min(1).max(365).optional(),
  // For cancel/close: reason required
  reason: z.string().min(1).max(500).optional(),
  // For close: backdate the session end to this time
  endedAt: z.string().optional(),
  // For adjust: new effective end time (ISO string) and refund amount in dollars
  effectiveEnd: z.string().optional(),
  refundAmount: z.number().min(0).max(100_000).optional(),
  // For cancel-subscription (legacy): immediately=true cancels now, false=cancel at period end
  // TODO: deprecate once monthly UI fully migrated to cancel-monthly-session.
  cancelImmediately: z.boolean().optional(),
  // For cancel-monthly-session: atomic refund + Stripe sub action + session update.
  accessEndsAt: z.union([z.literal("period_end"), z.literal("now"), z.string().datetime()]).optional(),
  refund: z.object({
    mode: z.enum(["none", "unused_time", "full", "custom"]),
    amount: z.number().min(0).max(100_000).optional(),
  }).optional(),
});

export const PUT = handler({ body: SessionEditBody }, async ({ body }) => {
  await requireAdmin();

  const { sessionId, action, days, reason, endedAt } = body;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { spot: true, driver: true, vehicle: true },
  });

  if (!session) throw notFound("Session not found");

  if (action === "extend") {
    if (!days) {
      return json({ error: "Days required for extension" }, { status: 400 });
    }

    if (!["ACTIVE", "OVERSTAY"].includes(session.status)) {
      return json({ error: "Can only extend active or overstay sessions" }, { status: 400 });
    }

    const newEnd = addDays(session.expectedEnd, days);

    // If session was OVERSTAY, extending it brings it back to ACTIVE
    const newStatus = session.status === "OVERSTAY" ? "ACTIVE" : session.status;

    const updated = await prisma.session.update({
      where: { id: sessionId },
      data: { expectedEnd: newEnd, status: newStatus, reminderSent: false },
    });

    await audit({
      action: "EXTEND",
      sessionId,
      driverId: session.driverId,
      vehicleId: session.vehicleId,
      spotId: session.spotId,
      details: `ADMIN extended ${days}d, new expiry: ${newEnd.toISOString()}, driver: ${session.driver.name}`,
    });

    return json({ session: updated });
  }

  if (action === "cancel") {
    if (!reason) {
      return json({ error: "Reason required for cancellation" }, { status: 400 });
    }

    if (["COMPLETED", "CANCELLED"].includes(session.status)) {
      return json({ error: "Session already ended" }, { status: 400 });
    }

    // Cancel the Stripe subscription BEFORE updating the DB.
    // If Stripe rejects the cancellation, we return an error and leave the session
    // untouched — the admin must not believe a cancellation succeeded while the
    // payment processor is still billing the driver.
    if (stripeConfigured()) {
      const monthlyPayment = await prisma.payment.findFirst({
        where: { sessionId, stripeSubscriptionId: { not: null } },
        select: { stripeSubscriptionId: true },
      });
      if (monthlyPayment?.stripeSubscriptionId) {
        try {
          await getStripe().subscriptions.cancel(monthlyPayment.stripeSubscriptionId);
        } catch (e: unknown) {
          // Stripe considers the subscription gone: treat as already cancelled (safe to proceed).
          const alreadyGone =
            e instanceof Error &&
            (e.message.toLowerCase().includes("already been canceled") ||
              e.message.toLowerCase().includes("no such subscription") ||
              (e as { code?: string }).code === "resource_missing");
          if (!alreadyGone) {
            const msg = e instanceof Error ? e.message : "Unknown Stripe error";
            throw conflict(
              `Stripe subscription cancellation failed: ${msg}. ` +
              `The session has NOT been cancelled — resolve this in Stripe before retrying.`
            );
          }
        }
      }
    }

    // Payments keep their financial status (COMPLETED, REFUNDED, etc.).
    // The admin should issue refunds via the Manage Session modal before cancelling.
    await prisma.session.update({
      where: { id: sessionId },
      data: { status: "CANCELLED", endedAt: new Date() },
    });

    await audit({
      action: "SPOT_FREED",
      sessionId,
      driverId: session.driverId,
      vehicleId: session.vehicleId,
      spotId: session.spotId,
      details: `ADMIN cancelled session. Reason: ${reason}. Driver: ${session.driver.name}, Spot: ${session.spot.label}`,
    });

    return json({ success: true, action: "cancelled" });
  }

  if (action === "close") {
    if (!reason) {
      return json({ error: "Reason required" }, { status: 400 });
    }

    if (["COMPLETED", "CANCELLED"].includes(session.status)) {
      return json({ error: "Session already ended" }, { status: 400 });
    }

    // Parse the backdated end time, default to now
    const closedAt = endedAt ? new Date(endedAt) : new Date();

    // Validate the date is after session start
    if (closedAt < session.startedAt) {
      return json({ error: "End time cannot be before session start" }, { status: 400 });
    }

    // Delete any overstay payments created after the backdated end time
    // (they shouldn't have been charged if the driver actually left at closedAt)
    const deletedPayments = await prisma.payment.deleteMany({
      where: {
        sessionId,
        type: "OVERSTAY",
        createdAt: { gt: closedAt },
      },
    });

    // Complete the session with the backdated end time (spot implicitly freed)
    await prisma.session.update({
      where: { id: sessionId },
      data: { status: "COMPLETED", endedAt: closedAt },
    });

    await audit({
      action: "SPOT_FREED",
      sessionId,
      driverId: session.driverId,
      vehicleId: session.vehicleId,
      spotId: session.spotId,
      details: `ADMIN closed session (backdated to ${closedAt.toISOString()}). Reason: ${reason}. Driver: ${session.driver.name}. ${deletedPayments.count > 0 ? `Removed ${deletedPayments.count} overstay payment(s).` : ""}`,
    });

    return json({ success: true, action: "closed", endedAt: closedAt.toISOString(), paymentsRemoved: deletedPayments.count });
  }

  if (action === "adjust") {
    const { effectiveEnd, refundAmount } = body;

    // --- 1. REFUNDS FIRST (atomicity: if refund throws, session is unchanged) ---
    const refundsIssued: string[] = [];
    if (refundAmount && refundAmount > 0.005) {
      if (!stripeConfigured()) {
        return json({ error: "Stripe is not configured — cannot issue refunds" }, { status: 409 });
      }
      const refundable = await prisma.payment.findMany({
        where: {
          sessionId,
          // Daily one-time + monthly subscription invoices are both refundable when the
          // payment intent / charge is on file. Stripe accepts refunds against the PI
          // regardless of whether the parent invoice came from a subscription.
          type: { in: ["CHECKIN", "EXTENSION", "MONTHLY_CHECKIN", "MONTHLY_RENEWAL"] },
          status: { in: ["COMPLETED", "PARTIALLY_REFUNDED"] },
          stripePaymentIntentId: { not: null },
        },
        orderBy: { createdAt: "desc" },
      });

      // All-or-nothing pre-check: reject 409 if requested exceeds actual refundable balance.
      // Prevents the prior silent partial-refund behaviour that left admin believing the
      // requested amount was issued and could otherwise allow over-refund across calls.
      const totalRefundable = Math.round(
        refundable.reduce((s, p) => s + (p.amount - p.refundedAmount), 0) * 100,
      ) / 100;
      const requested = Math.round(refundAmount * 100) / 100;
      if (requested > totalRefundable + 0.005) {
        throw conflict(
          `Requested refund $${requested.toFixed(2)} exceeds refundable balance $${totalRefundable.toFixed(2)}.`,
        );
      }

      let remaining = requested;
      for (const p of refundable) {
        if (remaining < 0.01) break;
        const maxRefundable = Math.round((p.amount - p.refundedAmount) * 100) / 100;
        if (maxRefundable < 0.01) continue;
        const toRefund = Math.min(remaining, maxRefundable);
        await refundPaymentIntent({
          paymentIntentId: p.stripePaymentIntentId!,
          amount: toRefund,
          reason: "requested_by_customer",
        });
        refundsIssued.push(`${toRefund.toFixed(2)}`);
        remaining = Math.round((remaining - toRefund) * 100) / 100;

        // Best-effort: sync PaymentRefund row + QB Refund Receipt without waiting for webhook.
        try {
          const stripeSync = getStripe();
          let chargeId = p.stripeChargeId ?? null;
          if (!chargeId) {
            const pi = await stripeSync.paymentIntents.retrieve(p.stripePaymentIntentId!, {
              expand: ["latest_charge"],
            });
            chargeId = typeof pi.latest_charge === "string"
              ? pi.latest_charge
              : (pi.latest_charge as { id: string } | null)?.id ?? null;
            if (chargeId) {
              await prisma.payment.update({ where: { id: p.id }, data: { stripeChargeId: chargeId } });
            }
          }
          if (chargeId) {
            const charge = await stripeSync.charges.retrieve(chargeId, { expand: ["refunds"] });
            await processChargeRefund(charge, `admin_adjust_${sessionId}`);
          }
        } catch (err) {
          console.error("[admin/sessions] sync processChargeRefund failed:", err);
        }
      }
    }

    // --- 2. SESSION UPDATE (only after all refunds succeed) ---
    let newStatus = session.status;
    let newEnd = session.expectedEnd;
    let newEndedAt = session.endedAt;
    let deletedOverstay = 0;
    if (effectiveEnd) {
      newEnd = new Date(effectiveEnd);
      if (newEnd < session.startedAt) {
        return json({ error: "End time cannot be before session start" }, { status: 400 });
      }
      // Only complete the session if the new end is in the past.
      // If it's still in the future, keep the session active with the updated expectedEnd.
      if (newEnd <= new Date()) {
        newStatus = "COMPLETED";
        newEndedAt = newEnd;
        // Parity with close action: remove overstay payments charged after the effective end.
        const result = await prisma.payment.deleteMany({
          where: { sessionId, type: "OVERSTAY", createdAt: { gt: newEnd } },
        });
        deletedOverstay = result.count;
      } else {
        newStatus = session.status === "OVERSTAY" ? "ACTIVE" : session.status;
      }
    }

    await prisma.session.update({
      where: { id: sessionId },
      data: {
        expectedEnd: newEnd,
        endedAt: newEndedAt,
        status: newStatus,
      },
    });

    // --- 3. AUDIT ---
    const refundSummary = refundsIssued.length > 0
      ? ` Refunds issued: $${refundsIssued.join(" + $")}.`
      : "";
    const overstayNote = deletedOverstay > 0 ? ` Removed ${deletedOverstay} overstay payment(s).` : "";
    const reasonNote = body.reason ? ` Reason: ${body.reason}.` : "";
    await audit({
      action: "SPOT_FREED",
      sessionId,
      driverId: session.driverId,
      vehicleId: session.vehicleId,
      spotId: session.spotId,
      details: `ADMIN adjusted session. New end: ${newEnd.toISOString()}.${refundSummary}${overstayNote}${reasonNote} Driver: ${session.driver.name}, Spot: ${session.spot.label}.`,
    });

    return json({ success: true, action: "adjusted", refundsIssued });
  }

  if (action === "cancel-subscription") {
    if (!stripeConfigured()) {
      return json({ error: "Stripe not configured" }, { status: 400 });
    }
    const monthlyPayment = await prisma.payment.findFirst({
      where: { sessionId, stripeSubscriptionId: { not: null } },
      select: { stripeSubscriptionId: true },
    });
    const subscriptionId = monthlyPayment?.stripeSubscriptionId;
    if (!subscriptionId) {
      return json({ error: "No active subscription found for this session" }, { status: 400 });
    }
    const stripe = getStripe();
    const immediately = body.cancelImmediately ?? false;
    if (immediately) {
      await stripe.subscriptions.cancel(subscriptionId);
      // customer.subscription.deleted webhook will clamp expectedEnd + set DELINQUENT
    } else {
      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      // Access continues through expectedEnd; no webhook fires until the period ends
    }
    await audit({
      action: "SUBSCRIPTION_CANCELED",
      sessionId,
      driverId: session.driverId,
      details: `Admin canceled subscription ${subscriptionId} ${immediately ? "immediately" : "at period end"}.`,
    });
    return json({ success: true, subscriptionId, immediately });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // cancel-monthly-session — single-payload monthly cancel.
  //
  // This is *ordered* and *fail-fast*, NOT atomic. Refunds run first so a 409
  // pre-check or Stripe refund failure aborts before any subscription/session
  // mutation. After refunds land, a failure in Stripe sub cancel or the DB
  // session update can leave money refunded and the subscription still active —
  // we surface the partial state in the error response (`landed.refund`,
  // `landed.subscription`, `landed.session`) and emit `REFUND_ISSUED` audit
  // before the next step so the partial state is recoverable from logs.
  //
  // TODO: a true atomic command would move all three steps into a single
  // server-side coroutine that compensates Stripe on DB failure. Out of scope.
  // ─────────────────────────────────────────────────────────────────────────────
  if (action === "cancel-monthly-session") {
    if (!stripeConfigured()) {
      return json({ error: "Stripe not configured" }, { status: 400 });
    }
    if (!body.reason || body.reason.trim().length === 0) {
      return json({ error: "Reason is required for monthly cancellation" }, { status: 400 });
    }

    const accessEndsAt = body.accessEndsAt;
    if (!accessEndsAt) {
      return json({ error: "accessEndsAt is required" }, { status: 400 });
    }
    const refundReq = body.refund ?? { mode: "none" as const };

    // ── Resolve access mode and effective date ───────────────────────────────
    const now = new Date();
    let mode: "period_end" | "now" | "custom";
    let customDate: Date | null = null;
    if (accessEndsAt === "period_end") {
      mode = "period_end";
    } else if (accessEndsAt === "now") {
      mode = "now";
    } else {
      const d = new Date(accessEndsAt);
      if (isNaN(d.getTime())) {
        return json({ error: "Invalid accessEndsAt date" }, { status: 400 });
      }
      if (d <= session.startedAt) {
        throw conflict("Custom access end date must be after session start.");
      }
      if (d > session.expectedEnd) {
        throw conflict("Custom access end date cannot extend past current paid-through date. Use Adjust Time.");
      }
      // Past dates collapse to immediate; never leave session ACTIVE with end in the past.
      if (d <= now) {
        mode = "now";
      } else {
        mode = "custom";
        customDate = d;
      }
    }

    // Spec rule 3: period-end cancellations cannot carry a refund disposition.
    if (mode === "period_end" && refundReq.mode !== "none") {
      return json(
        { error: "Refund disposition is not applicable to period-end cancellation." },
        { status: 400 },
      );
    }

    // ── Resolve subscription ─────────────────────────────────────────────────
    const monthlyPayment = await prisma.payment.findFirst({
      where: { sessionId, stripeSubscriptionId: { not: null } },
      select: { stripeSubscriptionId: true },
    });
    const subscriptionId = monthlyPayment?.stripeSubscriptionId;
    if (!subscriptionId) {
      return json({ error: "No active subscription found for this session" }, { status: 400 });
    }

    // ── Resolve refund amount ────────────────────────────────────────────────
    const refundablePayments = await prisma.payment.findMany({
      where: {
        sessionId,
        type: { in: ["MONTHLY_CHECKIN", "MONTHLY_RENEWAL"] },
        status: { in: ["COMPLETED", "PARTIALLY_REFUNDED"] },
        stripePaymentIntentId: { not: null },
      },
      orderBy: { createdAt: "desc" },
    });

    // All refund operations are scoped to the most recent billing period only.
    // Prior periods are already reconciled; their refundability is a separate concern.
    // TODO: once Session.cancellationDisposition exists, expose prior-period refund
    //       history as a separate admin action rather than bundling it here.
    const currentPeriodPayment = refundablePayments[0] ?? null;
    const currentPeriodRefundable = currentPeriodPayment
      ? Math.round(Math.max(0, currentPeriodPayment.amount - currentPeriodPayment.refundedAmount) * 100) / 100
      : 0;

    let resolvedRefund = 0;
    if (refundReq.mode === "full") {
      // "Full refund" = remaining refundable balance for the current billing period only,
      // not all historical subscription payments across prior periods.
      resolvedRefund = currentPeriodRefundable;
    } else if (refundReq.mode === "custom") {
      if (refundReq.amount == null || refundReq.amount <= 0) {
        return json({ error: "Custom refund requires a positive amount." }, { status: 400 });
      }
      resolvedRefund = Math.round(refundReq.amount * 100) / 100;
    } else if (refundReq.mode === "unused_time") {
      // Day-prorated unused-time: paid window is the current period's payment date →
      // expectedEnd. Using the current-period start (not session startedAt) ensures
      // prior subscription periods don't dilute the per-day rate.
      // TODO: if a session has multiple renewal periods, each prior period has its own
      //       prorated window — this only handles the most recent one correctly.
      const paidEnd = session.expectedEnd;
      const periodStart = currentPeriodPayment ? currentPeriodPayment.createdAt : session.startedAt;
      const paidWindowMs = Math.max(1, paidEnd.getTime() - periodStart.getTime());
      const chosenEnd = mode === "now" ? now : customDate!;
      const unusedMs = Math.max(0, paidEnd.getTime() - chosenEnd.getTime());
      const perMsRate = currentPeriodRefundable / paidWindowMs;
      resolvedRefund = Math.min(
        Math.round(unusedMs * perMsRate * 100) / 100,
        currentPeriodRefundable,
      );
    }

    if (resolvedRefund > currentPeriodRefundable + 0.005) {
      throw conflict(
        `Requested refund $${resolvedRefund.toFixed(2)} exceeds current-period refundable balance $${currentPeriodRefundable.toFixed(2)}.`,
      );
    }

    // ── Step 1: refund (if any) ──────────────────────────────────────────────
    const refundsIssued: string[] = [];
    if (resolvedRefund > 0.005) {
      let remaining = resolvedRefund;
      for (const p of refundablePayments) {
        if (remaining <= 0.005) break;
        const maxRefundable = Math.round((p.amount - p.refundedAmount) * 100) / 100;
        if (maxRefundable <= 0.005) continue;
        const toRefund = Math.min(maxRefundable, remaining);
        const cents = Math.round(toRefund * 100);
        if (!p.stripePaymentIntentId) continue;
        const refund = await refundPaymentIntent({
          paymentIntentId: p.stripePaymentIntentId,
          amount: cents / 100,
          reason: "requested_by_customer",
        });
        const newRefundedAmount = Math.round((p.refundedAmount + toRefund) * 100) / 100;
        const fullyRefunded = newRefundedAmount >= p.amount - 0.005;
        await prisma.$transaction([
          prisma.paymentRefund.create({
            data: {
              paymentId: p.id,
              stripeRefundId: refund.id,
              amount: toRefund,
            },
          }),
          prisma.payment.update({
            where: { id: p.id },
            data: {
              refundedAmount: newRefundedAmount,
              refundedAt: new Date(),
              status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
            },
          }),
        ]);
        refundsIssued.push(toRefund.toFixed(2));
        remaining = Math.round((remaining - toRefund) * 100) / 100;
      }

      // Emit refund audit *now*, before any later step can throw — so partial
      // state (refund landed, subscription still active) is visible in logs.
      await audit({
        action: "REFUND_ISSUED",
        sessionId,
        driverId: session.driverId,
        details: `Refund $${resolvedRefund.toFixed(2)} issued for monthly cancellation. Reason: ${body.reason}`,
      });

      // Best-effort: sync QB Refund Receipts without waiting for webhook.
      for (const p of refundablePayments) {
        if (!p.stripePaymentIntentId) continue;
        try {
          const stripeSync = getStripe();
          let chargeId = p.stripeChargeId ?? null;
          if (!chargeId) {
            const pi = await stripeSync.paymentIntents.retrieve(p.stripePaymentIntentId, {
              expand: ["latest_charge"],
            });
            chargeId = typeof pi.latest_charge === "string"
              ? pi.latest_charge
              : (pi.latest_charge as { id: string } | null)?.id ?? null;
            if (chargeId) {
              await prisma.payment.update({ where: { id: p.id }, data: { stripeChargeId: chargeId } });
            }
          }
          if (chargeId) {
            const charge = await stripeSync.charges.retrieve(chargeId, { expand: ["refunds"] });
            await processChargeRefund(charge, `admin_cancel_monthly_${sessionId}`);
          }
        } catch (err) {
          console.error("[admin/sessions] sync processChargeRefund failed:", err);
        }
      }
    }

    // From here on, failures leave Stripe-money state already mutated.
    // Surface the partial effects to the client so admin can recover manually.
    const stripe = getStripe();
    let stripeLanded = false;
    try {
      // ── Step 2: Stripe subscription action ─────────────────────────────────
      if (mode === "period_end") {
        await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
        // TODO: schema migration to add BillingStatus.PENDING_CANCELLATION (or
        // equivalent) so admin UI can show pending-cancel state without
        // re-querying Stripe. Until then, this state is only visible via Stripe
        // dashboard + audit.
      } else {
        await stripe.subscriptions.cancel(subscriptionId);
      }
      stripeLanded = true;

      // ── Step 3: session row update ───────────────────────────────────────
      if (mode === "now") {
        await prisma.session.update({
          where: { id: sessionId },
          data: { status: "CANCELLED", endedAt: now, billingStatus: "CURRENT" },
        });
      } else if (mode === "custom") {
        // custom future date — keep ACTIVE, shorten expectedEnd, cron flips later
        await prisma.session.update({
          where: { id: sessionId },
          data: { expectedEnd: customDate!, billingStatus: "CURRENT" },
        });
      }
      // period_end: no session row change; webhook will complete it on next period boundary
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown failure";
      return json(
        {
          error: stripeLanded
            ? `Subscription cancelled but session update failed: ${msg}`
            : `Subscription cancellation failed: ${msg}`,
          landed: {
            refund: resolvedRefund > 0.005
              ? { amount: resolvedRefund, breakdown: refundsIssued }
              : null,
            subscription: stripeLanded
              ? (mode === "period_end" ? "cancel_at_period_end" : "cancelled")
              : "unchanged",
            session: "unchanged",
          },
        },
        { status: 500 },
      );
    }

    const accessLabel =
      mode === "period_end" ? `through ${session.expectedEnd.toISOString()}`
      : mode === "now" ? "now"
      : `on ${customDate!.toISOString()}`;
    const stripeLabel = mode === "period_end" ? "cancel at period end" : "cancelled now";
    const refundLabel = resolvedRefund > 0.005 ? `$${resolvedRefund.toFixed(2)}` : "none";
    const auditDetails =
      `ADMIN cancelled monthly session. Stripe: ${stripeLabel}. ` +
      `Access: ends ${accessLabel}. Refund: ${refundLabel}. Reason: ${body.reason}`;

    await audit({
      action: "SUBSCRIPTION_CANCELED",
      sessionId,
      driverId: session.driverId,
      details: auditDetails,
    });
    if (mode !== "period_end") {
      await audit({
        action: "SPOT_FREED",
        sessionId,
        driverId: session.driverId,
        vehicleId: session.vehicleId,
        spotId: session.spotId,
        details: auditDetails,
      });
    }

    // TODO (reconcile): persist disposition on Session so reconcile can filter
    // intentional retentions out of CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE
    // without parsing audit text. Suggested:
    //   Session.cancellationDisposition: enum
    //     REFUND_FULL | REFUND_PARTIAL_UNUSED | REFUND_PARTIAL_CUSTOM
    //     | RETAINED_INTENTIONAL | N_A
    return json({
      success: true,
      subscriptionId,
      access: mode,
      refund: { amount: resolvedRefund, breakdown: refundsIssued },
    });
  }

  return json({ error: "Unknown action" }, { status: 400 });
});

// ---------------------------------------------------------------------------
// POST: Admin creates a session manually (driver came to office rather than scanning)
// ---------------------------------------------------------------------------

const AdminSessionCreateSchema = z.object({
  // Driver
  name: z.string().trim().min(1, "Name required").max(120),
  phone: z.string().regex(/^\d{10}$/, "Phone must be exactly 10 digits"),
  email: z.union([z.string().email("Invalid email").max(200), z.literal("")]).optional(),
  // Vehicle
  vehicleType: z.enum(["BOBTAIL", "TRUCK_TRAILER"]),
  licensePlate: z.string().trim().max(20).optional(),
  unitNumber: z.string().trim().max(50).optional(),
  nickname: z.string().trim().max(80).optional(),
  // Duration
  durationType: z.enum(["DAILY", "MONTHLY"]),
  days: z.number().int().min(1).max(30).optional(),
  months: z.number().int().min(1).max(12).optional(),
  // Spot (omit for auto-assign)
  spotId: z.string().min(1).max(200).optional(),
  // QB invoice ID — required when paymentRequired is true, optional otherwise
  invoiceId: z.string().min(1).max(200).optional(),
}).refine(
  (d) => d.licensePlate || d.unitNumber,
  { message: "Provide license plate or unit number", path: ["licensePlate"] }
).refine(
  (d) => (d.durationType === "DAILY" ? d.days != null : d.months != null),
  { message: "Provide days (DAILY) or months (MONTHLY)", path: ["days"] }
);

export const POST = handler(
  { body: AdminSessionCreateSchema },
  async ({ body }) => {
    await requireAdmin();

    const {
      name, phone, email, vehicleType,
      licensePlate, unitNumber, nickname,
      durationType, days, months,
      spotId, invoiceId,
    } = body;

    const settings = await getSettings();

    // ── Upsert driver by phone ───────────────────────────────────────────────
    let driver = await prisma.driver.findUnique({ where: { phone } });
    if (driver) {
      driver = await prisma.driver.update({
        where: { id: driver.id },
        data: { name, ...(email ? { email } : {}) },
      });
    } else {
      driver = await prisma.driver.create({
        data: { phone, name, email: email || "" },
      });
    }

    // ── Upsert vehicle for this driver ───────────────────────────────────────
    const vehicleWhere = {
      driverId: driver.id,
      OR: [
        ...(licensePlate ? [{ licensePlate }] : []),
        ...(unitNumber ? [{ unitNumber }] : []),
      ] as object[],
    };

    let vehicle = await prisma.vehicle.findFirst({ where: vehicleWhere });
    if (vehicle) {
      vehicle = await prisma.vehicle.update({
        where: { id: vehicle.id },
        data: {
          type: vehicleType,
          ...(licensePlate && { licensePlate }),
          ...(unitNumber && { unitNumber }),
          ...(nickname && { nickname }),
        },
      });
    } else {
      vehicle = await prisma.vehicle.create({
        data: {
          driverId: driver.id,
          type: vehicleType,
          licensePlate: licensePlate || null,
          unitNumber: unitNumber || null,
          nickname: nickname || null,
        },
      });
    }

    // ── Check for existing active session ────────────────────────────────────
    const existingSession = await prisma.session.findFirst({
      where: { vehicleId: vehicle.id, status: { in: ["ACTIVE", "OVERSTAY"] } },
    });
    if (existingSession) {
      throw conflict("This vehicle already has an active session");
    }

    // ── Admin-created Payment reference ──────────────────────────────────────
    // Manual admin creations don't run through Stripe Checkout. If the admin
    // collected payment off-platform (cash, wire), they can pass an external
    // reference; otherwise we stamp a free-mode marker. New Stripe-processed
    // check-ins go through /api/payments/checkout, not this route.
    const legacyReference = settings.paymentRequired && invoiceId
      ? invoiceId
      : `free_admin_${randomUUID()}`;

    // ── Assign spot ──────────────────────────────────────────────────────────
    let spot;
    if (spotId) {
      spot = await prisma.spot.findFirst({
        where: {
          id: spotId,
          sessions: { none: { status: { in: ["ACTIVE", "OVERSTAY"] } } },
        },
      });
      if (!spot) throw conflict("Selected spot is not available");
    } else {
      spot = await assignSpot(vehicleType);
      if (!spot) throw conflict("No available spots for this vehicle type");
    }

    // ── Calculate duration & amount ──────────────────────────────────────────
    const isMonthly = durationType === "MONTHLY";
    const now = new Date();

    let expectedEnd: Date;
    let amount: number;
    let paymentType: "CHECKIN" | "MONTHLY_CHECKIN";
    let durationLabel: string;

    if (isMonthly) {
      const mths = months!;
      expectedEnd = addMonths(now, mths);
      amount = monthlyRate(settings, vehicleType) * mths;
      paymentType = "MONTHLY_CHECKIN";
      durationLabel = `${mths} month${mths > 1 ? "s" : ""}`;
    } else {
      const d = days!;
      expectedEnd = addDays(now, d);
      amount = dailyRate(settings, vehicleType) * d;
      paymentType = "CHECKIN";
      durationLabel = `${d}d`;
    }

    // ── Create session ───────────────────────────────────────────────────────
    const session = await prisma.session.create({
      data: {
        id: randomUUID(),
        driverId: driver.id,
        vehicleId: vehicle.id,
        spotId: spot.id,
        startedAt: now,
        expectedEnd,
        status: "ACTIVE",
        termsVersion: settings.termsVersion,
        overstayAuthorized: false,
        payments: {
          create: {
            id: randomUUID(),
            type: paymentType,
            legacyQbReference: legacyReference,
            amount: settings.paymentRequired ? amount : 0,
            status: "COMPLETED",
          },
        },
      },
      include: { spot: true, vehicle: true, driver: true },
    });

    await audit({
      action: "CHECKIN",
      sessionId: session.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      spotId: spot.id,
      details: `ADMIN created session for ${name} — ${durationLabel}, $${(settings.paymentRequired ? amount : 0).toFixed(2)}, spot ${spot.label}, ref ${legacyReference}`,
    });

    return json({ session }, { status: 201 });
  }
);
