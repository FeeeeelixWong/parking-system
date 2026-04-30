// ---------------------------------------------------------------------------
// Shared constants and helpers used across admin sub-components.
// Import from here — never from page.tsx (circular dependency risk).
// ---------------------------------------------------------------------------

// Use sandbox QB dashboard links in dev/test; production links in prod.
const QB_BASE = process.env.NODE_ENV !== "production"
  ? "https://app.sandbox.qbo.intuit.com"
  : "https://app.qbo.intuit.com";

export const qbLinks = {
  invoice:      (id: string) => `${QB_BASE}/app/invoice?txnId=${id}`,
  payment:      (id: string) => `${QB_BASE}/app/recvpayment?txnId=${id}`,
  salesReceipt: (id: string) => `${QB_BASE}/app/salesreceipt?txnId=${id}`,
  customer:     (id: string) => `${QB_BASE}/app/customerdetail?nameId=${id}`,
  refundReceipt:(id: string) => `${QB_BASE}/app/refundreceipt?txnId=${id}`,
  creditMemo:   (customerId: string) => `${QB_BASE}/app/creditmemo/create?customerId=${customerId}`,
  dashboard:    () => `${QB_BASE}/app/homepage`,
};

const STRIPE_DASHBOARD = "https://dashboard.stripe.com";
export const stripeLinks = {
  paymentIntent: (id: string) => `${STRIPE_DASHBOARD}/payments/${id}`,
  charge:        (id: string) => `${STRIPE_DASHBOARD}/payments/${id}`,
  customer:      (id: string) => `${STRIPE_DASHBOARD}/customers/${id}`,
  subscription:  (id: string) => `${STRIPE_DASHBOARD}/subscriptions/${id}`,
  refund:        (id: string) => `${STRIPE_DASHBOARD}/refunds/${id}`,
};

export type PaymentRowRefs = {
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  stripeSubscriptionId: string | null;
  legacyQbReference: string | null;
};

export function isRealPayment(p: PaymentRowRefs): boolean {
  if (p.stripePaymentIntentId || p.stripeChargeId || p.stripeSubscriptionId) return true;
  const legacy = p.legacyQbReference;
  return !!(legacy && !legacy.startsWith("free_") && !legacy.startsWith("dev_seed_"));
}

export function stripeDashboardUrl(p: PaymentRowRefs, testMode = false): string | null {
  const base = testMode ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
  if (p.stripePaymentIntentId) return `${base}/payments/${p.stripePaymentIntentId}`;
  if (p.stripeChargeId)        return `${base}/payments/${p.stripeChargeId}`;
  if (p.stripeSubscriptionId)  return `${base}/subscriptions/${p.stripeSubscriptionId}`;
  return null;
}

// ---------------------------------------------------------------------------
// Shared inline style constants — light theme
// ---------------------------------------------------------------------------
export const DARK_BG  = "#F2F2F7";
export const CARD_BG  = "#FFFFFF";
export const BORDER   = "#E5E5EA";
export const FG       = "#1C1C1E";
export const FG_MUTED = "#636366";
export const FG_DIM   = "#8E8E93";
export const ACCENT   = "#2D7A4A";
export const RADIUS   = 12;

export const chip = (active: boolean, mobile: boolean): React.CSSProperties => ({
  padding: mobile ? "10px 16px" : "6px 14px", borderRadius: 20,
  border: active ? "1px solid transparent" : `1px solid ${BORDER}`,
  background: active ? BORDER : "transparent",
  color: active ? FG : FG_MUTED,
  fontSize: mobile ? 13 : 12, fontWeight: 600,
  cursor: "pointer", letterSpacing: "0.02em",
});

export const inputStyle: React.CSSProperties = {
  padding: "10px 12px", fontSize: 14, background: CARD_BG, border: `1px solid ${BORDER}`,
  borderRadius: 6, color: FG, outline: "none", width: "100%",
};

export const paginationBtn = (disabled: boolean, mobile: boolean): React.CSSProperties => ({
  padding: mobile ? "10px 18px" : "6px 16px", borderRadius: 6, border: `1px solid ${BORDER}`,
  background: disabled ? "transparent" : CARD_BG,
  color: disabled ? "#AEAEB2" : FG,
  fontSize: mobile ? 13 : 12, fontWeight: 600, cursor: disabled ? "default" : "pointer",
});

/** Returns "Monthly (X/N)" progress label for a monthly payment within its session's billing cycle. */
export function monthlyLabel(
  allPayments: { id: string; type: string; createdAt: string }[],
  currentId: string,
): string {
  const monthly = allPayments
    .filter(p => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const idx = monthly.findIndex(p => p.id === currentId);
  if (idx < 0) return "Monthly";
  return `Monthly (${idx + 1} of ${monthly.length})`;
}
