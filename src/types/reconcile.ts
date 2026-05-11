export type NeedsReviewSeverity = "warning" | "critical";

export type NeedsReviewCode =
  | "COMPLETED_SESSION_WITHOUT_PAYMENT"
  | "DB_PAYMENT_WITHOUT_STRIPE_CHARGE"
  | "QB_RECEIPT_MISSING"
  | "DB_STRIPE_AMOUNT_MISMATCH"
  | "QB_RECEIPT_AMOUNT_MISMATCH"
  | "QB_REFUND_RECEIPT_MISSING"
  | "QB_REFUND_AMOUNT_MISMATCH"
  | "REFUND_DETAIL_MISSING"
  | "STRIPE_INVOICE_WITHOUT_DB_PAYMENT"
  | "SUBSCRIPTION_PAYMENT_FAILED"
  | "SUBSCRIPTION_DELINQUENT"
  | "SUBSCRIPTION_DELETION_UNKNOWN"
  | "ACTIVE_SESSION_PAST_EXPECTED_END"
  | "CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE";

export const RECONCILE_ISSUE_DEFINITIONS = {
  COMPLETED_SESSION_WITHOUT_PAYMENT: { severity: "critical" },
  DB_PAYMENT_WITHOUT_STRIPE_CHARGE: { severity: "critical" },
  QB_RECEIPT_MISSING: { severity: "warning" },
  DB_STRIPE_AMOUNT_MISMATCH: { severity: "critical" },
  QB_RECEIPT_AMOUNT_MISMATCH: { severity: "warning" },
  QB_REFUND_RECEIPT_MISSING: { severity: "warning" },
  QB_REFUND_AMOUNT_MISMATCH: { severity: "warning" },
  REFUND_DETAIL_MISSING: { severity: "warning" },
  STRIPE_INVOICE_WITHOUT_DB_PAYMENT: { severity: "warning" },
  SUBSCRIPTION_PAYMENT_FAILED: { severity: "warning" },
  SUBSCRIPTION_DELINQUENT: { severity: "critical" },
  SUBSCRIPTION_DELETION_UNKNOWN: { severity: "critical" },
  ACTIVE_SESSION_PAST_EXPECTED_END: { severity: "warning" },
  CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE: { severity: "warning" },
} as const satisfies Record<NeedsReviewCode, { severity: NeedsReviewSeverity }>;

export type NeedsReviewItem = {
  id: string;
  code: NeedsReviewCode;
  severity: NeedsReviewSeverity;
  title: string;
  detail: string;
  recommendedAction: string;
  actionLabel?: string;
  actionHref?: string;
  related: {
    sessionId?: string;
    paymentId?: string;
    refundId?: string;
    driverId?: string;
    stripeChargeId?: string;
    stripeRefundId?: string;
    qbReceiptId?: string;
    qbRefundReceiptId?: string;
  };
  occurredAt?: string;
};

export type NeedsReviewResponse = {
  items: NeedsReviewItem[];
  total: number;
  hasMore: boolean;
};
