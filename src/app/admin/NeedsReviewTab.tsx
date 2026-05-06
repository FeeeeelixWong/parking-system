"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NeedsReviewItem, NeedsReviewResponse } from "@/types/domain";
import { useToast } from "@/app/admin/ToastContext";

const BG = "#FAFAFA";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E5EA";
const FG = "#1C1C1E";
const FG_MUTED = "#636366";
const FG_DIM = "#8E8E93";
const ACCENT = "#2D7A4A";
const WARN = "#B45309";
const WARN_LIGHT = "#FFFBEB";
const WARN_BORDER = "#FDE68A";
const ERR = "#DC2626";
const ERR_LIGHT = "#FEF2F2";
const ERR_BORDER = "#FCA5A5";
const MONO: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 };

type SeverityFilter = "all" | "warning" | "critical";
type WriteState = "idle" | "pending" | "success" | "error";

const LIMIT = 50;

const FILTERS: { key: SeverityFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "critical", label: "Critical" },
  { key: "warning", label: "Warnings" },
];

function fmtDate(iso?: string) {
  if (!iso) return "No date";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function shortId(id: string) {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

function SeverityBadge({ severity }: { severity: NeedsReviewItem["severity"] }) {
  const critical = severity === "critical";
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 7px",
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.05em",
      textTransform: "uppercase",
      background: critical ? ERR_LIGHT : WARN_LIGHT,
      color: critical ? ERR : WARN,
      border: `1px solid ${critical ? ERR_BORDER : WARN_BORDER}`,
      whiteSpace: "nowrap",
    }}>
      {critical ? "Critical" : "Warning"}
    </span>
  );
}

function RelatedIds({ item }: { item: NeedsReviewItem }) {
  const entries = [
    ["Session", item.related.sessionId],
    ["Payment", item.related.paymentId],
    ["Refund", item.related.refundId],
    ["Stripe charge", item.related.stripeChargeId],
    ["Stripe refund", item.related.stripeRefundId],
    ["QB receipt", item.related.qbReceiptId],
    ["QB refund", item.related.qbRefundReceiptId],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  if (!entries.length) return null;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
      {entries.map(([label, value]) => (
        <span key={`${label}-${value}`} style={{
          border: `1px solid ${BORDER}`,
          borderRadius: 4,
          background: "#F8FAFC",
          padding: "3px 6px",
          color: FG_DIM,
          fontSize: 11,
        }}>
          {label}: <span style={{ ...MONO, color: FG_MUTED }}>{shortId(value)}</span>
        </span>
      ))}
    </div>
  );
}

function actionPath(item: NeedsReviewItem) {
  if (item.code === "QB_RECEIPT_MISSING" && item.related.paymentId) {
    return `/api/admin/payments/${item.related.paymentId}/sync-receipt`;
  }
  if (item.code === "QB_REFUND_RECEIPT_MISSING" && item.related.paymentId) {
    return `/api/admin/payments/${item.related.paymentId}/sync-refunds`;
  }
  return null;
}

function ReviewAction({
  item,
  state,
  onRun,
}: {
  item: NeedsReviewItem;
  state: WriteState;
  onRun: (item: NeedsReviewItem) => void;
}) {
  const path = actionPath(item);
  const label = item.actionLabel ?? "View details";

  if (path) {
    const pending = state === "pending";
    const success = state === "success";
    return (
      <button
        disabled={pending || success}
        onClick={() => onRun(item)}
        style={{
          padding: "7px 11px",
          borderRadius: 5,
          border: `1px solid ${success ? "#86EFAC" : state === "error" ? ERR_BORDER : WARN_BORDER}`,
          background: success ? "#DCFCE7" : state === "error" ? ERR_LIGHT : WARN_LIGHT,
          color: success ? "#166534" : state === "error" ? ERR : WARN,
          fontSize: 12,
          fontWeight: 700,
          cursor: pending || success ? "default" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {pending ? "Syncing..." : success ? "Synced" : state === "error" ? "Retry" : label}
      </button>
    );
  }

  return (
    <button
      disabled
      title="Open the Sessions Ledger or related advanced view for details."
      style={{
        padding: "7px 11px",
        borderRadius: 5,
        border: `1px solid ${BORDER}`,
        background: "#F8FAFC",
        color: FG_MUTED,
        fontSize: 12,
        fontWeight: 700,
        cursor: "default",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function ReviewCard({
  item,
  mobile,
  writeState,
  onRunAction,
}: {
  item: NeedsReviewItem;
  mobile: boolean;
  writeState: WriteState;
  onRunAction: (item: NeedsReviewItem) => void;
}) {
  return (
    <article style={{
      background: CARD_BG,
      border: `1px solid ${item.severity === "critical" ? ERR_BORDER : BORDER}`,
      borderLeft: `3px solid ${item.severity === "critical" ? ERR : WARN}`,
      borderRadius: 6,
      padding: mobile ? "13px 14px" : "15px 16px",
    }}>
      <div style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        flexDirection: mobile ? "column" : "row",
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <SeverityBadge severity={item.severity} />
            <span style={{ color: FG_DIM, fontSize: 12 }}>{fmtDate(item.occurredAt)}</span>
          </div>
          <h3 style={{ margin: "8px 0 0", fontSize: 15, lineHeight: 1.3, color: FG }}>{item.title}</h3>
          <p style={{ margin: "5px 0 0", fontSize: 13, lineHeight: 1.5, color: FG_MUTED }}>{item.detail}</p>
          <p style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.45, color: FG }}>
            <span style={{ fontWeight: 700 }}>Recommended:</span> {item.recommendedAction}
          </p>
        </div>
        <ReviewAction item={item} state={writeState} onRun={onRunAction} />
      </div>
      <RelatedIds item={item} />
    </article>
  );
}

export default function NeedsReviewTab({
  mobile,
  onHasIssues,
}: {
  mobile: boolean;
  onHasIssues?: (v: boolean) => void;
}) {
  const { addToast } = useToast();
  const [items, setItems] = useState<NeedsReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [loading, setLoading] = useState(true);
  const [writeStates, setWriteStates] = useState<Record<string, WriteState>>({});

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      severity: severityFilter,
      limit: String(LIMIT),
      offset: String(offset),
    });
    fetch(`/api/admin/reconcile/needs-review?${params}`)
      .then((r) => r.json())
      .then((d: NeedsReviewResponse) => {
        setItems(d.items ?? []);
        setTotal(d.total ?? 0);
        setHasMore(d.hasMore ?? false);
        onHasIssues?.((d.total ?? 0) > 0);
      })
      .catch(() => {
        setItems([]);
        setTotal(0);
        setHasMore(false);
        addToast({ type: "error", message: "Could not load Needs Review." });
      })
      .finally(() => setLoading(false));
  }, [addToast, offset, onHasIssues, severityFilter]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => ({
    critical: items.filter((i) => i.severity === "critical").length,
    warning: items.filter((i) => i.severity === "warning").length,
  }), [items]);

  function setFilter(filter: SeverityFilter) {
    setOffset(0);
    setSeverityFilter(filter);
  }

  async function runAction(item: NeedsReviewItem) {
    const path = actionPath(item);
    if (!path) return;

    setWriteStates((prev) => ({ ...prev, [item.id]: "pending" }));
    try {
      const res = await fetch(path, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? "Action failed");
      }
      setWriteStates((prev) => ({ ...prev, [item.id]: "success" }));
      addToast({ type: "success", message: item.code === "QB_RECEIPT_MISSING" ? "QB Sales Receipt synced" : "QB refund receipt synced" });
      load();
    } catch (err) {
      setWriteStates((prev) => ({ ...prev, [item.id]: "error" }));
      addToast({ type: "error", message: err instanceof Error ? err.message : "Action failed" });
    }
  }

  return (
    <div style={{ padding: mobile ? "16px 12px" : "24px 20px", color: FG, background: BG, minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: mobile ? 18 : 22, fontWeight: 700, color: FG }}>Needs Review</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: FG_DIM }}>
            Payment, session, and accounting issues that need attention.
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
            fontWeight: 700,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 6, padding: "8px 10px", minWidth: 92 }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: FG_DIM, fontWeight: 700 }}>Total</div>
          <div style={{ fontSize: 18, color: FG, fontWeight: 700, marginTop: 1 }}>{total}</div>
        </div>
        <div style={{ background: CARD_BG, border: `1px solid ${ERR_BORDER}`, borderRadius: 6, padding: "8px 10px", minWidth: 92 }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: ERR, fontWeight: 700 }}>Critical</div>
          <div style={{ fontSize: 18, color: ERR, fontWeight: 700, marginTop: 1 }}>{counts.critical}</div>
        </div>
        <div style={{ background: CARD_BG, border: `1px solid ${WARN_BORDER}`, borderRadius: 6, padding: "8px 10px", minWidth: 92 }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: WARN, fontWeight: 700 }}>Warnings</div>
          <div style={{ fontSize: 18, color: WARN, fontWeight: 700, marginTop: 1 }}>{counts.warning}</div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {FILTERS.map(({ key, label }) => {
          const active = severityFilter === key;
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              style={{
                padding: "6px 13px",
                borderRadius: 20,
                border: active ? "1px solid transparent" : `1px solid ${BORDER}`,
                background: active ? BORDER : "transparent",
                color: active ? FG : FG_MUTED,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
        <span style={{ color: FG_DIM, fontSize: 12 }}>Warnings includes critical items.</span>
      </div>

      {loading ? (
        <p style={{ textAlign: "center", padding: 40, color: FG_DIM }}>Loading...</p>
      ) : items.length === 0 ? (
        <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 6, padding: 28, textAlign: "center", color: FG_MUTED }}>
          No items need review.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {items.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              mobile={mobile}
              writeState={writeStates[item.id] ?? "idle"}
              onRunAction={runAction}
            />
          ))}
        </div>
      )}

      {(hasMore || offset > 0) && (
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 20, alignItems: "center" }}>
          <button
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            style={{ padding: "6px 16px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD_BG, color: offset === 0 ? FG_DIM : FG, fontSize: 12, fontWeight: 700, cursor: offset === 0 ? "default" : "pointer" }}
          >
            Previous
          </button>
          <span style={{ color: FG_DIM, fontSize: 12 }}>
            {total === 0 ? "0" : `${offset + 1}-${Math.min(offset + LIMIT, total)}`} of {total}
          </span>
          <button
            disabled={!hasMore || loading}
            onClick={() => setOffset(offset + LIMIT)}
            style={{ padding: "6px 16px", borderRadius: 6, border: `1px solid ${BORDER}`, background: CARD_BG, color: !hasMore ? FG_DIM : FG, fontSize: 12, fontWeight: 700, cursor: !hasMore ? "default" : "pointer" }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
