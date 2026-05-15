import type {
  QBRefundReceiptListItem,
  QBSalesReceiptListItem,
} from "@/lib/quickbooks";

export type NearbyQbMatch = {
  kind: "sales_receipt" | "refund_receipt";
  qbId: string;
  docNumber: string;
  txnDate: string;
  totalAmount: number;
  customerName: string | null;
  score: number;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  amountDelta: number;
  dayDelta: number;
  nameSimilarity: number | null;
  linkActionPath?: string;
  linkActionMethod?: "POST";
  linkActionBody?: Record<string, string>;
};

type MatchTarget = {
  amount: number;
  createdAt: Date;
  driverName: string;
};

function normalizeName(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token));
}

function tokenSimilarity(a: string, b: string | null | undefined): number | null {
  if (!b) return null;
  const left = new Set(normalizeName(a));
  const right = new Set(normalizeName(b));
  if (left.size === 0 || right.size === 0) return null;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

function daysBetween(a: Date, qbTxnDate: string): number {
  const qbDate = new Date(`${qbTxnDate}T00:00:00Z`);
  if (Number.isNaN(qbDate.getTime())) return Number.POSITIVE_INFINITY;
  return Math.abs(a.getTime() - qbDate.getTime()) / 86400000;
}

function confidence(score: number): NearbyQbMatch["confidence"] {
  if (score >= 85) return "high";
  if (score >= 70) return "medium";
  return "low";
}

function scoreCandidate(input: {
  target: MatchTarget;
  qbId: string;
  docNumber: string;
  txnDate: string;
  totalAmount: number;
  customerName: string | null;
  kind: NearbyQbMatch["kind"];
}): NearbyQbMatch | null {
  const amountDelta = Math.abs(input.target.amount - input.totalAmount);
  const amountTolerance = Math.max(2, input.target.amount * 0.1);
  const dayDelta = daysBetween(input.target.createdAt, input.txnDate);
  const nameSimilarity = tokenSimilarity(input.target.driverName, input.customerName);

  let score = 0;
  const reasons: string[] = [];

  if (amountDelta <= 0.01) {
    score += 45;
    reasons.push("amount exact");
  } else if (amountDelta <= amountTolerance) {
    score += Math.max(15, 40 - Math.round((amountDelta / amountTolerance) * 25));
    reasons.push(`amount close (${amountDelta.toFixed(2)} delta)`);
  }

  if (dayDelta <= 1) {
    score += 30;
    reasons.push("date within 1 day");
  } else if (dayDelta <= 7) {
    score += 24;
    reasons.push(`date within ${Math.ceil(dayDelta)} days`);
  } else if (dayDelta <= 14) {
    score += 12;
    reasons.push(`date within ${Math.ceil(dayDelta)} days`);
  }

  if (nameSimilarity == null) {
    score += 8;
    reasons.push("customer name unavailable");
  } else if (nameSimilarity >= 0.8) {
    score += 25;
    reasons.push("customer name strong match");
  } else if (nameSimilarity >= 0.5) {
    score += 16;
    reasons.push("customer name partial match");
  } else if (nameSimilarity >= 0.25) {
    score += 8;
    reasons.push("customer name weak match");
  }

  if (score < 55) return null;

  return {
    kind: input.kind,
    qbId: input.qbId,
    docNumber: input.docNumber,
    txnDate: input.txnDate,
    totalAmount: input.totalAmount,
    customerName: input.customerName,
    score,
    confidence: confidence(score),
    reasons,
    amountDelta,
    dayDelta: Number.isFinite(dayDelta) ? Math.round(dayDelta * 10) / 10 : 9999,
    nameSimilarity: nameSimilarity == null ? null : Math.round(nameSimilarity * 100) / 100,
  };
}

function byScoreDesc(a: NearbyQbMatch, b: NearbyQbMatch): number {
  return b.score - a.score || a.dayDelta - b.dayDelta || a.amountDelta - b.amountDelta;
}

export function findNearbySalesReceiptMatches(args: {
  paymentId: string;
  target: MatchTarget;
  receipts: QBSalesReceiptListItem[];
  linkedReceiptIds: Set<string>;
  limit?: number;
}): NearbyQbMatch[] {
  return args.receipts
    .filter((receipt) => !args.linkedReceiptIds.has(receipt.Id))
    .filter((receipt) => !receipt.PrivateNote?.match(/charge:\w+_\w+/))
    .map((receipt) =>
      scoreCandidate({
        target: args.target,
        qbId: receipt.Id,
        docNumber: receipt.DocNumber,
        txnDate: receipt.TxnDate,
        totalAmount: receipt.TotalAmt,
        customerName: receipt.CustomerRef?.name ?? null,
        kind: "sales_receipt",
      }),
    )
    .filter((match): match is NearbyQbMatch => match != null)
    .sort(byScoreDesc)
    .slice(0, args.limit ?? 3)
    .map((match) => ({
      ...match,
      linkActionPath: `/api/admin/payments/${args.paymentId}/link-qb-receipt`,
      linkActionMethod: "POST",
      linkActionBody: { qbSalesReceiptId: match.qbId },
    }));
}

export function findNearbyRefundReceiptMatches(args: {
  paymentId: string;
  refundId: string;
  target: MatchTarget;
  refundReceipts: QBRefundReceiptListItem[];
  linkedRefundReceiptIds: Set<string>;
  limit?: number;
}): NearbyQbMatch[] {
  return args.refundReceipts
    .filter((receipt) => !args.linkedRefundReceiptIds.has(receipt.Id))
    .filter((receipt) => !receipt.PrivateNote?.match(/refund:\w+_\w+/))
    .map((receipt) =>
      scoreCandidate({
        target: args.target,
        qbId: receipt.Id,
        docNumber: receipt.DocNumber,
        txnDate: receipt.TxnDate,
        totalAmount: receipt.TotalAmt,
        customerName: receipt.CustomerRef?.name ?? null,
        kind: "refund_receipt",
      }),
    )
    .filter((match): match is NearbyQbMatch => match != null)
    .sort(byScoreDesc)
    .slice(0, args.limit ?? 3)
    .map((match) => ({
      ...match,
      linkActionPath: `/api/admin/payments/${args.paymentId}/link-qb-refund-receipt`,
      linkActionMethod: "POST",
      linkActionBody: { refundId: args.refundId, qbRefundReceiptId: match.qbId },
    }));
}
