"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ApiPaymentWithSession } from "@/types/domain";
import type { PendingPaymentItem } from "@/app/api/admin/payments/pending/route";
import {
  CARD_BG, BORDER, FG, FG_MUTED, FG_DIM,
  chip, inputStyle, paginationBtn,
  qbLinks, isRealPayment, stripeDashboardUrl,
  monthlyLabel,
} from "./_shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type PaymentRow = ApiPaymentWithSession;
type PaymentSummary = {
  totalRevenue: number;
  checkinRevenue: number;
  monthlyRevenue: number;
  extensionRevenue: number;
  overstayRevenue: number;
  transactionCount: number;
};
type QBPaymentRecord = { id: string; date: string; amount: number; customerName: string; memo: string; method: string };
type StripeRefundRow = { id: string; amount: number; createdAt: string; status: string | null; reason: string | null };
type DbRefundRow = { stripeRefundId: string; qbRefundReceiptId: string | null };

// ---------------------------------------------------------------------------
// TransactionDetailsPopup
// ---------------------------------------------------------------------------
function TransactionDetailsPopup({ payment, siblingPayments, onClose, stripeTestMode }: { payment: PaymentRow; siblingPayments: PaymentRow[]; onClose: () => void; stripeTestMode: boolean }) {
  const stripeBase = stripeTestMode ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";

  const [stripeRefunds, setStripeRefunds] = useState<StripeRefundRow[]>([]);
  const [dbRefunds, setDbRefunds] = useState<DbRefundRow[]>(payment.refunds.map(r => ({ stripeRefundId: r.stripeRefundId, qbRefundReceiptId: r.qbRefundReceiptId })));
  const [loadingRefunds, setLoadingRefunds] = useState(!!payment.stripeChargeId);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [qbSalesReceiptId, setQbSalesReceiptId] = useState<string | null>(payment.qbSalesReceiptId);

  const fetchRefunds = () => {
    if (!payment.stripePaymentIntentId && !payment.stripeChargeId) return;
    fetch(`/api/admin/payments/${payment.id}/stripe-charges`)
      .then(r => r.json())
      .then(data => {
        setStripeRefunds(data.stripeRefunds ?? []);
        setDbRefunds(data.dbRefunds ?? []);
      })
      .catch(() => {
        setStripeRefunds(payment.refunds.map(r => ({ id: r.stripeRefundId, amount: r.amount, createdAt: r.createdAt, status: null, reason: null })));
      })
      .finally(() => setLoadingRefunds(false));
  };

  useEffect(() => {
    fetchRefunds();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment.id, payment.stripeChargeId]);

  const syncToQB = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const [receiptData, refundsData] = await Promise.all([
        fetch(`/api/admin/payments/${payment.id}/sync-receipt`, { method: "POST" }).then(r => r.json()),
        fetch(`/api/admin/payments/${payment.id}/sync-refunds`, { method: "POST" }).then(r => r.json()),
      ]);
      if (receiptData.ok) setQbSalesReceiptId(receiptData.qbSalesReceiptId);
      if (refundsData.ok) fetchRefunds();
      const errors = [
        !receiptData.ok ? (receiptData.error ?? "Receipt sync failed") : null,
        !refundsData.ok ? (refundsData.error ?? "Refund sync failed") : null,
      ].filter(Boolean);
      if (errors.length) {
        setSyncMsg(errors.join(" · "));
      } else {
        const parts = [
          !receiptData.alreadySynced ? "Receipt written" : null,
          (refundsData.refundedAmount ?? 0) > 0 ? `Refunds: $${(refundsData.refundedAmount as number).toFixed(2)}` : null,
        ].filter(Boolean);
        setSyncMsg(parts.length ? parts.join(" · ") : "Already up to date");
      }
    } catch {
      setSyncMsg("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const isStripePayment = !!(payment.stripeChargeId || payment.stripePaymentIntentId || payment.stripeSubscriptionId);
  const paymentMissingQb = isStripePayment && !qbSalesReceiptId;

  const monthlyPayments = siblingPayments
    .filter(p => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const isMonthly = payment.type === "MONTHLY_CHECKIN" || payment.type === "MONTHLY_RENEWAL";
  const monthlyTotal = monthlyPayments.length;
  const monthlyIndex = isMonthly ? monthlyPayments.findIndex(p => p.id === payment.id) : -1;

  const baseTypeLabel: Record<string, string> = {
    CHECKIN: "Daily",
    EXTENSION: "Extension",
    OVERSTAY: "Overstay",
  };

  const typeLabel = isMonthly && monthlyIndex >= 0
    ? monthlyLabel(siblingPayments, payment.id)
    : (baseTypeLabel[payment.type] ?? payment.type);

  const sessionStatus = payment.session?.status;
  const spotLabel = payment.session?.spot?.label ?? null;

  const truncId = (id: string) => id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
  const stripeLabel = (id: string) => {
    if (id.startsWith("ch_"))  return "View Charge ↗";
    if (id.startsWith("re_"))  return "View Refund ↗";
    if (id.startsWith("in_"))  return "View Invoice ↗";
    if (id.startsWith("sub_")) return "View Subscription ↗";
    return "View Payment ↗";
  };
  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  };

  const thStyle: React.CSSProperties = { textAlign: "left", fontSize: 11, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, padding: "0 12px 10px 0", borderBottom: "1px solid #E5E7EB" };
  const tdStyle: React.CSSProperties = { padding: "10px 12px 10px 0", verticalAlign: "top", fontSize: 13, color: "#111827", borderBottom: "1px solid #F3F4F6" };
  const tdLast: React.CSSProperties = { ...tdStyle, borderBottom: "none" };

  const hasRows = stripeRefunds.length > 0;

  // suppress unused vars
  void monthlyTotal;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "#FFFFFF", borderRadius: 12, boxShadow: "0 20px 60px rgba(0,0,0,0.25)", padding: "24px 28px", width: "min(95vw, 720px)", maxHeight: "90vh", overflowY: "auto", position: "relative" }}
      >
        <button
          onClick={onClose}
          style={{ position: "absolute", top: 14, right: 16, background: "none", border: "none", color: "#9CA3AF", fontSize: 22, cursor: "pointer", lineHeight: 1, padding: 4 }}
        >×</button>

        <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", marginBottom: 2 }}>Transaction Details</div>
        <div style={{ fontSize: 12, color: "#6B7280", marginBottom: payment.stripeSubscriptionId ? 10 : 20 }}>
          {payment.session?.driver?.name ?? "Unknown driver"}
          {spotLabel ? ` · Spot ${spotLabel}` : ""}
        </div>

        {payment.stripeSubscriptionId && (
          <div style={{ marginBottom: 16 }}>
            <a
              href={`${stripeBase}/subscriptions/${payment.stripeSubscriptionId}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, color: "#6366F1", textDecoration: "none", fontWeight: 600 }}
            >
              View subscription in Stripe ↗
            </a>
          </div>
        )}

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>Date & Time</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Stripe</th>
              <th style={thStyle}>QuickBooks</th>
            </tr>
          </thead>
          <tbody>
            {/* Payment row */}
            <tr>
              <td style={hasRows ? tdStyle : tdLast}>
                {fmtDate(payment.createdAt)}
              </td>
              <td style={{ ...(hasRows ? tdStyle : tdLast), textAlign: "right", fontWeight: 600, color: "#059669" }}>
                +${payment.amount.toFixed(2)}
                {payment.days ? <div style={{ fontSize: 11, fontWeight: 400, color: "#6B7280" }}>{payment.days}d</div> : null}
              </td>
              <td style={hasRows ? tdStyle : tdLast}>
                {typeLabel}
              </td>
              <td style={hasRows ? tdStyle : tdLast}>
                {payment.stripePaymentIntentId && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <a href={`${stripeBase}/payments/${payment.stripePaymentIntentId}`} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 11, color: "#6366F1", textDecoration: "none" }}>
                      {stripeLabel(payment.stripePaymentIntentId)}
                    </a>
                    <span style={{ fontSize: 10, color: "#9CA3AF", fontFamily: "monospace" }}>{truncId(payment.stripePaymentIntentId)}</span>
                  </div>
                )}
                {payment.legacyQbReference && !payment.stripePaymentIntentId && (
                  <span style={{ fontSize: 11, color: "#9CA3AF", fontFamily: "monospace" }}>{payment.legacyQbReference}</span>
                )}
                {!payment.stripePaymentIntentId && !payment.legacyQbReference && (
                  <span style={{ fontSize: 11, color: "#9CA3AF" }}>—</span>
                )}
              </td>
              <td style={hasRows ? tdStyle : tdLast}>
                {qbSalesReceiptId ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <a href={qbLinks.salesReceipt(qbSalesReceiptId)} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 11, color: "#16A34A", textDecoration: "none", fontFamily: "monospace" }}>
                      View Receipt ↗
                    </a>
                    <span style={{ fontSize: 10, color: "#9CA3AF", fontFamily: "monospace" }}>#{qbSalesReceiptId}</span>
                  </div>
                ) : paymentMissingQb ? (
                  <span style={{ fontSize: 11, color: "#DC2626", fontWeight: 500 }}>⚠ No receipt</span>
                ) : (
                  <span style={{ fontSize: 11, color: "#9CA3AF" }}>—</span>
                )}
              </td>
            </tr>

            {/* Refund rows — sourced from Stripe live fetch */}
            {loadingRefunds ? (
              <tr>
                <td colSpan={5} style={{ ...tdLast, color: "#9CA3AF", fontSize: 12, paddingTop: 12 }}>
                  Loading refunds from Stripe…
                </td>
              </tr>
            ) : [...stripeRefunds].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map((r, i) => {
              const isLast = i === stripeRefunds.length - 1;
              const db = dbRefunds.find(d => d.stripeRefundId === r.id);
              const qbRefundReceiptId = db?.qbRefundReceiptId ?? null;
              return (
                <tr key={r.id}>
                  <td style={isLast ? tdLast : tdStyle}>
                    {fmtDate(r.createdAt)}
                  </td>
                  <td style={{ ...(isLast ? tdLast : tdStyle), textAlign: "right", fontWeight: 600, color: "#DC2626" }}>
                    −${r.amount.toFixed(2)}
                  </td>
                  <td style={isLast ? tdLast : tdStyle}>
                    Refund
                  </td>
                  <td style={isLast ? tdLast : tdStyle}>
                    {payment.stripePaymentIntentId ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <a href={`${stripeBase}/payments/${payment.stripePaymentIntentId}`} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 11, color: "#6366F1", textDecoration: "none" }}>
                          {stripeLabel(r.id)}
                        </a>
                        <span style={{ fontSize: 10, color: "#9CA3AF", fontFamily: "monospace" }}>{truncId(r.id)}</span>
                      </div>
                    ) : (
                      <span style={{ fontSize: 11, color: "#9CA3AF" }}>—</span>
                    )}
                    {r.status && r.status !== "succeeded" && (
                      <div style={{ fontSize: 11, color: "#F59E0B" }}>{r.status}</div>
                    )}
                  </td>
                  <td style={isLast ? tdLast : tdStyle}>
                    {qbRefundReceiptId ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <a href={qbLinks.refundReceipt(qbRefundReceiptId)} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 11, color: "#16A34A", textDecoration: "none", fontFamily: "monospace" }}>
                          View Receipt ↗
                        </a>
                        <span style={{ fontSize: 10, color: "#9CA3AF", fontFamily: "monospace" }}>#{qbRefundReceiptId}</span>
                      </div>
                    ) : (
                      <span style={{ fontSize: 11, color: "#DC2626", fontWeight: 500 }}>⚠ No receipt</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Current status footer */}
        <div style={{ marginTop: 16, padding: "10px 14px", background: "#F9FAFB", borderRadius: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#6B7280" }}>Current status:</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#111827", flex: 1 }}>
            {sessionStatus === "ACTIVE" ? "Active" : sessionStatus === "OVERSTAY" ? "Overstay" : sessionStatus === "COMPLETED" ? "Completed" : sessionStatus === "CANCELLED" ? "Cancelled" : (sessionStatus ?? "—")}
            {spotLabel ? ` · Spot ${spotLabel}` : ""}
          </span>
          {isStripePayment && (() => {
            const allSynced = !!qbSalesReceiptId && dbRefunds.every(r => r.qbRefundReceiptId);
            return (
              <button
                onClick={syncToQB}
                disabled={syncing || allSynced}
                title={allSynced ? "All receipts already generated" : undefined}
                style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: `1px solid ${allSynced ? "#E5E7EB" : "#D1FAE5"}`, background: allSynced ? "#F9FAFB" : "#ECFDF5", color: allSynced ? "#9CA3AF" : "#065F46", cursor: (syncing || allSynced) ? "default" : "pointer", opacity: syncing ? 0.6 : 1 }}
              >
                {syncing ? "Syncing…" : "Generate Receipts"}
              </button>
            );
          })()}
          {syncMsg && <span style={{ fontSize: 11, color: syncMsg.startsWith("Sync failed") || syncMsg.includes("failed") ? "#DC2626" : "#16A34A" }}>{syncMsg}</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaymentsTab
// ---------------------------------------------------------------------------
export default function PaymentsTab({ mobile, initialSearch = "" }: { mobile: boolean; initialSearch?: string }) {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [summary, setSummary] = useState<PaymentSummary | null>(null);
  const [dailyRevenue, setDailyRevenue] = useState<{ date: string; amount: number }[]>([]);
  const [divergentCount, setDivergentCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState(initialSearch);
  const [loading, setLoading] = useState(true);
  const [selectedPayment, setSelectedPayment] = useState<PaymentRow | null>(null);

  const skipPaymentsSync = useRef(false);
  const [stripeTestMode, setStripeTestMode] = useState(false);
  const LIMIT = 30;

  // Past-due / failed subscription invoices
  const [pendingItems, setPendingItems] = useState<PendingPaymentItem[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [expandedPending, setExpandedPending] = useState<Set<string>>(new Set());

  // Stripe reconciliation (read-only divergence check — never mutates DB)
  const [qbConnected, setQbConnected] = useState(false);
  const [qbLoading, setQbLoading] = useState(true);
  const [lastStripeWebhookAt, setLastStripeWebhookAt] = useState<string | null>(null);
  const [flaggedStripeIds, setFlaggedStripeIds] = useState<string[]>([]);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    stripeChargesChecked: number;
    dbPaymentsChecked: number;
    inStripeNotDb: string[];
    inDbNotStripe: string[];
    flaggedCount: number;
  } | null>(null);

  const syncWithQB = useCallback(() => {
    setSyncing(true);
    setSyncResult(null);
    fetch("/api/admin/reconcile/stripe-db", { method: "POST" })
      .then((r) => r.json())
      .then((d) => setSyncResult(d))
      .catch(() => setSyncResult({
        stripeChargesChecked: 0,
        dbPaymentsChecked: 0,
        inStripeNotDb: [],
        inDbNotStripe: [],
        flaggedCount: -1,
      }))
      .finally(() => setSyncing(false));
  }, []);

  // Load internal payments
  const loadPaymentsData = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    if (typeFilter) params.set("type", typeFilter);
    if (search.trim()) params.set("q", search.trim());
    fetch(`/api/admin/payments?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setPayments(d.payments ?? []);
        setSummary(d.summary ?? null);
        setTotal(d.total ?? 0);
        if (d.dailyRevenue) setDailyRevenue(d.dailyRevenue);
        if (typeof d.divergentCount === "number") setDivergentCount(d.divergentCount);
        if (skipPaymentsSync.current) { skipPaymentsSync.current = false; return; }
        const ids = (d.payments ?? []).map((p: { id: string }) => p.id);
        if (!ids.length) return;
        fetch("/api/admin/payments/sync-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentIds: ids }),
        }).then((r) => r.json()).then((res) => {
          // eslint-disable-next-line react-hooks/immutability
          if (res.synced > 0) { skipPaymentsSync.current = true; loadPaymentsData(); }
        }).catch(() => {/* silent */});
      })
      .finally(() => setLoading(false));
  }, [offset, typeFilter, search]);

  useEffect(() => { loadPaymentsData(); }, [loadPaymentsData]);

  // Past-due subscription invoices
  useEffect(() => {
    setPendingLoading(true);
    fetch("/api/admin/payments/pending")
      .then((r) => r.json())
      .then((d) => setPendingItems(d.items ?? []))
      .catch(() => {/* silent */})
      .finally(() => setPendingLoading(false));
  }, []);

  // Surface QB connection + Stripe webhook status (Sales Receipt writes
  // depend on QB; reconciliation status depends on webhook heartbeat).
  useEffect(() => {
    setQbLoading(true);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setQbConnected(!!d.settings?.qbConnected);
        setLastStripeWebhookAt(d.settings?.lastStripeWebhookAt ?? null);
        setFlaggedStripeIds(d.settings?.stripeReconcileFlaggedIds ?? []);
        setStripeTestMode(!!d.settings?.stripeTestMode);
      })
      .catch(() => setQbConnected(false))
      .finally(() => setQbLoading(false));
  }, [syncResult]);

  const stripeWebhookStatus = lastStripeWebhookAt
    ? `Last Stripe webhook: ${new Date(lastStripeWebhookAt).toLocaleString()}`
    : "No Stripe webhooks received yet";

  // Reset offset on filter change
  useEffect(() => { setOffset(0); }, [typeFilter, search]);

  // Legacy QB reconciliation is retired — Stripe is the source of truth.
  const unmatchedQB: QBPaymentRecord[] = [];

  const typeLabels: Record<string, string> = {
    CHECKIN: "Daily",
    MONTHLY_CHECKIN: "Monthly",
    MONTHLY_RENEWAL: "Monthly",
    EXTENSION: "Extension",
    OVERSTAY: "Overstay",
  };

  return (
    <div>
      {selectedPayment && (
        <TransactionDetailsPopup
          payment={selectedPayment}
          siblingPayments={payments.filter(p => p.session?.id && p.session.id === selectedPayment.session?.id)}
          onClose={() => setSelectedPayment(null)}
          stripeTestMode={stripeTestMode}
        />
      )}

      {/* Past-due subscription invoices */}
      {!pendingLoading && pendingItems.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#F59E0B" }}>⚠️ Pending Payments</span>
            <span style={{ fontSize: 11, color: FG_DIM, background: "#1C1C1E", border: "1px solid #333", borderRadius: 10, padding: "1px 7px" }}>{pendingItems.length}</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: FG_DIM, textAlign: "left" }}>
                <th style={{ paddingBottom: 6, fontWeight: 500 }}>Driver</th>
                <th style={{ paddingBottom: 6, fontWeight: 500 }}>Type</th>
                <th style={{ paddingBottom: 6, fontWeight: 500 }}>Period</th>
                <th style={{ paddingBottom: 6, fontWeight: 500, textAlign: "right" }}>Amount</th>
                <th style={{ paddingBottom: 6, fontWeight: 500 }}>Status</th>
                <th style={{ paddingBottom: 6, fontWeight: 500 }} />
              </tr>
            </thead>
            <tbody>
              {pendingItems.map((item) => {
                const isExpanded = expandedPending.has(item.sessionId);
                const isPastDue = item.billingStatus === "PAYMENT_FAILED";
                const statusColor = isPastDue ? "#F59E0B" : "#DC2626";
                const statusLabel = isPastDue ? "⚠️ Past Due" : "🔴 Delinquent";
                const stripeBase = stripeTestMode
                  ? "https://dashboard.stripe.com/test"
                  : "https://dashboard.stripe.com";
                const invoiceUrl = item.invoiceId
                  ? `${stripeBase}/invoices/${item.invoiceId}`
                  : item.stripeSubscriptionId
                  ? `${stripeBase}/subscriptions/${item.stripeSubscriptionId}`
                  : null;
                const periodLabel = item.periodStart
                  ? new Date(item.periodStart).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                  : "—";
                const truncInvoice = item.invoiceId
                  ? `${item.invoiceId.slice(0, 6)}…${item.invoiceId.slice(-4)}`
                  : null;

                return (
                  <>
                    <tr
                      key={item.sessionId}
                      style={{ borderTop: "1px solid #2A2A2A", cursor: "pointer" }}
                      onClick={() =>
                        setExpandedPending((prev) => {
                          const next = new Set(prev);
                          if (next.has(item.sessionId)) next.delete(item.sessionId);
                          else next.add(item.sessionId);
                          return next;
                        })
                      }
                    >
                      <td style={{ padding: "8px 0" }}>
                        <div style={{ fontWeight: 500 }}>{item.driver.name}</div>
                        {item.vehicle?.licensePlate && (
                          <div style={{ fontSize: 10, color: FG_DIM }}>{item.vehicle.licensePlate}</div>
                        )}
                      </td>
                      <td style={{ padding: "8px 8px 8px 0", color: FG_DIM }}>Monthly</td>
                      <td style={{ padding: "8px 8px 8px 0", color: FG_DIM }}>{periodLabel}</td>
                      <td style={{ padding: "8px 8px 8px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {item.invoiceAmount != null ? `$${item.invoiceAmount.toFixed(2)}` : "—"}
                      </td>
                      <td style={{ padding: "8px 8px 8px 0", color: statusColor, fontWeight: 500 }}>{statusLabel}</td>
                      <td style={{ padding: "8px 0", textAlign: "right" }}>
                        {invoiceUrl && (
                          <a
                            href={invoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "#60A5FA", textDecoration: "none", fontSize: 11 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            View in Stripe ↗
                          </a>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${item.sessionId}-detail`}>
                        <td colSpan={6} style={{ paddingBottom: 12, paddingLeft: 0 }}>
                          <div style={{
                            background: "#161616",
                            border: "1px solid #2A2A2A",
                            borderRadius: 6,
                            padding: "10px 14px",
                            display: "flex",
                            flexDirection: "column",
                            gap: 5,
                            fontSize: 11,
                            color: FG_DIM,
                          }}>
                            {truncInvoice && (
                              <div>
                                Stripe invoice{" "}
                                <span style={{ fontFamily: "monospace", color: FG }}>{truncInvoice}</span>
                              </div>
                            )}
                            {item.lastAttemptAt && (
                              <div>
                                Last attempt failed{" "}
                                {new Date(item.lastAttemptAt).toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                })}
                              </div>
                            )}
                            {item.nextRetryAt ? (
                              <div>
                                Stripe retrying{" "}
                                {new Date(item.nextRetryAt).toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                })}
                              </div>
                            ) : item.billingStatus === "DELINQUENT" ? (
                              <div style={{ color: "#DC2626" }}>All retries exhausted — subscription canceled</div>
                            ) : null}
                            {item.attemptCount > 0 && (
                              <div>Attempt {item.attemptCount} of 4</div>
                            )}
                            {item.spot && (
                              <div>Spot {item.spot.label}</div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Summary cards */}
      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr 1fr" : "repeat(5, 1fr)", gap: 10, marginBottom: 20 }}>
          {[
            { label: "Total Revenue", value: `$${summary.totalRevenue.toFixed(2)}`, color: FG },
            { label: "Check-ins", value: `$${summary.checkinRevenue.toFixed(2)}` },
            { label: "Monthly", value: `$${summary.monthlyRevenue.toFixed(2)}` },
            { label: "Extensions", value: `$${summary.extensionRevenue.toFixed(2)}` },
            { label: "Overstay", value: `$${summary.overstayRevenue.toFixed(2)}`, color: "#DC2626" },
          ].map((c) => (
            <div key={c.label} style={{ background: CARD_BG, borderRadius: 10, padding: "14px 16px", border: `1px solid ${BORDER}` }}>
              <div style={{ fontSize: 10, color: FG_DIM, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 4 }}>{c.label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: c.color ?? FG_MUTED, fontVariantNumeric: "tabular-nums" }}>{c.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* QB quick link */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <a href={qbLinks.dashboard()} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#2563EB", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
          Open QuickBooks ↗
        </a>
      </div>

      {/* Revenue chart — last 30 days */}
      {dailyRevenue.length > 0 && (() => {
        const maxAmt = Math.max(...dailyRevenue.map((d) => d.amount), 1);
        const chartW = 100; // percentage-based
        const chartH = 120;
        const barW = chartW / dailyRevenue.length;
        void barW; // used implicitly by SVG viewBox ratio
        return (
          <div style={{ background: CARD_BG, borderRadius: 10, padding: "16px 16px 10px", border: `1px solid ${BORDER}`, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Daily Revenue — Last 30 Days
              </span>
              <span style={{ fontSize: 12, color: FG_MUTED }}>
                Peak: ${maxAmt.toFixed(0)}/day
              </span>
            </div>
            <svg width="100%" height={chartH} viewBox={`0 0 ${dailyRevenue.length} ${chartH}`} preserveAspectRatio="none" style={{ display: "block" }}>
              {dailyRevenue.map((d, i) => {
                const h = (d.amount / maxAmt) * (chartH - 20);
                const isToday = i === dailyRevenue.length - 1;
                return (
                  <g key={d.date}>
                    <rect
                      x={i + 0.1}
                      y={chartH - h}
                      width={0.8}
                      height={h}
                      rx={0.2}
                      fill={d.amount === 0 ? "#D1D5DB" : isToday ? "#2D7A4A" : "#2D7A4A80"}
                    />
                    {/* Show amount on hover via title */}
                    <title>{`${d.date}: $${d.amount.toFixed(2)}`}</title>
                    <rect x={i} y={0} width={1} height={chartH} fill="transparent" />
                  </g>
                );
              })}
            </svg>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 9, color: FG_DIM }}>{dailyRevenue[0]?.date.slice(5)}</span>
              <span style={{ fontSize: 9, color: FG_DIM }}>Today</span>
            </div>
          </div>
        );
      })()}

      {/* QB reconciliation banner */}
      {qbConnected && !qbLoading && (
        <div style={{ background: CARD_BG, borderRadius: 10, padding: "14px 16px", border: `1px solid ${BORDER}`, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                Stripe Reconciliation
              </div>
              <div style={{ fontSize: 12, color: FG_MUTED }}>
                {stripeWebhookStatus}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {flaggedStripeIds.length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 4, background: "#FEF3C7", color: "#92400E" }}>
                  {flaggedStripeIds.length} flagged
                </span>
              )}
              <button
                onClick={syncWithQB}
                disabled={syncing}
                style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: syncing ? FG_DIM : FG_MUTED, cursor: syncing ? "default" : "pointer" }}
              >
                {syncing ? "Checking…" : "Run Stripe reconcile"}
              </button>
            </div>
          </div>
          {/* Reconcile result summary */}
          {syncResult && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BORDER}`, fontSize: 12 }}>
              {syncResult.flaggedCount < 0 ? (
                <span style={{ color: "#DC2626" }}>
                  Stripe reconcile failed — check that STRIPE_SECRET_KEY is set.
                </span>
              ) : syncResult.flaggedCount === 0 ? (
                <span style={{ color: "#2D7A4A" }}>
                  All {syncResult.stripeChargesChecked} Stripe charge{syncResult.stripeChargesChecked !== 1 ? "s" : ""} in last 90 days match our DB.
                </span>
              ) : (
                <span style={{ color: "#92400E" }}>
                  {syncResult.inStripeNotDb.length} in Stripe but not our DB
                  {" · "}
                  {syncResult.inDbNotStripe.length} in our DB but not Stripe
                  {" · "}check logs + reach out to support if this persists
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {!qbConnected && !qbLoading && (
        <div style={{ fontSize: 12, color: FG_DIM, marginBottom: 16, padding: "10px 14px", background: CARD_BG, borderRadius: 8, border: `1px solid ${BORDER}` }}>
          QuickBooks not connected — Sales Receipts won&apos;t be written to QB.
          Stripe continues to work for payments; once QB is connected (Settings → QuickBooks Connection), new charges will mirror to QB automatically.
        </div>
      )}

      {/* Divergence warning bar */}
      {divergentCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#2C1810", border: "1px solid #DC2626", borderRadius: 8, marginBottom: 16, fontSize: 13, color: "#FCA5A5" }}>
          <span style={{ fontSize: 16 }}>⚠</span>
          <span>
            <strong>{divergentCount} QB accounting {divergentCount === 1 ? "gap" : "gaps"} detected</strong>
            {" "}— {divergentCount === 1 ? "a payment or refund is" : "some payments or refunds are"} missing a matching QB receipt.
            Click <strong>Details</strong> on flagged rows to see which side is missing.
          </span>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        {["", "CHECKIN", "MONTHLY_CHECKIN", "MONTHLY_RENEWAL", "EXTENSION", "OVERSTAY"].map((t) => (
          <button key={t || "ALL"} onClick={() => setTypeFilter(t)} style={chip(typeFilter === t, mobile)}>
            {t ? typeLabels[t] : "All"}
          </button>
        ))}
        <div style={{ flex: 1, minWidth: mobile ? "100%" : 180, maxWidth: mobile ? "100%" : 300 }}>
          <input type="text" placeholder="Search driver, plate, payment ID…" value={search} onChange={(e) => setSearch(e.target.value)} style={inputStyle} />
        </div>
      </div>

      {/* Payment ledger */}
      {loading ? (
        <p style={{ color: FG_DIM, textAlign: "center", padding: 40 }}>Loading…</p>
      ) : payments.length === 0 ? (
        <p style={{ color: FG_DIM, textAlign: "center", padding: 40 }}>No payments found.</p>
      ) : (
        <>
          <div style={{ fontSize: 11, color: FG_DIM, marginBottom: 8 }}>
            Showing {offset + 1}–{Math.min(offset + LIMIT, total)} of {total} transactions
          </div>

          {/* Table */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#F1F5F9", borderBottom: `2px solid ${BORDER}` }}>
                  {[
                    { label: "Date",         align: "left"  },
                    { label: "Type",         align: "left"  },
                    { label: "Driver",       align: "left"  },
                    { label: "Plate · Spot", align: "left",  hide: mobile },
                    { label: "Hrs",          align: "right", hide: mobile },
                    { label: "Amount",       align: "right" },
                    { label: "Payment",      align: "center"},
                    { label: "Session",      align: "center"},
                    { label: "Links",        align: "right" },
                  ].filter(c => !c.hide).map(c => (
                    <th key={c.label} style={{
                      padding: "8px 10px", textAlign: c.align as "left"|"right"|"center",
                      fontWeight: 700, fontSize: 10, textTransform: "uppercase",
                      letterSpacing: "0.07em", color: FG_DIM, whiteSpace: "nowrap",
                    }}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payments.map((p, idx) => {
                  const real = isRealPayment(p);
                  const stripeUrl = stripeDashboardUrl(p, stripeTestMode);
                  const stripeCustId = p.session?.driver?.stripeCustomerId;
                  const qbCustId = (p.session?.driver as { qbCustomerId?: string } | undefined)?.qbCustomerId;
                  const isRefunded         = p.status === "REFUNDED";
                  const isPartiallyRefunded = p.status === "PARTIALLY_REFUNDED";
                  const isDisputed         = p.status === "DISPUTED";
                  const rowBg = idx % 2 === 0 ? CARD_BG : "#F8FAFC";

                  // suppress unused — kept for future QB deep-links
                  void stripeCustId;
                  void qbCustId;

                  const typeBadgeStyle: React.CSSProperties = {
                    display: "inline-block",
                    fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em",
                    padding: "2px 6px", borderRadius: 3, whiteSpace: "nowrap",
                    background: p.type === "OVERSTAY" ? "#FEE2E2"
                              : (p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL") ? "#DBEAFE"
                              : "#DCFCE7",
                    color:      p.type === "OVERSTAY" ? "#DC2626"
                              : (p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL") ? "#2563EB"
                              : "#2D7A4A",
                  };

                  const cell: React.CSSProperties = {
                    padding: "9px 10px", borderBottom: `1px solid ${BORDER}`, verticalAlign: "middle",
                  };

                  return (
                    <tr key={p.id} style={{ background: rowBg }}>
                      {/* Date */}
                      <td style={{ ...cell, whiteSpace: "nowrap", color: FG_DIM, minWidth: 90 }}>
                        {new Date(p.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        <div style={{ fontSize: 10, color: "#4B5563" }}>
                          {new Date(p.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </div>
                      </td>

                      {/* Type */}
                      <td style={{ ...cell }}>
                        <span style={typeBadgeStyle}>
                          {(p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL")
                            ? monthlyLabel(payments.filter(q => q.session?.id && q.session.id === p.session?.id), p.id)
                            : (typeLabels[p.type] ?? p.type)}
                        </span>
                      </td>

                      {/* Driver */}
                      <td style={{ ...cell, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ fontWeight: 600, color: FG }}>{p.session?.driver?.name ?? "—"}</span>
                        {mobile && (
                          <div style={{ fontSize: 10, color: FG_DIM }}>
                            {p.session?.vehicle?.licensePlate ?? "—"} · {p.session?.spot?.label ?? "—"}
                          </div>
                        )}
                      </td>

                      {/* Plate · Spot (desktop) */}
                      {!mobile && (
                        <td style={{ ...cell, color: FG_DIM, whiteSpace: "nowrap" }}>
                          {p.session?.vehicle?.licensePlate ?? "—"} · {p.session?.spot?.label ?? "—"}
                        </td>
                      )}

                      {/* Days (desktop) */}
                      {!mobile && (
                        <td style={{ ...cell, textAlign: "right", color: FG_DIM, whiteSpace: "nowrap" }}>
                          {p.days ? `${p.days}d` : "—"}
                        </td>
                      )}

                      {/* Amount */}
                      <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
                        {p.refundedAmount > 0 ? (
                          <>
                            <div style={{ fontSize: 11, color: "#9CA3AF", textDecoration: "line-through", fontVariantNumeric: "tabular-nums" }}>
                              ${p.amount.toFixed(2)}
                            </div>
                            <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", color: isRefunded ? "#92400E" : "#B45309" }}>
                              ${(p.amount - p.refundedAmount).toFixed(2)}
                            </div>
                          </>
                        ) : (
                          <span style={{
                            fontWeight: 700, fontVariantNumeric: "tabular-nums",
                            color: isDisputed ? "#EF4444" : FG,
                            textDecoration: undefined,
                          }}>
                            ${p.amount.toFixed(2)}
                          </span>
                        )}
                      </td>

                      {/* Payment status */}
                      <td style={{ ...cell, textAlign: "center", whiteSpace: "nowrap" }}>
                        {isRefunded          && <span style={{ fontSize: 9, fontWeight: 700, color: "#92400E", background: "#FEF3C7", padding: "2px 6px", borderRadius: 3 }}>REFUNDED</span>}
                        {isPartiallyRefunded && <span style={{ fontSize: 9, fontWeight: 700, color: "#B45309", background: "#FEF3C7", padding: "2px 6px", borderRadius: 3 }}>PARTIAL REFUND</span>}
                        {isDisputed          && <span style={{ fontSize: 9, fontWeight: 700, color: "#EF4444", background: "#FEE2E2", padding: "2px 6px", borderRadius: 3 }}>DISPUTED</span>}
                        {!isRefunded && !isPartiallyRefunded && !isDisputed && (
                          <span style={{ fontSize: 9, color: "#2D7A4A", fontWeight: 600 }}>PAID</span>
                        )}
                      </td>

                      {/* Session status */}
                      <td style={{ ...cell, textAlign: "center", whiteSpace: "nowrap" }}>
                        {p.session?.status === "ACTIVE"    && <span style={{ fontSize: 9, fontWeight: 700, color: "#2D7A4A", background: "#DCFCE7", padding: "2px 6px", borderRadius: 3 }}>ACTIVE</span>}
                        {p.session?.status === "OVERSTAY"  && <span style={{ fontSize: 9, fontWeight: 700, color: "#92400E", background: "#FEF3C7", padding: "2px 6px", borderRadius: 3 }}>OVERSTAY</span>}
                        {p.session?.status === "COMPLETED" && <span style={{ fontSize: 9, fontWeight: 700, color: "#636366", background: "#F2F2F7", padding: "2px 6px", borderRadius: 3 }}>COMPLETED</span>}
                        {p.session?.status === "CANCELLED" && <span style={{ fontSize: 9, fontWeight: 700, color: "#6B21A8", background: "#F3E8FF", padding: "2px 6px", borderRadius: 3 }}>CANCELLED</span>}
                        {!p.session && <span style={{ fontSize: 9, color: "#C7C7CC" }}>—</span>}
                      </td>

                      {/* Links */}
                      <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                          {real && stripeUrl && (
                            <a href={stripeUrl} target="_blank" rel="noopener noreferrer"
                               style={{ fontSize: 11, color: "#635BFF", textDecoration: "none", fontWeight: 500 }}>
                              Stripe ↗
                            </a>
                          )}
                          <button
                            onClick={() => setSelectedPayment(p)}
                            style={{ fontSize: 11, color: "#6366F1", background: "none", border: "1px solid #6366F1", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontWeight: 500 }}
                          >
                            Details
                          </button>
                          {!real && (
                            <span style={{ fontSize: 10, color: FG_DIM }}>
                              {p.legacyQbReference?.startsWith("free_") ? "Free" : "Test"}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Unmatched QB payments */}
          {unmatchedQB.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                Unmatched QuickBooks Payments
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <tbody>
                  {unmatchedQB.map((qb, idx) => (
                    <tr key={qb.id} style={{ background: idx % 2 === 0 ? "#FEF3C7" : "#FFFBEB", borderBottom: `1px solid #D97706` }}>
                      <td style={{ padding: "8px 10px", color: "#92400E", fontWeight: 600 }}>{qb.customerName}</td>
                      <td style={{ padding: "8px 10px", color: FG_DIM }}>{qb.date} · {qb.method}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, color: "#92400E", fontVariantNumeric: "tabular-nums" }}>${qb.amount.toFixed(2)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right" }}>
                        <a href={qbLinks.payment(qb.id)} target="_blank" rel="noopener noreferrer"
                           style={{ fontSize: 11, color: "#2563EB", textDecoration: "none" }}>
                          QB ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {total > LIMIT && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
              <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={paginationBtn(offset === 0, mobile)}>← Newer</button>
              <span style={{ fontSize: 11, color: FG_DIM }}>{offset + 1}–{Math.min(offset + LIMIT, total)} of {total}</span>
              <button onClick={() => setOffset(offset + LIMIT)} disabled={offset + LIMIT >= total} style={paginationBtn(offset + LIMIT >= total, mobile)}>Older →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
