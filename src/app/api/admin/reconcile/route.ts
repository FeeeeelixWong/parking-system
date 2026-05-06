import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getStripe, stripeConfigured } from "@/lib/stripe";
import { handler, json } from "@/lib/api-handler";
import { getSettings } from "@/lib/settings";
import { RECONCILE_ISSUE_DEFINITIONS, type NeedsReviewCode } from "@/types/reconcile";

type ReconcileHealth = "ok" | "warning" | "critical";

type ReconcileRefundRow = {
  id: string;
  amount: number;
  stripeRefundId: string | null;
  qbRefundReceiptId: string | null;
  createdAt: string;
};

type ReconcilePaymentRow = {
  id: string;
  type: string;
  status: string;
  amount: number;
  days: number | null;
  createdAt: string;
  stripeChargeId: string | null;
  stripePaymentIntentId: string | null;
  stripeSubscriptionId: string | null;
  qbSalesReceiptId: string | null;
  refunds: ReconcileRefundRow[];
};

export type ReconcileSessionRow = {
  id: string;
  health: ReconcileHealth;
  issueCodes: NeedsReviewCode[];
  issues: string[];
  sessionType: "MONTHLY" | "DAILY";
  driver: { id: string; name: string };
  vehicle: { licensePlate: string | null; type: string } | null;
  spot: { label: string } | null;
  status: string;
  startedAt: string;
  billingStatus: string;
  payments: ReconcilePaymentRow[];
  stripeInvoiceCount?: number;
  dbPaymentCount?: number;
};

type ReconcileResponse = {
  sessions: ReconcileSessionRow[];
  total: number;
  hasMore: boolean;
};

function worstHealth(a: ReconcileHealth, b: ReconcileHealth): ReconcileHealth {
  if (a === "critical" || b === "critical") return "critical";
  if (a === "warning" || b === "warning") return "warning";
  return "ok";
}

function fmt(amount: number) {
  return `$${amount.toFixed(2)}`;
}

export const GET = handler({}, async ({ req }) => {
  await requireAdmin();

  const url = new URL(req.url);
  const healthFilter = (url.searchParams.get("health") ?? "all") as "all" | "warning" | "critical";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "30", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const sessions = await prisma.session.findMany({
    where: { createdAt: { gte: ninetyDaysAgo } },
    orderBy: { createdAt: "desc" },
    include: {
      driver: { select: { id: true, name: true } },
      vehicle: { select: { licensePlate: true, type: true } },
      spot: { select: { label: true } },
      payments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          type: true,
          amount: true,
          days: true,
          createdAt: true,
          status: true,
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

  // For monthly sessions with a subscription, fetch Stripe invoice counts in parallel.
  // Only fetch if Stripe is configured; otherwise skip and omit the check.
  const stripeOk = stripeConfigured();
  const stripe = stripeOk ? getStripe() : null;

  // ── Collect unique charge/refund IDs for amount-mismatch checks ──────────
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

  // Stripe amounts are in cents; we store dollars. Build lookup maps.
  const chargeAmountMap = new Map<string, number>(); // chargeId → dollars
  const refundAmountMap = new Map<string, number>();  // refundId → dollars

  const invoiceCountMap = new Map<string, number>();

  if (stripe) {
    const monthlySessionsWithSub = sessions.filter(
      (s) => s.payments.some((p) => p.stripeSubscriptionId),
    );

    await Promise.all([
      // Invoice count fetches (existing)
      ...monthlySessionsWithSub.map(async (s) => {
        const subId = s.payments.find((p) => p.stripeSubscriptionId)?.stripeSubscriptionId;
        if (!subId) return;
        try {
          const invoices = await stripe.invoices.list({ subscription: subId, limit: 100 });
          const paidCount = invoices.data.filter((inv) => inv.status === "paid").length;
          invoiceCountMap.set(s.id, paidCount);
        } catch {
          // If Stripe call fails, omit the check gracefully.
        }
      }),

      // Charge amount fetches (new)
      ...[...allChargeIds].map(async (chargeId) => {
        try {
          const charge = await stripe.charges.retrieve(chargeId);
          chargeAmountMap.set(chargeId, charge.amount / 100);
        } catch {
          // Stripe call failed — skip amount checks for this charge.
        }
      }),

      // Refund amount fetches (new)
      ...[...allRefundIds].map(async (refundId) => {
        try {
          const refund = await stripe.refunds.retrieve(refundId);
          refundAmountMap.set(refundId, refund.amount / 100);
        } catch {
          // Stripe call failed — skip amount checks for this refund.
        }
      }),
    ]);
  }

  const settings = await getSettings();
  const rows: ReconcileSessionRow[] = [];

  for (const session of sessions) {
    const isMonthly = session.payments.some(
      (p) => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL",
    );

    const issues: string[] = [];
    const issueCodes: NeedsReviewCode[] = [];
    let stripeInvoiceCount: number | undefined;
    let dbPaymentCount: number | undefined;
    const addIssue = (code: NeedsReviewCode, message: string) => {
      issueCodes.push(code);
      issues.push(message);
    };

    if (session.status === "CANCELLED") {
      // CANCELLED sessions: only flag if money was taken but no refund exists
      for (const p of session.payments) {
        if (p.amount > 0 && p.stripeChargeId && p.status !== "REFUNDED" && p.refunds.length === 0) {
          // TODO: once Session.cancellationDisposition is added, suppress this when
          //       disposition is a terminal value (e.g. "retained", "refunded_externally").
          addIssue("CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE", "Cancelled paid session needs refund/retention disposition");
        }
      }
    } else {
      // Check 1: zero payments on a completed session
      if (session.status === "COMPLETED" && session.payments.length === 0) {
        addIssue("COMPLETED_SESSION_WITHOUT_PAYMENT", "No payments recorded");
      }

      // Check: subscription billing failure
      if (session.billingStatus === "PAYMENT_FAILED") {
        addIssue("SUBSCRIPTION_PAYMENT_FAILED", "Subscription payment failed — renewal overdue");
      }
      if (session.billingStatus === "DELINQUENT") {
        addIssue("SUBSCRIPTION_DELINQUENT", "Subscription delinquent — multiple payment failures");
      }

      // Check: ACTIVE session past expectedEnd + grace window (cron may not have run)
      const graceMs = settings.gracePeriodMinutes * 60 * 1000;
      const graceThreshold = new Date(Date.now() - graceMs);
      if (session.status === "ACTIVE" && session.expectedEnd < graceThreshold) {
        addIssue("ACTIVE_SESSION_PAST_EXPECTED_END", "Session is past expectedEnd but still ACTIVE — cron may not have run");
      }

      // Check 2: per-payment integrity
      for (const p of session.payments) {
        if (p.amount > 0 && !p.stripeChargeId && !p.stripePaymentIntentId) {
          addIssue("DB_PAYMENT_WITHOUT_STRIPE_CHARGE", "No Stripe charge recorded — webhook may have been missed");
        } else if (p.stripeChargeId && !p.qbSalesReceiptId) {
          addIssue("QB_RECEIPT_MISSING", "QB Sales Receipt missing");
        }

        // Amount-mismatch checks (only when we have live Stripe data)
        if (p.stripeChargeId && chargeAmountMap.has(p.stripeChargeId)) {
          const stripeAmt = chargeAmountMap.get(p.stripeChargeId)!;

          // Check 2a: DB payment amount vs Stripe charge amount
          if (Math.abs(p.amount - stripeAmt) > 0.01) {
            addIssue(
              "DB_STRIPE_AMOUNT_MISMATCH",
              `DB amount (${fmt(p.amount)}) differs from Stripe charge (${fmt(stripeAmt)}) — possible webhook bug`,
            );
          }

          // Check 2b: QB Sales Receipt amount vs Stripe charge amount
          if (p.qbSalesReceiptAmount != null && Math.abs(p.qbSalesReceiptAmount - stripeAmt) > 0.01) {
            addIssue(
              "QB_RECEIPT_AMOUNT_MISMATCH",
              `QB Sales Receipt amount (${fmt(p.qbSalesReceiptAmount)}) differs from Stripe charge (${fmt(stripeAmt)})`,
            );
          }
        }

        for (const r of p.refunds) {
          if (!r.qbRefundReceiptId) {
            addIssue("QB_REFUND_RECEIPT_MISSING", "QB Refund Receipt missing");
          }

          // Check 2c: QB Refund Receipt amount vs Stripe refund amount
          if (r.stripeRefundId && refundAmountMap.has(r.stripeRefundId) && r.qbRefundReceiptAmount != null) {
            const stripeRefundAmt = refundAmountMap.get(r.stripeRefundId)!;
            if (Math.abs(r.qbRefundReceiptAmount - stripeRefundAmt) > 0.01) {
              addIssue(
                "QB_REFUND_AMOUNT_MISMATCH",
                `QB Refund Receipt amount (${fmt(r.qbRefundReceiptAmount)}) differs from Stripe refund (${fmt(stripeRefundAmt)})`,
              );
            }
          }
        }

        if ((p.status === "REFUNDED" || p.status === "PARTIALLY_REFUNDED") && p.refunds.length === 0) {
          addIssue("REFUND_DETAIL_MISSING", "Refund recorded on payment but no refund detail row — charge.refunded webhook may have been missed");
        }
      }

      // Check 3: monthly — Stripe invoice count vs DB payment count
      if (isMonthly) {
        const monthlyPayments = session.payments.filter(
          (p) => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL",
        );
        dbPaymentCount = monthlyPayments.length;

        if (invoiceCountMap.has(session.id)) {
          stripeInvoiceCount = invoiceCountMap.get(session.id);
          if (stripeInvoiceCount !== undefined && stripeInvoiceCount > dbPaymentCount) {
            const diff = stripeInvoiceCount - dbPaymentCount;
            addIssue(
              "STRIPE_INVOICE_WITHOUT_DB_PAYMENT",
              `${diff} Stripe invoice${diff > 1 ? "s" : ""} ha${diff > 1 ? "ve" : "s"} no matching payment row`,
            );
          }
        }
      }
    }

    const health = issueCodes.reduce<ReconcileHealth>(
      (acc, code) => worstHealth(acc, RECONCILE_ISSUE_DEFINITIONS[code].severity),
      "ok",
    );

    // Apply filter
    if (healthFilter === "warning" && health === "ok") continue;
    if (healthFilter === "critical" && health !== "critical") continue;

    const row: ReconcileSessionRow = {
      id: session.id,
      health,
      issueCodes: Array.from(new Set(issueCodes)),
      issues: Array.from(new Set(issues)), // deduplicate
      sessionType: isMonthly ? "MONTHLY" : "DAILY",
      driver: session.driver,
      vehicle: session.vehicle
        ? { licensePlate: session.vehicle.licensePlate, type: session.vehicle.type }
        : null,
      spot: session.spot ? { label: session.spot.label } : null,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
      billingStatus: session.billingStatus,
      payments: session.payments.map((p) => ({
        id: p.id,
        type: p.type,
        status: p.status,
        amount: p.amount,
        days: p.days,
        createdAt: p.createdAt.toISOString(),
        stripeChargeId: p.stripeChargeId,
        stripePaymentIntentId: p.stripePaymentIntentId,
        stripeSubscriptionId: p.stripeSubscriptionId,
        qbSalesReceiptId: p.qbSalesReceiptId,
        refunds: p.refunds.map((r) => ({
          id: r.id,
          amount: r.amount,
          stripeRefundId: r.stripeRefundId,
          qbRefundReceiptId: r.qbRefundReceiptId,
          createdAt: r.createdAt.toISOString(),
        })),
      })),
      ...(isMonthly ? { stripeInvoiceCount, dbPaymentCount } : {}),
    };

    rows.push(row);
  }

  const total = rows.length;
  const paginated = rows.slice(offset, offset + limit);

  return json<ReconcileResponse>({
    sessions: paginated,
    total,
    hasMore: offset + limit < total,
  });
});
