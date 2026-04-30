"use client";

import { useEffect, useState, useCallback } from "react";
import type {
  ChargesReceiptsResponse,
  ChargeItem,
  RefundItem,
  ReceiptItem,
  RefundReceiptItem,
  PaymentRef,
} from "@/app/api/admin/reconcile/charges-receipts/route";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
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
const MONO: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtAmt(n: number) { return "$" + n.toFixed(2); }
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function stripeDashBase(test: boolean) {
  return test ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
}
const QB_BASE = process.env.NODE_ENV !== "production"
  ? "https://app.sandbox.qbo.intuit.com"
  : "https://app.qbo.intuit.com";
function qbReceiptUrl(id: string) { return `${QB_BASE}/app/salesreceipt?txnId=${id}`; }
function qbRefundReceiptUrl(id: string) { return `${QB_BASE}/app/refundreceipt?txnId=${id}`; }

// ---------------------------------------------------------------------------
// Unmatched badge
// ---------------------------------------------------------------------------
function UnmatchedBadge({ label = "Unmatched" }: { label?: string }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 6px", borderRadius: 3, fontSize: 10,
      fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
      background: WARN_LIGHT, color: WARN, border: `1px solid ${WARN_BORDER}`,
    }}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Charge cell (left column)
// ---------------------------------------------------------------------------
function ChargeCell({
  charge, testMode, orphan, linkedReceipt,
}: {
  charge: ChargeItem; payment: PaymentRef | null; testMode: boolean; orphan?: boolean;
  linkedReceipt?: ReceiptItem | null;
}) {
  const purposeLabel =
    { CHECKIN: "Check-in", EXTENSION: "Extension", OVERSTAY: "Overstay",
      MONTHLY_CHECKIN: "Monthly check-in", MONTHLY_RENEWAL: "Monthly renewal",
    }[charge.metadata.sessionPurpose ?? ""] ?? charge.description ?? "Charge";
  const name = charge.billingName ?? charge.metadata.driverId ?? null;

  return (
    <div style={{ padding: "13px 16px" }}>
      {orphan && <div style={{ marginBottom: 6 }}><UnmatchedBadge /></div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <a href={`${stripeDashBase(testMode)}/payments/${charge.id}`} target="_blank" rel="noreferrer"
            style={{ ...MONO, color: ACCENT, textDecoration: "none" }}>
            {charge.id} ↗
          </a>
          <div style={{ fontSize: 12, color: FG_MUTED, marginTop: 3 }}>
            {purposeLabel}
            {name && <span style={{ color: FG_DIM }}> · {name}</span>}
          </div>
          {linkedReceipt && (
            <div style={{ fontSize: 11, color: FG_DIM, marginTop: 4 }}>
              QB receipt:{" "}
              <a href={qbReceiptUrl(linkedReceipt.id)} target="_blank" rel="noreferrer"
                style={{ ...MONO, color: FG_DIM, textDecoration: "none" }}>
                #{linkedReceipt.docNumber} ↗
              </a>
            </div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, fontSize: 14 }}>{fmtAmt(charge.amount)}</div>
          <div style={{ fontSize: 11, color: FG_DIM, marginTop: 2 }}>{fmtDate(charge.created)}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Refund cell (left column for the refunds section)
// ---------------------------------------------------------------------------
function RefundCell({
  refund, charge, testMode, orphan, linkedRefundReceipt,
}: {
  refund: RefundItem; charge: ChargeItem; testMode: boolean; orphan?: boolean;
  linkedRefundReceipt?: RefundReceiptItem | null;
}) {
  return (
    <div style={{ padding: "13px 16px" }}>
      {orphan && <div style={{ marginBottom: 6 }}><UnmatchedBadge /></div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <a href={`${stripeDashBase(testMode)}/refunds/${refund.id}`} target="_blank" rel="noreferrer"
            style={{ ...MONO, color: WARN, textDecoration: "none" }}>
            {refund.id} ↗
          </a>
          <div style={{ fontSize: 11, color: FG_DIM, marginTop: 3 }}>
            Refund of{" "}
            <a href={`${stripeDashBase(testMode)}/payments/${refund.chargeId}`} target="_blank" rel="noreferrer"
              style={{ ...MONO, color: FG_DIM, textDecoration: "none" }}>
              {refund.chargeId} ↗
            </a>
          </div>
          {charge.billingName && (
            <div style={{ fontSize: 12, color: FG_MUTED, marginTop: 2 }}>{charge.billingName}</div>
          )}
          {linkedRefundReceipt && (
            <div style={{ fontSize: 11, color: FG_DIM, marginTop: 4 }}>
              QB refund receipt:{" "}
              <a href={qbRefundReceiptUrl(linkedRefundReceipt.id)} target="_blank" rel="noreferrer"
                style={{ ...MONO, color: FG_DIM, textDecoration: "none" }}>
                #{linkedRefundReceipt.docNumber} ↗
              </a>
            </div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, fontSize: 14, color: WARN }}>
            −{fmtAmt(refund.amount)}
          </div>
          <div style={{ fontSize: 11, color: FG_DIM, marginTop: 2 }}>{fmtDate(refund.created)}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Receipt cell (right column — charges section)
// ---------------------------------------------------------------------------
function ReceiptCell({
  receipt, payment, orphan, testMode,
}: {
  receipt: ReceiptItem; payment: PaymentRef | null; orphan?: boolean; testMode: boolean;
}) {
  return (
    <div style={{ padding: "13px 16px" }}>
      {orphan && <div style={{ marginBottom: 6 }}><UnmatchedBadge /></div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <a href={qbReceiptUrl(receipt.id)} target="_blank" rel="noreferrer"
            style={{ ...MONO, color: ACCENT, textDecoration: "none" }}>
            Receipt #{receipt.docNumber} ↗
          </a>
          {receipt.customerName && (
            <div style={{ fontSize: 12, color: FG_MUTED, marginTop: 3 }}>{receipt.customerName}</div>
          )}
          {receipt.stripeChargeId && (
            <div style={{ fontSize: 11, color: FG_DIM, marginTop: 4 }}>
              Stripe charge:{" "}
              <a href={`${stripeDashBase(testMode)}/payments/${receipt.stripeChargeId}`} target="_blank" rel="noreferrer"
                style={{ ...MONO, color: FG_DIM, textDecoration: "none" }}>
                {receipt.stripeChargeId} ↗
              </a>
            </div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, fontSize: 14 }}>{fmtAmt(receipt.totalAmount)}</div>
          <div style={{ fontSize: 11, color: FG_DIM, marginTop: 2 }}>{fmtDate(receipt.txnDate)}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Refund receipt cell (right column — refunds section)
// ---------------------------------------------------------------------------
function RefundReceiptCell({
  refundReceipt, testMode, orphan,
}: {
  refundReceipt: RefundReceiptItem; testMode: boolean; orphan?: boolean;
}) {
  return (
    <div style={{ padding: "13px 16px" }}>
      {orphan && <div style={{ marginBottom: 6 }}><UnmatchedBadge label="Unmatched Refund" /></div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <a href={qbRefundReceiptUrl(refundReceipt.id)} target="_blank" rel="noreferrer"
            style={{ ...MONO, color: WARN, textDecoration: "none" }}>
            Refund #{refundReceipt.docNumber} ↗
          </a>
          {refundReceipt.customerName && (
            <div style={{ fontSize: 12, color: FG_MUTED, marginTop: 3 }}>{refundReceipt.customerName}</div>
          )}
          {refundReceipt.stripeRefundId && (
            <div style={{ fontSize: 11, color: FG_DIM, marginTop: 4 }}>
              Stripe refund:{" "}
              <a href={`${stripeDashBase(testMode)}/refunds/${refundReceipt.stripeRefundId}`} target="_blank" rel="noreferrer"
                style={{ ...MONO, color: FG_DIM, textDecoration: "none" }}>
                {refundReceipt.stripeRefundId} ↗
              </a>
            </div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, fontSize: 14, color: WARN }}>
            −{fmtAmt(refundReceipt.totalAmount)}
          </div>
          <div style={{ fontSize: 11, color: FG_DIM, marginTop: 2 }}>{fmtDate(refundReceipt.txnDate)}</div>
        </div>
      </div>
    </div>
  );
}

function EmptyCell({ label }: { label: string }) {
  return (
    <div style={{ padding: "13px 16px", display: "flex", alignItems: "center" }}>
      <span style={{ color: FG_DIM, fontSize: 12, fontStyle: "italic" }}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------
function SectionHeader({ label, count, warn }: { label: string; count: number; warn?: boolean }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr 1px 1fr",
      background: warn ? WARN_LIGHT : "#F1F5F9",
      borderBottom: `2px solid ${warn ? WARN_BORDER : BORDER}`,
    }}>
      <div style={{
        gridColumn: "1 / -1", padding: "7px 16px",
        fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase",
        color: warn ? WARN : FG_DIM,
      }}>
        {label} <span style={{ fontWeight: 400, opacity: 0.7 }}>({count})</span>
      </div>
    </div>
  );
}

function ColHeader({ leftLabel, rightLabel }: { leftLabel: string; rightLabel: string }) {
  const th: React.CSSProperties = {
    padding: "8px 10px", fontSize: 10, fontWeight: 700,
    letterSpacing: "0.07em", textTransform: "uppercase", color: FG_DIM,
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr", background: "#F1F5F9", borderBottom: `2px solid ${BORDER}` }}>
      <div style={th}>{leftLabel}</div>
      <div style={{ background: BORDER }} />
      <div style={{ ...th, borderLeft: `1px solid ${BORDER}` }}>{rightLabel}</div>
    </div>
  );
}

function PairRow({ left, right, warn, idx }: { left: React.ReactNode; right: React.ReactNode; warn?: boolean; idx: number }) {
  const bg = warn ? "#FFFEF7" : idx % 2 === 0 ? CARD_BG : "#F8FAFC";
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr 1px 1fr",
      background: bg, borderBottom: `1px solid ${BORDER}`,
      borderLeft: warn ? `3px solid ${WARN}` : undefined,
    }}>
      <div>{left}</div>
      <div style={{ background: BORDER }} />
      <div>{right}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function ChargesReceiptsTab({ mobile, onHasIssues }: { mobile: boolean; onHasIssues?: (v: boolean) => void }) {
  const [data, setData] = useState<ChargesReceiptsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(false);

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then((s) => {
      if (typeof s.stripeTestMode === "boolean") setTestMode(s.stripeTestMode);
    }).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/admin/reconcile/charges-receipts")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); setData(null); }
        else {
          setData(d);
          onHasIssues?.(
            (d.orphanedCharges?.length ?? 0) +
            (d.orphanedReceipts?.length ?? 0) +
            (d.orphanedRefunds?.length ?? 0) +
            (d.orphanedRefundReceipts?.length ?? 0) > 0
          );
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!data && !loading && !error) return null;

  const chargeOrphanCount = data
    ? data.orphanedCharges.length + data.orphanedReceipts.length
    : 0;
  const refundOrphanCount = data
    ? data.orphanedRefunds.length + data.orphanedRefundReceipts.length
    : 0;
  const totalOrphanCount = chargeOrphanCount + refundOrphanCount;
  const hasRefunds = data ? (data.matchedRefunds.length + data.orphanedRefunds.length + data.orphanedRefundReceipts.length) > 0 : false;

  return (
    <div style={{ padding: mobile ? "16px 12px" : "24px 20px", color: FG, background: BG, minHeight: "100%" }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: mobile ? 18 : 22, fontWeight: 700 }}>Charges &amp; Receipts</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: FG_DIM }}>
            All Stripe charges and QuickBooks receipts from the last 90 days &mdash; side by side
          </p>
        </div>
        <button onClick={load} disabled={loading}
          style={{ padding: "8px 18px", borderRadius: 6, border: "none", background: ACCENT, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Summary pills */}
      {data && !loading && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <span style={{ padding: "4px 12px", borderRadius: 4, background: CARD_BG, border: `1px solid ${BORDER}`, fontSize: 12, color: FG_MUTED }}>
            <strong style={{ color: FG }}>{totalOrphanCount}</strong> unmatched
          </span>
          <span style={{ padding: "4px 12px", borderRadius: 4, background: CARD_BG, border: `1px solid ${BORDER}`, fontSize: 12, color: FG_MUTED }}>
            <strong style={{ color: FG }}>{data.matched.length}</strong> matched charge pairs
          </span>
          {hasRefunds && (
            <span style={{ padding: "4px 12px", borderRadius: 4, background: CARD_BG, border: `1px solid ${BORDER}`, fontSize: 12, color: FG_MUTED }}>
              <strong style={{ color: FG }}>{data.matchedRefunds.length}</strong> matched refunds
            </span>
          )}
          <span style={{ padding: "4px 12px", borderRadius: 4, background: CARD_BG, border: `1px solid ${BORDER}`, fontSize: 12, color: FG_MUTED }}>
            <strong style={{ color: FG }}>{data.matched.length + data.orphanedCharges.length}</strong> Stripe charges
          </span>
          {!data.qbConnected && (
            <span style={{ padding: "4px 12px", borderRadius: 4, background: WARN_LIGHT, border: `1px solid ${WARN_BORDER}`, fontSize: 12, color: WARN }}>
              QuickBooks not connected — showing Stripe only
            </span>
          )}
        </div>
      )}

      {loading && <p style={{ textAlign: "center", padding: 40, color: FG_DIM }}>Loading…</p>}

      {error && (
        <div style={{ padding: 20, background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, color: "#DC2626", fontSize: 13 }}>
          {error}
        </div>
      )}

      {data && !loading && (
        <div style={{ overflowX: "auto" }}>

          {/* ── Charges section ── */}
          <ColHeader leftLabel="Stripe Charges" rightLabel="QuickBooks Sales Receipts" />

          {chargeOrphanCount > 0 && (
            <>
              <SectionHeader label="Unmatched — needs reconciliation" count={chargeOrphanCount} warn />
              {data.orphanedCharges.map((o, i) => (
                <PairRow key={o.charge.id} idx={i} warn
                  left={<ChargeCell charge={o.charge} payment={o.payment} testMode={testMode} orphan />}
                  right={<EmptyCell label={o.issue === "no_db_payment" ? "No database record — webhook may have been missed" : "QuickBooks receipt not written"} />}
                />
              ))}
              {data.orphanedReceipts.map((o, i) => (
                <PairRow key={o.receipt.id} idx={data.orphanedCharges.length + i} warn
                  left={<EmptyCell label="No matching Stripe charge" />}
                  right={<ReceiptCell receipt={o.receipt} payment={o.payment} orphan testMode={testMode} />}
                />
              ))}
            </>
          )}

          {data.matched.length > 0 && (
            <>
              <SectionHeader label="Matched" count={data.matched.length} />
              {data.matched.map((pair, i) => (
                <PairRow key={pair.charge.id} idx={i}
                  left={<ChargeCell charge={pair.charge} payment={pair.payment} testMode={testMode} linkedReceipt={pair.receipt} />}
                  right={<ReceiptCell receipt={pair.receipt} payment={pair.payment} testMode={testMode} />}
                />
              ))}
            </>
          )}

          {data.matched.length === 0 && chargeOrphanCount === 0 && (
            <div style={{ padding: 40, textAlign: "center", color: FG_MUTED, fontSize: 13 }}>
              No charges found in the last 90 days.
            </div>
          )}

          {/* ── Refunds section (only when there are refunds) ── */}
          {hasRefunds && (
            <div style={{ marginTop: 32 }}>
              <ColHeader leftLabel="Stripe Refunds" rightLabel="QuickBooks Refund Receipts" />

              {refundOrphanCount > 0 && (
                <>
                  <SectionHeader label="Unmatched — needs reconciliation" count={refundOrphanCount} warn />
                  {data.orphanedRefunds.map((o, i) => (
                    <PairRow key={o.refund.id} idx={i} warn
                      left={<RefundCell refund={o.refund} charge={o.charge} testMode={testMode} orphan />}
                      right={<EmptyCell label="QuickBooks refund receipt not written" />}
                    />
                  ))}
                  {data.orphanedRefundReceipts.map((o, i) => (
                    <PairRow key={o.refundReceipt.id} idx={data.orphanedRefunds.length + i} warn
                      left={<EmptyCell label="No matching Stripe refund" />}
                      right={<RefundReceiptCell refundReceipt={o.refundReceipt} testMode={testMode} orphan />}
                    />
                  ))}
                </>
              )}

              {data.matchedRefunds.length > 0 && (
                <>
                  <SectionHeader label="Matched" count={data.matchedRefunds.length} />
                  {data.matchedRefunds.map((pair, i) => (
                    <PairRow key={pair.refund.id} idx={i}
                      left={<RefundCell refund={pair.refund} charge={pair.charge} testMode={testMode} linkedRefundReceipt={pair.refundReceipt} />}
                      right={<RefundReceiptCell refundReceipt={pair.refundReceipt} testMode={testMode} />}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
