import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getStripe, stripeConfigured } from "@/lib/stripe";
import { getSettings } from "@/lib/settings";
import { handler, json } from "@/lib/api-handler";
import { RECONCILE_ISSUE_DEFINITIONS, type NeedsReviewCode, type NeedsReviewItem, type NeedsReviewResponse } from "@/types/reconcile";

function fmt(n: number) {
  return `$${n.toFixed(2)}`;
}

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function makeItem(
  code: NeedsReviewCode,
  title: string,
  detail: string,
  recommendedAction: string,
  actionLabel: string | undefined,
  related: NeedsReviewItem["related"],
  occurredAt?: string,
): NeedsReviewItem {
  // Build a stable, deterministic ID from code + related IDs
  const parts = [code, related.sessionId ?? "", related.paymentId ?? "", related.refundId ?? ""];
  return {
    id: parts.filter(Boolean).join(":"),
    code,
    severity: RECONCILE_ISSUE_DEFINITIONS[code].severity,
    title,
    detail,
    recommendedAction,
    actionLabel,
    related,
    occurredAt,
  };
}

export const GET = handler({}, async ({ req }) => {
  await requireAdmin();

  const url = new URL(req.url);
  // severity=warning means "all non-ok items" (warning + critical); severity=critical means only critical
  const severityFilter = (url.searchParams.get("severity") ?? "all") as "all" | "warning" | "critical";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const sessions = await prisma.session.findMany({
    where: { createdAt: { gte: ninetyDaysAgo } },
    orderBy: { createdAt: "desc" },
    include: {
      driver: { select: { id: true, name: true } },
      payments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          type: true,
          amount: true,
          status: true,
          createdAt: true,
          stripeChargeId: true,
          stripePaymentIntentId: true,
          stripeSubscriptionId: true,
          qbSalesReceiptId: true,
          qbSalesReceiptAmount: true,
          refunds: {
            select: {
              id: true,
              amount: true,
              stripeRefundId: true,
              qbRefundReceiptId: true,
              qbRefundReceiptAmount: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });

  // Stripe data fetching — same pattern as /api/admin/reconcile
  const stripeOk = stripeConfigured();
  const stripe = stripeOk ? getStripe() : null;

  const allChargeIds = new Set<string>();
  const allRefundIds = new Set<string>();
  for (const s of sessions) {
    for (const p of s.payments) {
      if (p.stripeChargeId) allChargeIds.add(p.stripeChargeId);
      for (const r of p.refunds) {
        if (r.stripeRefundId) allRefundIds.add(r.stripeRefundId);
      }
    }
  }

  const chargeAmountMap = new Map<string, number>(); // chargeId → dollars
  const refundAmountMap = new Map<string, number>();  // refundId → dollars
  const invoiceCountMap = new Map<string, number>();  // sessionId → paid invoice count

  if (stripe) {
    const monthlySessionsWithSub = sessions.filter(
      (s) => s.payments.some((p) => p.stripeSubscriptionId),
    );

    await Promise.all([
      ...monthlySessionsWithSub.map(async (s) => {
        const subId = s.payments.find((p) => p.stripeSubscriptionId)?.stripeSubscriptionId;
        if (!subId) return;
        try {
          const invoices = await stripe.invoices.list({ subscription: subId, limit: 100 });
          invoiceCountMap.set(s.id, invoices.data.filter((inv) => inv.status === "paid").length);
        } catch { /* skip if Stripe call fails */ }
      }),

      ...[...allChargeIds].map(async (chargeId) => {
        try {
          const charge = await stripe.charges.retrieve(chargeId);
          chargeAmountMap.set(chargeId, charge.amount / 100);
        } catch { /* skip */ }
      }),

      ...[...allRefundIds].map(async (refundId) => {
        try {
          const refund = await stripe.refunds.retrieve(refundId);
          refundAmountMap.set(refundId, refund.amount / 100);
        } catch { /* skip */ }
      }),
    ]);
  }

  const settings = await getSettings();
  const graceThreshold = new Date(Date.now() - settings.gracePeriodMinutes * 60 * 1000);

  const allItems: NeedsReviewItem[] = [];

  for (const session of sessions) {
    const { id: sessionId, driver, status, billingStatus, startedAt, expectedEnd, cancellationDisposition } = session;
    const driverName = driver.name;

    // Convenience: build a related object with session + driver pre-filled
    const rel = (extra?: Partial<NeedsReviewItem["related"]>): NeedsReviewItem["related"] => ({
      sessionId,
      driverId: driver.id,
      ...extra,
    });

    const isMonthly = session.payments.some(
      (p) => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL",
    );

    // ── CANCELLED sessions: only one check ─────────────────────────────────
    if (status === "CANCELLED") {
      if (cancellationDisposition !== "N_A") continue;
      for (const p of session.payments) {
        if (p.amount > 0 && p.stripeChargeId && p.status !== "REFUNDED" && p.refunds.length === 0) {
          allItems.push(makeItem(
            "CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE",
            "Cancelled paid session needs refund/retention disposition",
            `Session for ${driverName} was cancelled with a Stripe charge of ${fmt(p.amount)} that has not been refunded. Retention may be intentional — confirm or issue a refund.`,
            "Confirm whether the payment should be refunded, partially refunded, or intentionally retained.",
            "Review cancellation",
            rel({ paymentId: p.id, stripeChargeId: p.stripeChargeId }),
            p.createdAt.toISOString(),
          ));
        }
      }
      continue;
    }

    // ── Session-level checks ────────────────────────────────────────────────

    if (status === "COMPLETED" && session.payments.length === 0) {
      allItems.push(makeItem(
        "COMPLETED_SESSION_WITHOUT_PAYMENT",
        "Completed session has no payment record",
        `Session for ${driverName} was completed but has no associated payments.`,
        "Review the session for a manual payment or data-entry error.",
        "Review session",
        rel(),
        startedAt.toISOString(),
      ));
    }

    if (billingStatus === "PAYMENT_FAILED") {
      allItems.push(makeItem(
        "SUBSCRIPTION_PAYMENT_FAILED",
        "Subscription payment failed",
        `The latest renewal for ${driverName}'s subscription failed — Stripe is retrying.`,
        "Contact the driver to update their payment method before Stripe exhausts retries.",
        "Review subscription",
        rel(),
        startedAt.toISOString(),
      ));
    }

    if (billingStatus === "DELINQUENT") {
      allItems.push(makeItem(
        "SUBSCRIPTION_DELINQUENT",
        "Subscription is delinquent",
        `All Stripe retry attempts have failed for ${driverName}'s subscription. The subscription may have been cancelled.`,
        "Contact the driver immediately and resolve the outstanding balance.",
        "Review subscription",
        rel(),
        startedAt.toISOString(),
      ));
    }

    if (status === "ACTIVE" && expectedEnd < graceThreshold) {
      allItems.push(makeItem(
        "ACTIVE_SESSION_PAST_EXPECTED_END",
        "Active session past expected end",
        `Session for ${driverName} was expected to end on ${fmtDate(expectedEnd)} but is still active — the cron job may not have run.`,
        "Manually trigger the session check cron or close the session via admin.",
        "Review session",
        rel(),
        expectedEnd.toISOString(),
      ));
    }

    // ── Per-payment checks ──────────────────────────────────────────────────

    for (const p of session.payments) {
      const pRel = rel({ paymentId: p.id });

      if (p.amount > 0 && !p.stripeChargeId && !p.stripePaymentIntentId) {
        allItems.push(makeItem(
          "DB_PAYMENT_WITHOUT_STRIPE_CHARGE",
          "Payment missing Stripe charge",
          `A payment of ${fmt(p.amount)} for ${driverName} has no Stripe charge or payment intent — the webhook may have been missed.`,
          "Check the Stripe dashboard for a matching charge and reconcile manually.",
          "Review payment",
          pRel,
          p.createdAt.toISOString(),
        ));
      } else if (p.stripeChargeId && !p.qbSalesReceiptId) {
        allItems.push(makeItem(
          "QB_RECEIPT_MISSING",
          "QuickBooks receipt not synced",
          `A payment of ${fmt(p.amount)} for ${driverName} (Stripe charge …${p.stripeChargeId.slice(-6)}) has no QuickBooks Sales Receipt.`,
          "Sync the QB receipt from the Payments tab or use the action button.",
          "Sync receipt",
          rel({ paymentId: p.id, stripeChargeId: p.stripeChargeId }),
          p.createdAt.toISOString(),
        ));
      }

      if (p.stripeChargeId && chargeAmountMap.has(p.stripeChargeId)) {
        const stripeAmt = chargeAmountMap.get(p.stripeChargeId)!;

        if (Math.abs(p.amount - stripeAmt) > 0.01) {
          allItems.push(makeItem(
            "DB_STRIPE_AMOUNT_MISMATCH",
            "DB payment amount differs from Stripe",
            `DB records ${fmt(p.amount)} but Stripe charge shows ${fmt(stripeAmt)} for ${driverName} — possible webhook bug.`,
            "Verify the correct amount and correct the DB record or issue a Stripe refund.",
            "View details",
            rel({ paymentId: p.id, stripeChargeId: p.stripeChargeId }),
            p.createdAt.toISOString(),
          ));
        }

        if (p.qbSalesReceiptAmount != null && Math.abs(p.qbSalesReceiptAmount - stripeAmt) > 0.01) {
          allItems.push(makeItem(
            "QB_RECEIPT_AMOUNT_MISMATCH",
            "QB receipt amount differs from Stripe",
            `QB Sales Receipt shows ${fmt(p.qbSalesReceiptAmount)} but Stripe charge shows ${fmt(stripeAmt)} for ${driverName}.`,
            "Update the QB receipt to match the Stripe charge amount.",
            "View details",
            rel({ paymentId: p.id, stripeChargeId: p.stripeChargeId, qbReceiptId: p.qbSalesReceiptId ?? undefined }),
            p.createdAt.toISOString(),
          ));
        }
      }

      for (const r of p.refunds) {
        const rRel = rel({ paymentId: p.id, refundId: r.id, stripeRefundId: r.stripeRefundId ?? undefined });

        if (!r.qbRefundReceiptId) {
          allItems.push(makeItem(
            "QB_REFUND_RECEIPT_MISSING",
            "QuickBooks refund receipt not synced",
            `A refund of ${fmt(r.amount)} for ${driverName} has no QuickBooks Refund Receipt.`,
            "Sync the QB refund receipt from the Payments tab or use the action button.",
            "Sync refund receipt",
            rRel,
            r.createdAt.toISOString(),
          ));
        }

        if (r.stripeRefundId && refundAmountMap.has(r.stripeRefundId) && r.qbRefundReceiptAmount != null) {
          const stripeRefundAmt = refundAmountMap.get(r.stripeRefundId)!;
          if (Math.abs(r.qbRefundReceiptAmount - stripeRefundAmt) > 0.01) {
            allItems.push(makeItem(
              "QB_REFUND_AMOUNT_MISMATCH",
              "QB refund receipt amount differs from Stripe",
              `QB Refund Receipt shows ${fmt(r.qbRefundReceiptAmount)} but Stripe refund shows ${fmt(stripeRefundAmt)} for ${driverName}.`,
              "Update the QB refund receipt to match the Stripe refund amount.",
              "View details",
              rel({ paymentId: p.id, refundId: r.id, stripeRefundId: r.stripeRefundId, qbRefundReceiptId: r.qbRefundReceiptId ?? undefined }),
              r.createdAt.toISOString(),
            ));
          }
        }
      }

      if ((p.status === "REFUNDED" || p.status === "PARTIALLY_REFUNDED") && p.refunds.length === 0) {
        allItems.push(makeItem(
          "REFUND_DETAIL_MISSING",
          "Refund status recorded but no detail row",
          `Payment for ${driverName} is marked ${p.status.toLowerCase().replace("_", " ")} but has no refund detail rows — the charge.refunded webhook may have been missed.`,
          "Check Stripe for refund details and create the refund record manually if needed.",
          "Review payment",
          pRel,
          p.createdAt.toISOString(),
        ));
      }
    }

    // ── Monthly subscription: Stripe invoice count vs DB payment count ──────

    if (isMonthly && invoiceCountMap.has(sessionId)) {
      const stripeInvoiceCount = invoiceCountMap.get(sessionId)!;
      const dbPaymentCount = session.payments.filter(
        (p) => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL",
      ).length;

      if (stripeInvoiceCount > dbPaymentCount) {
        const diff = stripeInvoiceCount - dbPaymentCount;
        allItems.push(makeItem(
          "STRIPE_INVOICE_WITHOUT_DB_PAYMENT",
          "Stripe invoice has no matching DB payment",
          `${diff} Stripe invoice${diff > 1 ? "s" : ""} for ${driverName}'s subscription ${diff > 1 ? "have" : "has"} no matching payment row.`,
          "Review the subscription invoice history in Stripe and create missing payment records.",
          "Review subscription",
          rel(),
          startedAt.toISOString(),
        ));
      }
    }
  }

  // severity=warning → all non-ok items (warning + critical); severity=critical → critical only; all → everything
  const filtered =
    severityFilter === "critical"
      ? allItems.filter((i) => i.severity === "critical")
      : allItems;

  // Sort: critical first, then newest occurredAt desc, then stable by id
  filtered.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    const dateDiff = (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "");
    if (dateDiff !== 0) return dateDiff;
    return a.id.localeCompare(b.id);
  });

  const total = filtered.length;
  return json<NeedsReviewResponse>({
    items: filtered.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total,
  });
});
