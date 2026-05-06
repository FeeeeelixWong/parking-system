"use client";

import { useEffect, useState, useCallback } from "react";
import type { ReconcileSessionRow } from "@/app/api/admin/reconcile/route";
import { useToast } from "@/app/admin/ToastContext";

// ---------------------------------------------------------------------------
// Design tokens (match admin/page.tsx)
// ---------------------------------------------------------------------------
const BG = "#FAFAFA";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E5EA";

const FG = "#1C1C1E";
const FG_MUTED = "#636366";
const FG_DIM = "#8E8E93";
const ACCENT = "#2D7A4A";
const STRIPE_PURPLE = "#635BFF";
const ACCENT_LIGHT = "#EDF7F1";
const WARN = "#B45309";
const WARN_LIGHT = "#FFFBEB";
const ERR = "#DC2626";
const ERR_LIGHT = "#FEF2F2";
const MONO: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 };

const QB_BASE = process.env.NODE_ENV !== "production"
  ? "https://app.sandbox.qbo.intuit.com"
  : "https://app.qbo.intuit.com";

const qbReceiptUrl = (id: string) => `${QB_BASE}/app/salesreceipt?txnId=${id}`;
const qbRefundReceiptUrl = (id: string) => `${QB_BASE}/app/refundreceipt?txnId=${id}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type HealthFilter = "all" | "warning" | "critical";

function stripeDashBase(test: boolean) {
  return test ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtAmt(n: number, negative = false) {
  return (negative ? "−" : "") + "$" + Math.abs(n).toFixed(2);
}

function typeLabel(type: string) {
  return (
    { MONTHLY_CHECKIN: "Monthly check-in", MONTHLY_RENEWAL: "Monthly renewal",
      CHECKIN: "Check-in", EXTENSION: "Extension", OVERSTAY: "Overstay" }[type] ?? type
  );
}

// Text badge for status
function StatusBadge({ health }: { health: "ok" | "warning" | "critical" }) {
  const cfg = {
    ok:       { bg: ACCENT_LIGHT, color: ACCENT,  text: "OK" },
    warning:  { bg: WARN_LIGHT,   color: WARN,    text: "Mismatch" },
    critical: { bg: ERR_LIGHT,    color: ERR,     text: "Critical" },
  }[health];
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 6px",
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.05em",
      textTransform: "uppercase",
      background: cfg.bg,
      color: cfg.color,
      border: `1px solid ${cfg.color}22`,
    }}>
      {cfg.text}
    </span>
  );
}

type WriteState = "idle" | "pending" | "success" | "error";

// Inline action pill — three states: idle → pending → success or error
function ActionBtn({
  label,
  state,
  onTrigger,
}: {
  label: string;
  state: WriteState;
  onTrigger: () => void;
}) {
  if (state === "success") return <span style={{ fontSize: 11, fontWeight: 600, color: "#15803D" }}>Done</span>;
  if (state === "pending") {
    return (
      <button disabled style={{ padding: "2px 9px", borderRadius: 4, border: `1px solid #C7C7CC`, background: "#F2F2F7", color: "#8E8E93", fontSize: 11, fontWeight: 600, cursor: "not-allowed", whiteSpace: "nowrap" }}>
        Writing…
      </button>
    );
  }
  const isErr = state === "error";
  return (
    <button
      onClick={onTrigger}
      style={{
        padding: "2px 9px", borderRadius: 4,
        border: `1px solid ${isErr ? "#DC2626" : WARN}`,
        background: isErr ? "#FEE2E2" : WARN_LIGHT,
        color: isErr ? "#DC2626" : WARN,
        fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
      }}
    >
      {isErr ? "Retry" : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Drill-down: detailed ledger table for one session
// ---------------------------------------------------------------------------
function LedgerTable({
  session,
  testMode,
  onRefresh,
}: {
  session: ReconcileSessionRow;
  testMode: boolean;
  onRefresh: () => void;
}) {
  const thStyle: React.CSSProperties = {
    padding: "8px 10px",
    textAlign: "left",
    fontSize: 10,
    fontWeight: 700,
    color: FG_DIM,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };

  const tdStyle: React.CSSProperties = {
    padding: "9px 10px",
    fontSize: 12,
    color: FG,
    verticalAlign: "top",
    borderBottom: `1px solid ${BORDER}`,
  };

  return (
    <div style={{ padding: "16px 20px 20px" }}>
      {/* Payments ledger */}
      <div style={{ marginBottom: 4, fontSize: 11, fontWeight: 700, color: FG_DIM, letterSpacing: "0.05em", textTransform: "uppercase" }}>
        Payments
      </div>
      <div style={{ overflowX: "auto", marginBottom: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#F1F5F9", borderBottom: `2px solid ${BORDER}` }}>
              <th style={thStyle}>Date</th>
              <th style={thStyle}>Transaction</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
              <th style={thStyle}>Stripe Payment</th>
              <th style={thStyle}>QuickBooks Receipt</th>
              <th style={{ ...thStyle, textAlign: "center" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {session.payments.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ ...tdStyle, color: FG_DIM, textAlign: "center", padding: 20 }}>
                  No payments recorded for this session.
                </td>
              </tr>
            ) : (
              session.payments.map((p, idx) => {
                const rowBg = idx % 2 === 0 ? CARD_BG : "#F9FAFB";
                const hasCharge = !!(p.stripeChargeId || p.stripePaymentIntentId);
                const hasReceipt = !!p.qbSalesReceiptId;
                const rowHealth =
                  !hasCharge ? "critical"
                  : p.stripeChargeId && !hasReceipt ? "warning"
                  : "ok";

                return [
                  // Payment row
                  <PaymentLedgerRow
                    key={p.id}
                    payment={p}
                    bg={rowBg}
                    tdStyle={tdStyle}
                    testMode={testMode}
                    health={rowHealth}
                    onRefresh={onRefresh}
                  />,
                  // Refund sub-rows
                  ...p.refunds.map((r) => (
                    <RefundLedgerRow
                      key={r.id}
                      refund={r}
                      paymentId={p.id}
                      bg={idx % 2 === 0 ? "#FAFFFE" : "#F5FFFE"}
                      tdStyle={tdStyle}
                      testMode={testMode}
                      onRefresh={onRefresh}
                    />
                  )),
                ];
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual table rows for the ledger
// ---------------------------------------------------------------------------
function PaymentLedgerRow({
  payment: p,
  bg,
  tdStyle,
  testMode,
  health,
  onRefresh,
}: {
  payment: ReconcileSessionRow["payments"][number];
  bg: string;
  tdStyle: React.CSSProperties;
  testMode: boolean;
  health: "ok" | "warning" | "critical";
  onRefresh: () => void;
}) {
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const { addToast } = useToast();

  async function doWriteReceipt() {
    setWriteState("pending");
    const res = await fetch(`/api/admin/payments/${p.id}/sync-receipt`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setWriteState("success");
      addToast({ type: "success", message: "QB Sales Receipt written" });
      onRefresh();
    } else {
      setWriteState("error");
      addToast({ type: "error", message: `QB write failed · ${data.error ?? "Unknown error"}` });
    }
  }

  return (
    <tr style={{ background: bg }}>
      <td style={{ ...tdStyle, color: FG_DIM, whiteSpace: "nowrap" }}>{fmtDate(p.createdAt)}</td>
      <td style={tdStyle}>{typeLabel(p.type)}</td>
      <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        {fmtAmt(p.amount)}
      </td>
      {/* Stripe Payment column */}
      <td style={tdStyle}>
        {p.stripeChargeId ? (
          <a
            href={`${stripeDashBase(testMode)}/payments/${p.stripeChargeId}`}
            target="_blank"
            rel="noreferrer"
            style={{ ...MONO, color: STRIPE_PURPLE, textDecoration: "none" }}
          >
            {p.stripeChargeId} ↗
          </a>
        ) : p.stripePaymentIntentId ? (
          <a
            href={`${stripeDashBase(testMode)}/payments/${p.stripePaymentIntentId}`}
            target="_blank"
            rel="noreferrer"
            style={{ ...MONO, color: STRIPE_PURPLE, textDecoration: "none" }}
          >
            {p.stripePaymentIntentId} ↗
          </a>
        ) : (
          <span style={{ fontSize: 12, color: ERR }}>No charge ID recorded</span>
        )}
      </td>
      {/* QuickBooks Receipt column */}
      <td style={tdStyle}>
        {p.qbSalesReceiptId ? (
          <a href={qbReceiptUrl(p.qbSalesReceiptId)} target="_blank" rel="noreferrer"
            style={{ ...MONO, color: ACCENT, textDecoration: "none" }}>
            Receipt #{p.qbSalesReceiptId} ↗
          </a>
        ) : p.stripeChargeId ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: WARN }}>Not written</span>
            <ActionBtn label="Write Receipt" state={writeState} onTrigger={doWriteReceipt} />
          </span>
        ) : (
          <span style={{ color: FG_DIM, fontSize: 12 }}>—</span>
        )}
      </td>
      <td style={{ ...tdStyle, textAlign: "center" }}>
        <StatusBadge health={health} />
      </td>
    </tr>
  );
}

function RefundLedgerRow({
  refund: r,
  paymentId,
  bg,
  tdStyle,
  testMode,
  onRefresh,
}: {
  refund: ReconcileSessionRow["payments"][number]["refunds"][number];
  paymentId: string;
  bg: string;
  tdStyle: React.CSSProperties;
  testMode: boolean;
  onRefresh: () => void;
}) {
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const { addToast } = useToast();
  const health: "ok" | "warning" | "critical" = r.qbRefundReceiptId ? "ok" : "warning";

  async function doWriteRefundReceipt() {
    setWriteState("pending");
    const res = await fetch(`/api/admin/payments/${paymentId}/sync-refunds`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setWriteState("success");
      addToast({ type: "success", message: "QB Refund Receipt written" });
      onRefresh();
    } else {
      setWriteState("error");
      addToast({ type: "error", message: `QB refund write failed · ${data.error ?? "Unknown error"}` });
    }
  }

  return (
    <tr style={{ background: bg, borderLeft: `3px solid #FCA5A5` }}>
      <td style={{ ...tdStyle, color: FG_DIM, whiteSpace: "nowrap", paddingLeft: 20 }}>
        {fmtDate(r.createdAt)}
      </td>
      <td style={{ ...tdStyle, color: FG_MUTED, fontStyle: "italic", paddingLeft: 20 }}>
        Refund
      </td>
      <td style={{ ...tdStyle, textAlign: "right", color: ERR, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        {fmtAmt(r.amount, true)}
      </td>
      {/* Stripe refund */}
      <td style={tdStyle}>
        {r.stripeRefundId ? (
          <a
            href={`${stripeDashBase(testMode)}/refunds/${r.stripeRefundId}`}
            target="_blank"
            rel="noreferrer"
            style={{ ...MONO, color: ACCENT, textDecoration: "none" }}
          >
            {r.stripeRefundId} ↗
          </a>
        ) : (
          <span style={{ fontSize: 12, color: ERR }}>No refund ID recorded</span>
        )}
      </td>
      {/* QB refund receipt */}
      <td style={tdStyle}>
        {r.qbRefundReceiptId ? (
          <a href={qbRefundReceiptUrl(r.qbRefundReceiptId!)} target="_blank" rel="noreferrer"
            style={{ ...MONO, color: ACCENT, textDecoration: "none" }}>
            Refund Receipt #{r.qbRefundReceiptId} ↗
          </a>
        ) : (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: WARN }}>Not written</span>
            <ActionBtn label="Write Refund Receipt" state={writeState} onTrigger={doWriteRefundReceipt} />
          </span>
        )}
      </td>
      <td style={{ ...tdStyle, textAlign: "center" }}>
        <StatusBadge health={health} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Summary row Stripe / QB cells for the main session table
// ---------------------------------------------------------------------------
function MainStripeCell({ s, testMode }: { s: ReconcileSessionRow; testMode: boolean }) {
  if (s.payments.length === 0)
    return <span style={{ fontSize: 12, color: ERR }}>No payments</span>;

  if (s.sessionType === "MONTHLY") {
    const charged = s.payments.filter((p) => p.stripeChargeId || p.stripePaymentIntentId).length;
    const total = s.payments.filter((p) => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL").length;
    const webhookMiss = s.stripeInvoiceCount !== undefined && s.dbPaymentCount !== undefined && s.stripeInvoiceCount > s.dbPaymentCount;
    const ok = charged === total && !webhookMiss;
    const subId = s.payments.find((p) => p.stripeSubscriptionId)?.stripeSubscriptionId;
    const firstChargeId = s.payments.find((p) => p.stripeChargeId)?.stripeChargeId;
    const firstPiId = s.payments.find((p) => p.stripePaymentIntentId)?.stripePaymentIntentId;
    const href = subId
      ? `${stripeDashBase(testMode)}/subscriptions/${subId}`
      : firstChargeId
      ? `${stripeDashBase(testMode)}/payments/${firstChargeId}`
      : firstPiId
      ? `${stripeDashBase(testMode)}/payments/${firstPiId}`
      : null;
    const label = `${charged} / ${total} charged${webhookMiss ? ` · ${s.stripeInvoiceCount! - s.dbPaymentCount!} invoice${s.stripeInvoiceCount! - s.dbPaymentCount! > 1 ? "s" : ""} missing` : ""}`;
    if (href)
      return (
        <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
          style={{ fontSize: 12, color: ok ? STRIPE_PURPLE : WARN, textDecoration: "none" }}>
          {label} ↗
        </a>
      );
    return <span style={{ fontSize: 12, color: ok ? STRIPE_PURPLE : WARN }}>{label}</span>;
  }

  const p = s.payments[0];
  if (p?.stripeChargeId)
    return (
      <a
        href={`${stripeDashBase(testMode)}/payments/${p.stripeChargeId}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ fontSize: 12, color: STRIPE_PURPLE, textDecoration: "none" }}
      >
        Charged ↗
      </a>
    );
  if (p?.stripePaymentIntentId)
    return (
      <a
        href={`${stripeDashBase(testMode)}/payments/${p.stripePaymentIntentId}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ fontSize: 12, color: STRIPE_PURPLE, textDecoration: "none" }}
      >
        Authorized ↗
      </a>
    );
  if (!s.payments.some((p) => p.amount > 0)) return null;
  return <span style={{ fontSize: 12, color: ERR }}>No charge recorded</span>;
}

function MainQBCell({ s, onRefresh }: { s: ReconcileSessionRow; onRefresh: () => void }) {
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const { addToast } = useToast();
  if (s.payments.length === 0) return <span style={{ color: FG_DIM, fontSize: 12 }}>—</span>;

  if (s.sessionType === "MONTHLY") {
    const billed = s.payments.filter((p) => p.stripeChargeId);
    const withReceipt = billed.filter((p) => p.qbSalesReceiptId).length;
    const ok = withReceipt === billed.length && billed.length > 0;
    const label = billed.length === 0 ? "—" : `${withReceipt} / ${billed.length} receipts written`;
    const color = ok ? ACCENT : billed.length === 0 ? FG_DIM : WARN;
    const firstReceiptId = billed.find((p) => p.qbSalesReceiptId)?.qbSalesReceiptId;
    if (firstReceiptId)
      return (
        <a href={qbReceiptUrl(firstReceiptId)} target="_blank" rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ fontSize: 12, color, textDecoration: "none" }}>
          {label} ↗
        </a>
      );
    return <span style={{ fontSize: 12, color }}>{label}</span>;
  }

  const p = s.payments[0];
  if (!p) return <span style={{ color: FG_DIM, fontSize: 12 }}>—</span>;
  if (p.qbSalesReceiptId)
    return (
      <a href={qbReceiptUrl(p.qbSalesReceiptId!)} target="_blank" rel="noreferrer"
        style={{ fontSize: 12, color: ACCENT, textDecoration: "none" }}>
        Receipt written ↗
      </a>
    );
  if (!p.stripeChargeId) return <span style={{ color: FG_DIM, fontSize: 12 }}>—</span>;

  async function doWrite(e?: React.MouseEvent) {
    e?.stopPropagation?.();
    setWriteState("pending");
    const res = await fetch(`/api/admin/payments/${p!.id}/sync-receipt`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setWriteState("success");
      addToast({ type: "success", message: "QB Sales Receipt written" });
      onRefresh();
    } else {
      setWriteState("error");
      addToast({ type: "error", message: `QB write failed · ${data.error ?? "Unknown error"}` });
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {writeState === "idle" && <span style={{ fontSize: 12, color: WARN }}>Not written</span>}
      <ActionBtn label="Write Receipt" state={writeState} onTrigger={doWrite} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
const FILTERS: { key: HealthFilter; label: string }[] = [
  { key: "all", label: "All sessions" },
  { key: "warning", label: "Mismatches only" },
  { key: "critical", label: "Critical only" },
];

export default function ReconcileTab({ mobile, onHasIssues }: { mobile: boolean; onHasIssues?: (v: boolean) => void }) {
  const [sessions, setSessions] = useState<ReconcileSessionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(false);
  const LIMIT = 30;

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then((s) => {
      if (typeof s.stripeTestMode === "boolean") setTestMode(s.stripeTestMode);
    }).catch(() => {});
  }, []);

  // Report issue presence to parent (only on first/unfiltered load)
  useEffect(() => {
    if (!onHasIssues) return;
    fetch("/api/admin/reconcile?health=warning&limit=1")
      .then((r) => r.json())
      .then((d) => onHasIssues((d.total ?? 0) > 0))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ health: healthFilter, limit: String(LIMIT), offset: String(offset) });
    fetch(`/api/admin/reconcile?${params}`)
      .then((r) => r.json())
      .then((d) => { setSessions(d.sessions ?? []); setTotal(d.total ?? 0); setHasMore(d.hasMore ?? false); })
      .finally(() => setLoading(false));
  }, [healthFilter, offset]);

  useEffect(() => { load(); }, [load]);

  const setFilter = (f: HealthFilter) => { setOffset(0); setHealthFilter(f); };

  // Main table styles
  const thStyle: React.CSSProperties = {
    padding: "8px 10px",
    textAlign: "left",
    fontSize: 10,
    fontWeight: 700,
    color: FG_DIM,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };

  const tdStyle: React.CSSProperties = {
    padding: "9px 10px",
    color: FG,
    borderBottom: `1px solid ${BORDER}`,
    verticalAlign: "middle",
  };

  return (
    <div style={{ padding: mobile ? "16px 12px" : "24px 20px", color: FG, background: BG, minHeight: "100%" }}>

      {/* Page header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: mobile ? 18 : 22, fontWeight: 700, color: FG }}>
            Payment Reconciliation
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: FG_DIM }}>
            Sessions from the last 90 days &mdash; verifying Stripe charges, database records, and QuickBooks receipts
          </p>
        </div>
        <button
          onClick={() => { setOffset(0); load(); }}
          disabled={loading}
          style={{
            padding: "8px 18px",
            borderRadius: 6,
            border: "none",
            background: ACCENT,
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Filter row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {FILTERS.map(({ key, label }) => {
          const active = healthFilter === key;
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                border: active ? "1px solid transparent" : `1px solid ${BORDER}`,
                background: active ? BORDER : "transparent",
                color: active ? FG : FG_MUTED,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                letterSpacing: "0.02em",
              }}
            >
              {label}
            </button>
          );
        })}
        {!loading && (
          <span style={{ fontSize: 12, color: FG_DIM, marginLeft: 4 }}>
            {total} session{total !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <p style={{ textAlign: "center", padding: 40, color: FG_DIM }}>Loading…</p>
      ) : sessions.length === 0 ? (
        <p style={{ textAlign: "center", padding: 40, color: FG_MUTED }}>
          {healthFilter === "all"
            ? "No sessions in the last 90 days."
            : healthFilter === "critical"
            ? "No critical issues found."
            : "No mismatches detected — all sessions are reconciled."}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          {mobile ? (
            /* ── Mobile: cards ── */
            <div>
              {sessions.map((s) => {
                const isExpanded = expandedId === s.id;
                return (
                  <div key={s.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                    <div
                      onClick={() => setExpandedId(isExpanded ? null : s.id)}
                      style={{ padding: "13px 14px", background: isExpanded ? "#F3F4F6" : CARD_BG, cursor: "pointer" }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>{s.driver.name}</div>
                          <div style={{ fontSize: 12, color: FG_DIM, marginTop: 2 }}>
                            {fmtDate(s.startedAt)} · {s.spot?.label ?? "No spot"} · {s.sessionType}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <StatusBadge health={s.health} />
                          <span style={{ color: FG_DIM, fontSize: 12 }}>{isExpanded ? "▲" : "▼"}</span>
                        </div>
                      </div>
                      {s.billingStatus !== "CURRENT" && (
                        <span style={{
                          display: "inline-block", marginTop: 5, fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
                          background: s.billingStatus === "DELINQUENT" ? ERR_LIGHT : WARN_LIGHT,
                          color: s.billingStatus === "DELINQUENT" ? ERR : WARN,
                        }}>
                          {s.billingStatus === "DELINQUENT" ? "DELINQUENT" : "PAYMENT FAILED"}
                        </span>
                      )}
                      {s.issues[0] && (
                        <div style={{ fontSize: 12, color: WARN, marginTop: 6 }}>{s.issues[0]}</div>
                      )}
                    </div>
                    {isExpanded && (
                      <LedgerTable session={s} testMode={testMode} onRefresh={load} />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* ── Desktop: full table ── */
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#F1F5F9", borderBottom: `2px solid ${BORDER}` }}>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Driver</th>
                  <th style={thStyle}>Spot</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Session Status</th>
                  <th style={thStyle}>Stripe Payment</th>
                  <th style={thStyle}>QuickBooks Receipt</th>
                  <th style={thStyle}>Issues</th>
                  <th style={{ ...thStyle, textAlign: "center" }}>Audit Status</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s, idx) => {
                  const isExpanded = expandedId === s.id;
                  const rowBg = isExpanded ? "#F1F5F9" : idx % 2 === 0 ? CARD_BG : "#F8FAFC";

                  return [
                    <tr
                      key={s.id}
                      onClick={() => setExpandedId(isExpanded ? null : s.id)}
                      style={{ background: rowBg, cursor: "pointer", transition: "background 0.1s" }}
                    >
                      <td style={{ ...tdStyle, color: FG_DIM, whiteSpace: "nowrap", borderLeft: isExpanded ? `3px solid ${ACCENT}` : "3px solid transparent" }}>{fmtDate(s.startedAt)}</td>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 500 }}>{s.driver.name}</div>
                        {s.vehicle?.licensePlate && (
                          <div style={{ fontSize: 11, color: FG_DIM }}>{s.vehicle.licensePlate}</div>
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: FG_MUTED }}>{s.spot?.label ?? "—"}</td>
                      <td style={tdStyle}>
                        <span style={{
                          display: "inline-block", fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, letterSpacing: "0.03em",
                          background: s.sessionType === "MONTHLY" ? "#DBEAFE" : "#DCFCE7",
                          color:      s.sessionType === "MONTHLY" ? "#1D4ED8" : "#166534",
                        }}>
                          {s.sessionType}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{
                          display: "inline-block", fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3,
                          background: s.status === "ACTIVE" ? "#DCFCE7" : s.status === "OVERSTAY" ? "#FEF3C7" : s.status === "COMPLETED" ? "#F2F2F7" : "#F3E8FF",
                          color:      s.status === "ACTIVE" ? "#166534" : s.status === "OVERSTAY" ? "#92400E" : s.status === "COMPLETED" ? "#636366" : "#6B21A8",
                        }}>
                          {s.status}
                        </span>
                        {s.billingStatus !== "CURRENT" && (
                          <span style={{
                            display: "block", marginTop: 3, fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
                            background: s.billingStatus === "DELINQUENT" ? ERR_LIGHT : WARN_LIGHT,
                            color: s.billingStatus === "DELINQUENT" ? ERR : WARN,
                          }}>
                            {s.billingStatus === "DELINQUENT" ? "DELINQUENT" : "PAYMENT FAILED"}
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>
                        <MainStripeCell s={s} testMode={testMode} />
                      </td>
                      <td style={tdStyle}>
                        <MainQBCell s={s} onRefresh={load} />
                      </td>
                      <td style={{ ...tdStyle, fontSize: 12, color: s.health === "ok" ? FG_DIM : WARN, maxWidth: 220 }}>
                        {s.issues[0] ?? "—"}
                        {s.issues.length > 1 && (
                          <span style={{ color: FG_DIM }}> (+{s.issues.length - 1} more)</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "center" }}>
                        <StatusBadge health={s.health} />
                      </td>
                    </tr>,
                    isExpanded && (
                      <tr key={`${s.id}-detail`} style={{ background: "#F0FBF4" }}>
                        <td colSpan={9} style={{ padding: 0, borderLeft: `3px solid ${ACCENT}`, borderBottom: `2px solid ${ACCENT}` }}>
                          <LedgerTable session={s} testMode={testMode} onRefresh={load} />
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Pagination */}
      {(hasMore || offset > 0) && (
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 20, alignItems: "center" }}>
          <button
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            style={{ padding: "6px 16px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD_BG, color: FG_MUTED, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
          >
            ← Previous
          </button>
          <span style={{ color: FG_DIM, fontSize: 12 }}>
            {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
          </span>
          <button
            disabled={!hasMore || loading}
            onClick={() => setOffset(offset + LIMIT)}
            style={{ padding: "6px 16px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD_BG, color: FG_MUTED, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
