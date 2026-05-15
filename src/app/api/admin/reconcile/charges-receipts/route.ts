import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { listRecentCharges, listRecentRefunds, stripeConfigured } from "@/lib/stripe";
import { listRecentSalesReceipts, listRecentRefundReceipts, QBAuthError } from "@/lib/quickbooks";
import { findNearbySalesReceiptMatches, type NearbyQbMatch } from "@/lib/qb-nearby-matches";
import { handler, json, conflict } from "@/lib/api-handler";
import type { QBSalesReceiptListItem, QBRefundReceiptListItem } from "@/lib/quickbooks";
import type Stripe from "stripe";

const DEMO_ID_RE = /^demo_[a-z0-9-]+_\d{8}_\d{6}_[a-z0-9]{4}$/i;
const ChargesReceiptsQuery = z.object({
  demoId: z.string().trim().max(80).optional().transform((v) =>
    v && DEMO_ID_RE.test(v) ? v : undefined,
  ),
});

export type ChargeItem = {
  id: string;                  // ch_xxx
  amount: number;              // dollars
  created: string;             // ISO timestamp
  description: string | null;
  status: string;              // "succeeded" | "refunded"
  billingName: string | null;
  metadata: Record<string, string>;
};

export type RefundItem = {
  id: string;        // re_xxx
  chargeId: string;  // parent ch_xxx
  amount: number;    // dollars
  created: string;   // ISO timestamp
};

export type ReceiptItem = {
  id: string;
  docNumber: string;
  txnDate: string;
  totalAmount: number;
  customerName: string | null;
  stripeChargeId: string | null;
};

export type RefundReceiptItem = {
  id: string;
  docNumber: string;
  txnDate: string;
  totalAmount: number;
  customerName: string | null;
  stripeChargeId: string | null;
  stripeRefundId: string | null;
};

export type PaymentRef = {
  id: string;
  type: string;
  sessionId: string;
};

export type MatchedPair = {
  charge: ChargeItem;
  receipt: ReceiptItem;
  payment: PaymentRef | null;
};

export type MatchedRefundPair = {
  refund: RefundItem;
  charge: ChargeItem;          // parent charge for context links
  refundReceipt: RefundReceiptItem;
};

export type OrphanedCharge = {
  charge: ChargeItem;
  payment: PaymentRef | null;
  issue: "no_db_payment" | "no_qb_receipt";
  nearbyQbMatches?: NearbyQbMatch[];
};

export type OrphanedRefund = {
  refund: RefundItem;
  charge: ChargeItem;
};

export type OrphanedReceipt = {
  receipt: ReceiptItem;
  payment: PaymentRef | null;
};

export type OrphanedRefundReceipt = {
  refundReceipt: RefundReceiptItem;
};

export type ChargesReceiptsResponse = {
  matched: MatchedPair[];
  matchedRefunds: MatchedRefundPair[];
  orphanedCharges: OrphanedCharge[];
  orphanedRefunds: OrphanedRefund[];
  orphanedReceipts: OrphanedReceipt[];
  orphanedRefundReceipts: OrphanedRefundReceipt[];
  qbConnected: boolean;
  stripeConfigured: boolean;
  sinceDaysAgo: number;
};

function toChargeItem(c: Stripe.Charge): ChargeItem {
  return {
    id: c.id,
    amount: c.amount / 100,
    created: new Date(c.created * 1000).toISOString(),
    description: c.description ?? null,
    status: c.refunded ? "refunded" : c.status,
    billingName: c.billing_details?.name ?? null,
    metadata: (c.metadata as Record<string, string>) ?? {},
  };
}

function toReceiptItem(r: QBSalesReceiptListItem): ReceiptItem {
  const chargeMatch = r.PrivateNote?.match(/charge:(\w+_\w+)/);
  return {
    id: r.Id,
    docNumber: r.DocNumber,
    txnDate: r.TxnDate,
    totalAmount: r.TotalAmt,
    customerName: r.CustomerRef?.name ?? null,
    stripeChargeId: chargeMatch?.[1] ?? null,
  };
}

function toRefundReceiptItem(r: QBRefundReceiptListItem): RefundReceiptItem {
  const refundMatch = r.PrivateNote?.match(/refund:(\w+_\w+)/);
  const chargeMatch = r.PrivateNote?.match(/charge:(\w+_\w+)/);
  return {
    id: r.Id,
    docNumber: r.DocNumber,
    txnDate: r.TxnDate,
    totalAmount: r.TotalAmt,
    customerName: r.CustomerRef?.name ?? null,
    stripeRefundId: refundMatch?.[1] ?? null,
    stripeChargeId: chargeMatch?.[1] ?? null,
  };
}

const DAYS = 90;

export const GET = handler({ query: ChargesReceiptsQuery }, async ({ query }) => {
  await requireAdmin();

  if (!stripeConfigured()) throw conflict("Stripe is not configured");

  const { demoId } = query;

  const [rawCharges, rawRefunds] = await Promise.all([
    listRecentCharges(DAYS),
    listRecentRefunds(DAYS),
  ]);

  // When demoId is active, limit Stripe data to charges/refunds tagged with that testRunId in metadata.
  const charges = rawCharges
    .filter((c) => c.status === "succeeded")
    .filter((c) => !demoId || (c.metadata as Record<string, string>)?.testRunId === demoId)
    .map(toChargeItem);

  const chargeById = new Map<string, ChargeItem>();
  for (const c of charges) chargeById.set(c.id, c);

  // Use the dedicated refunds list — charges.list() doesn't reliably populate refunds.data.
  const allRefunds: RefundItem[] = rawRefunds
    .filter((r) => r.status === "succeeded" && r.charge)
    .filter((r) => !demoId || (r.metadata as Record<string, string>)?.testRunId === demoId)
    .map((r) => ({
      id: r.id,
      chargeId: typeof r.charge === "string" ? r.charge : r.charge!.id,
      amount: r.amount / 100,
      created: new Date(r.created * 1000).toISOString(),
    }));

  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const dbPayments = await prisma.payment.findMany({
    where: {
      createdAt: { gte: since },
      ...(demoId ? { session: { driver: { email: { contains: demoId } } } } : {}),
    },
    select: {
      id: true,
      type: true,
      sessionId: true,
      amount: true,
      createdAt: true,
      stripeChargeId: true,
      qbSalesReceiptId: true,
      session: { select: { driver: { select: { name: true } } } },
    },
  });

  const dbByChargeId = new Map<string, typeof dbPayments[number]>();
  const dbByReceiptId = new Map<string, typeof dbPayments[number]>();
  const linkedReceiptIds = new Set<string>();
  for (const p of dbPayments) {
    if (p.stripeChargeId) dbByChargeId.set(p.stripeChargeId, p);
    if (p.qbSalesReceiptId) {
      dbByReceiptId.set(p.qbSalesReceiptId, p);
      linkedReceiptIds.add(p.qbSalesReceiptId);
    }
  }

  let qbConnected = false;
  let rawReceipts: QBSalesReceiptListItem[] = [];
  let rawRefundReceipts: QBRefundReceiptListItem[] = [];
  try {
    [rawReceipts, rawRefundReceipts] = await Promise.all([
      listRecentSalesReceipts(DAYS),
      listRecentRefundReceipts(DAYS),
    ]);
    qbConnected = true;
  } catch (err) {
    if (err instanceof QBAuthError) {
      qbConnected = false;
    } else {
      throw conflict(`QB query failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const salesReceiptCandidates = rawReceipts
    .filter((r) => r.TotalAmt > 0)
    .filter((r) => !demoId || r.PrivateNote?.includes(`demo:${demoId}`));
  const receipts = salesReceiptCandidates
    .map(toReceiptItem);
  const refundReceipts = rawRefundReceipts
    .filter((r) => r.TotalAmt > 0)
    .filter((r) => !demoId || r.PrivateNote?.includes(`demo:${demoId}`))
    .map(toRefundReceiptItem);

  // Index sales receipts.
  const receiptById = new Map<string, ReceiptItem>();
  const receiptByChargeId = new Map<string, ReceiptItem>();
  for (const r of receipts) {
    receiptById.set(r.id, r);
    if (r.stripeChargeId) receiptByChargeId.set(r.stripeChargeId, r);
  }

  // Index refund receipts by Stripe refund ID (primary key in PrivateNote).
  const refundReceiptByRefundId = new Map<string, RefundReceiptItem>();
  for (const r of refundReceipts) {
    if (r.stripeRefundId) refundReceiptByRefundId.set(r.stripeRefundId, r);
  }

  // --- Match charges to QB sales receipts ---
  const matched: MatchedPair[] = [];
  const orphanedCharges: OrphanedCharge[] = [];
  const handledReceiptIds = new Set<string>();

  for (const charge of charges) {
    const dbPayment = dbByChargeId.get(charge.id) ?? null;
    const paymentRef: PaymentRef | null = dbPayment
      ? { id: dbPayment.id, type: dbPayment.type, sessionId: dbPayment.sessionId }
      : null;

    let receipt: ReceiptItem | null = null;
    if (dbPayment?.qbSalesReceiptId) {
      receipt = receiptById.get(dbPayment.qbSalesReceiptId) ?? null;
      if (receipt) handledReceiptIds.add(receipt.id);
    }
    if (!receipt) {
      receipt = receiptByChargeId.get(charge.id) ?? null;
      if (receipt) handledReceiptIds.add(receipt.id);
    }

    if (receipt) {
      matched.push({ charge, receipt, payment: paymentRef });
    } else {
      const nearbyQbMatches = dbPayment
        ? findNearbySalesReceiptMatches({
          paymentId: dbPayment.id,
          target: {
            amount: dbPayment.amount,
            createdAt: dbPayment.createdAt,
            driverName: dbPayment.session.driver.name,
          },
          receipts: salesReceiptCandidates,
          linkedReceiptIds,
        })
        : [];
      orphanedCharges.push({
        charge,
        payment: paymentRef,
        issue: dbPayment ? "no_qb_receipt" : "no_db_payment",
        nearbyQbMatches,
      });
    }
  }

  // --- Match Stripe refunds to QB refund receipts ---
  const matchedRefunds: MatchedRefundPair[] = [];
  const orphanedRefunds: OrphanedRefund[] = [];
  const handledRefundReceiptIds = new Set<string>();

  for (const refund of allRefunds) {
    const refundReceipt = refundReceiptByRefundId.get(refund.id) ?? null;
    const charge = chargeById.get(refund.chargeId)!;
    if (refundReceipt) {
      handledRefundReceiptIds.add(refundReceipt.id);
      matchedRefunds.push({ refund, charge, refundReceipt });
    } else {
      orphanedRefunds.push({ refund, charge });
    }
  }

  // Orphaned QB sales receipts (no matching charge).
  const orphanedReceipts: OrphanedReceipt[] = [];
  for (const receipt of receipts) {
    if (handledReceiptIds.has(receipt.id)) continue;
    const dbPayment = dbByReceiptId.get(receipt.id) ?? null;
    orphanedReceipts.push({
      receipt,
      payment: dbPayment ? { id: dbPayment.id, type: dbPayment.type, sessionId: dbPayment.sessionId } : null,
    });
  }

  // Orphaned QB refund receipts (no matching Stripe refund).
  const orphanedRefundReceipts: OrphanedRefundReceipt[] = [];
  for (const rr of refundReceipts) {
    if (handledRefundReceiptIds.has(rr.id)) continue;
    orphanedRefundReceipts.push({ refundReceipt: rr });
  }

  orphanedCharges.sort((a, b) => b.charge.created.localeCompare(a.charge.created));
  orphanedRefunds.sort((a, b) => b.refund.created.localeCompare(a.refund.created));
  orphanedReceipts.sort((a, b) => b.receipt.txnDate.localeCompare(a.receipt.txnDate));
  orphanedRefundReceipts.sort((a, b) => b.refundReceipt.txnDate.localeCompare(a.refundReceipt.txnDate));
  matched.sort((a, b) => b.charge.created.localeCompare(a.charge.created));
  matchedRefunds.sort((a, b) => b.refund.created.localeCompare(a.refund.created));

  return json<ChargesReceiptsResponse>({
    matched,
    matchedRefunds,
    orphanedCharges,
    orphanedRefunds,
    orphanedReceipts,
    orphanedRefundReceipts,
    qbConnected,
    stripeConfigured: true,
    sinceDaysAgo: DAYS,
  });
});
