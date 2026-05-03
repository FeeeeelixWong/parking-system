"use client";

import React, { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@/types/domain";
import { useToast } from "@/app/admin/ToastContext";

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionRow = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  expectedEnd: string;
  status: "ACTIVE" | "COMPLETED" | "OVERSTAY" | "CANCELLED";
  billingStatus: "CURRENT" | "PAYMENT_FAILED" | "DELINQUENT";
  driver: { id: string; name: string; email: string | null; phone: string };
  vehicle: {
    id: string;
    unitNumber: string | null;
    licensePlate: string | null;
    type: "BOBTAIL" | "TRUCK_TRAILER";
    nickname: string | null;
  };
  spot: { id: string; label: string; type: "BOBTAIL" | "TRUCK_TRAILER" };
  payments: {
    id: string;
    type: string;
    amount: number;
    days: number | null;
    createdAt: string;
    stripePaymentIntentId?: string | null;
    stripeSubscriptionId?: string | null;
    refundedAmount?: number;
    status?: string;
  }[];
};

type Props = {
  session: SessionRow;
  settings: AppSettings | null;
  onClose: () => void;
  onSuccess: () => void;
};

type View = "menu" | "adjust" | "refund" | "cancel";

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCENT = "#2D7A4A";
const DANGER = "#DC2626";
const BORDER = "#E5E5EA";
const FG = "#1C1C1E";
const MUTED = "#636366";
const CARD_BG = "#FFFFFF";
const INPUT_BG = "#F2F2F7";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function refundablePayments(payments: SessionRow["payments"]) {
  return payments.filter(
    (p) =>
      (p.type === "CHECKIN" || p.type === "EXTENSION") &&
      (p.status === "COMPLETED" || p.status === "PARTIALLY_REFUNDED") &&
      p.stripePaymentIntentId,
  );
}

function totalPaid(payments: SessionRow["payments"]): number {
  return refundablePayments(payments).reduce((s, p) => s + p.amount - (p.refundedAmount ?? 0), 0);
}

function hasMonthly(payments: SessionRow["payments"]): boolean {
  return payments.some((p) => p.type === "MONTHLY_CHECKIN");
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

// ─── View: Adjust ─────────────────────────────────────────────────────────────

function UnitStepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const btnStyle = (disabled: boolean): React.CSSProperties => ({
    width: 36, height: 36, borderRadius: 8,
    border: `1px solid ${disabled ? BORDER : ACCENT}`,
    background: disabled ? INPUT_BG : ACCENT + "10",
    color: disabled ? MUTED : ACCENT,
    fontSize: 20, fontWeight: 700, lineHeight: "34px",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <button style={btnStyle(value <= min)} onClick={() => value > min && onChange(value - 1)}>−</button>
      <span style={{ fontSize: 28, fontWeight: 700, color: FG, minWidth: 40, textAlign: "center" }}>
        {value}
      </span>
      <button style={btnStyle(value >= max)} onClick={() => value < max && onChange(value + 1)}>+</button>
    </div>
  );
}

function AdjustView({
  session,
  onSubmit,
  actionState,
}: {
  session: SessionRow;
  settings: AppSettings | null;
  onSubmit: (effectiveEnd: Date, refundAmount: number) => void;
  actionState: "idle" | "pending" | "success" | "error";
}) {
  const startedAt = new Date(session.startedAt);
  const isMonthly = hasMonthly(session.payments);

  // ── Monthly unit accounting ───────────────────────────────────────
  const monthlyPayments = session.payments.filter(
    (p) => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL",
  );
  const origMonths = monthlyPayments.length;
  const totalMonthlyPaid = monthlyPayments.reduce(
    (s, p) => s + p.amount - (p.refundedAmount ?? 0),
    0,
  );
  const perMonthRate = origMonths > 0 ? totalMonthlyPaid / origMonths : 0;

  // ── Daily unit accounting ─────────────────────────────────────────
  const dailyPayments = session.payments.filter(
    (p) =>
      (p.type === "CHECKIN" || p.type === "EXTENSION") &&
      (p.status === "COMPLETED" || p.status === "PARTIALLY_REFUNDED"),
  );
  const origDays = dailyPayments.reduce((s, p) => s + (p.days ?? 0), 0);
  const totalDailyPaid = dailyPayments.reduce(
    (s, p) => s + p.amount - (p.refundedAmount ?? 0),
    0,
  );
  const perDayRate = origDays > 0 ? totalDailyPaid / origDays : 0;

  const origUnits = isMonthly ? origMonths : origDays;
  const perUnitRate = isMonthly ? perMonthRate : perDayRate;
  const unitLabel = isMonthly ? "month" : "day";

  const [units, setUnits] = useState(origUnits);

  const newEnd = isMonthly
    ? addMonths(startedAt, units)
    : new Date(startedAt.getTime() + units * 86400000);

  const refund = Math.max(0, Math.round((origUnits - units) * perUnitRate * 100) / 100);
  const changed = units !== origUnits;
  const canSubmit = units >= 1 && changed && actionState !== "pending";

  if (origUnits === 0) {
    return (
      <p style={{ fontSize: 13, color: MUTED, textAlign: "center", marginTop: 24 }}>
        No paid periods found for this session.
      </p>
    );
  }

  return (
    <div style={{ maxWidth: 440 }}>
      <div style={{
        background: INPUT_BG, borderRadius: 10, padding: "20px 24px", marginBottom: 24,
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>
          Paid {unitLabel}s
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <UnitStepper value={units} min={1} max={origUnits} onChange={setUnits} />
          <div style={{ fontSize: 12, color: MUTED }}>
            of {origUnits} {unitLabel}{origUnits !== 1 ? "s" : ""} originally booked
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
        <div style={{ background: INPUT_BG, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
            Session start
          </div>
          <div style={{ fontSize: 13, color: FG }}>{fmtDateTime(startedAt)}</div>
        </div>
        <div style={{ background: INPUT_BG, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
            New end
          </div>
          <div style={{ fontSize: 13, color: changed ? FG : MUTED }}>{fmtDateTime(newEnd)}</div>
        </div>
      </div>

      <div style={{
        background: INPUT_BG, borderRadius: 8, padding: "14px 16px", fontSize: 13, marginBottom: 24,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ color: MUTED }}>Rate per {unitLabel}</span>
          <span style={{ fontWeight: 600, color: FG }}>${perUnitRate.toFixed(2)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ color: MUTED }}>Removed {unitLabel}{origUnits - units !== 1 ? "s" : ""}</span>
          <span style={{ fontWeight: 600, color: FG }}>{origUnits - units}</span>
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between",
          paddingTop: 8, borderTop: `1px solid ${BORDER}`,
        }}>
          <span style={{ fontWeight: 600, color: refund > 0 ? DANGER : MUTED }}>
            {refund > 0 ? "Refund to driver" : !changed ? "No change" : "No refund"}
          </span>
          <span style={{ fontWeight: 700, color: refund > 0 ? DANGER : MUTED }}>
            {refund > 0 ? `$${refund.toFixed(2)}` : "—"}
          </span>
        </div>
      </div>

      <button
        onClick={() => canSubmit && onSubmit(newEnd, refund)}
        disabled={!canSubmit}
        style={{
          width: "100%", padding: "12px 0", borderRadius: 8, border: "none",
          background: canSubmit ? ACCENT : "#C7C7CC",
          color: "#fff", fontSize: 14, fontWeight: 600,
          cursor: canSubmit ? "pointer" : "not-allowed",
        }}
      >
        {actionState === "pending" ? "⏳ Saving…"
          : actionState === "success" ? "✅ Saved"
          : actionState === "error" ? "🔴 Retry"
          : refund > 0 ? `Apply & Refund $${refund.toFixed(2)}`
          : "Apply Adjustment"}
      </button>
    </div>
  );
}

// ─── View: Refund ─────────────────────────────────────────────────────────────

function RefundView({
  session,
  onSubmit,
  actionState,
}: {
  session: SessionRow;
  onSubmit: (amount: number, reason?: string) => void;
  actionState: "idle" | "pending" | "success" | "error";
}) {
  const paid = totalPaid(session.payments);
  const monthly = hasMonthly(session.payments);
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const partialParsed = parseFloat(amount);
  const refundAmount = mode === "full" ? paid : partialParsed;
  const valid =
    refundAmount > 0.005 &&
    (mode === "full" || (!isNaN(partialParsed) && partialParsed <= paid + 0.001));

  return (
    <div style={{ maxWidth: 480 }}>
      {monthly && (
        <div style={{
          fontSize: 11, color: "#92400E", background: "#FEF3C7",
          border: "1px solid #D97706", borderRadius: 6, padding: "8px 12px", marginBottom: 16,
        }}>
          Monthly subscription payments are excluded from refund. Only one-time charges are refundable here.
        </div>
      )}

      {paid <= 0 ? (
        <p style={{ fontSize: 13, color: MUTED, textAlign: "center", marginTop: 24 }}>No refundable payments.</p>
      ) : (
        <>
          {/* Radio toggle */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 14, color: FG }}>
              <input
                type="radio"
                name="refund-mode"
                checked={mode === "full"}
                onChange={() => setMode("full")}
                style={{ width: 16, height: 16, accentColor: ACCENT, cursor: "pointer" }}
              />
              <span>Full refund</span>
              <span style={{ marginLeft: "auto", fontWeight: 700, color: FG }}>${paid.toFixed(2)}</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 14, color: FG }}>
              <input
                type="radio"
                name="refund-mode"
                checked={mode === "partial"}
                onChange={() => setMode("partial")}
                style={{ width: 16, height: 16, accentColor: ACCENT, cursor: "pointer" }}
              />
              <span>Partial refund</span>
            </label>
          </div>

          {mode === "partial" && (
            <div style={{ position: "relative", marginBottom: 20 }}>
              <span style={{
                position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
                fontSize: 14, color: MUTED,
              }}>$</span>
              <input
                type="number"
                min="0.01"
                max={paid}
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
                style={{
                  width: "100%", padding: "9px 10px 9px 24px", fontSize: 14,
                  border: `1px solid ${BORDER}`, borderRadius: 6,
                  background: CARD_BG, color: FG, outline: "none",
                  boxSizing: "border-box",
                }}
              />
              <span style={{ fontSize: 11, color: MUTED, display: "block", marginTop: 4 }}>
                Max: ${paid.toFixed(2)}
              </span>
            </div>
          )}

          {/* Reason */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 6 }}>Reason (optional)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Driver left early"
              maxLength={200}
              style={{
                width: "100%", padding: "9px 12px", fontSize: 13,
                border: `1px solid ${BORDER}`, borderRadius: 6,
                background: CARD_BG, color: FG, outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <button
            onClick={() => valid && onSubmit(refundAmount, reason || undefined)}
            disabled={actionState === "pending" || !valid}
            style={{
              width: "100%", padding: "12px 0", borderRadius: 8, border: "none",
              background: actionState === "pending" || !valid ? "#C7C7CC" : DANGER,
              color: "#fff", fontSize: 14, fontWeight: 600,
              cursor: actionState === "pending" || !valid ? "not-allowed" : "pointer",
            }}
          >
            {actionState === "pending" ? "⏳ Refunding…"
              : actionState === "success" ? "✅ Refunded"
              : actionState === "error" ? "🔴 Retry"
              : valid ? `Issue Refund $${refundAmount.toFixed(2)}`
              : "Enter an amount"}
          </button>
        </>
      )}
    </div>
  );
}

// ─── View: Cancel (hourly) ────────────────────────────────────────────────────

function HourlyCancelView({
  session,
  onCancel,
  onBack,
  actionState,
}: {
  session: SessionRow;
  onCancel: (refundFirst: boolean, reason: string) => void;
  onBack: () => void;
  actionState: "idle" | "pending" | "success" | "error";
}) {
  const paid = totalPaid(session.payments);
  const [refundCustomer, setRefundCustomer] = useState(paid > 0);
  const [reason, setReason] = useState("");

  return (
    <div style={{ maxWidth: 480 }}>
      {/* Warning banner */}
      <div style={{
        display: "flex", gap: 10, alignItems: "flex-start",
        background: "#FEF2F2", border: "1px solid #FCA5A5",
        borderRadius: 8, padding: "12px 14px", marginBottom: 24,
      }}>
        <span style={{ fontSize: 16, lineHeight: 1.4 }}>⚠️</span>
        <div style={{ fontSize: 13, color: "#7F1D1D", lineHeight: 1.5 }}>
          <strong>This ends the session immediately.</strong> The spot will be freed and the driver will lose access.
          {session.status === "ACTIVE" && " The session is currently active."}
          {session.status === "OVERSTAY" && " The driver is currently in overstay."}
        </div>
      </div>

      {/* Refund checkbox */}
      {paid > 0 && (
        <label style={{
          display: "flex", alignItems: "center", gap: 10,
          fontSize: 14, color: FG, cursor: "pointer", marginBottom: 20,
        }}>
          <input
            type="checkbox"
            checked={refundCustomer}
            onChange={(e) => setRefundCustomer(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: ACCENT, cursor: "pointer" }}
          />
          Refund customer (${paid.toFixed(2)})
        </label>
      )}

      {/* Reason */}
      <div style={{ marginBottom: 28 }}>
        <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 6 }}>Reason (optional)</label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Parking violation, driver request"
          maxLength={200}
          style={{
            width: "100%", padding: "9px 12px", fontSize: 13,
            border: `1px solid ${BORDER}`, borderRadius: 6,
            background: CARD_BG, color: FG, outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>

      {/* Buttons */}
      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={onBack}
          style={{
            flex: 1, padding: "12px 0", borderRadius: 8,
            border: `1px solid ${BORDER}`, background: "transparent",
            color: FG, fontSize: 14, fontWeight: 500, cursor: "pointer",
          }}
        >
          Keep Session
        </button>
        <button
          onClick={() => onCancel(refundCustomer && paid > 0, reason)}
          disabled={actionState === "pending"}
          style={{
            flex: 1, padding: "12px 0", borderRadius: 8, border: "none",
            background: actionState === "pending" ? "#C7C7CC" : DANGER,
            color: "#fff", fontSize: 14, fontWeight: 600,
            cursor: actionState === "pending" ? "not-allowed" : "pointer",
          }}
        >
          {actionState === "pending" ? "⏳ Cancelling…"
            : actionState === "success" ? "✅ Cancelled"
            : actionState === "error" ? "🔴 Retry"
            : "Cancel Session"}
        </button>
      </div>
    </div>
  );
}

// ─── View: Cancel (monthly) — subscription management ─────────────────────────

const BILLING_BADGE: Record<string, { color: string; bg: string; label: string } | undefined> = {
  CURRENT:        undefined,
  PAYMENT_FAILED: { color: "#92400E", bg: "#FEF3C7", label: "Payment Failed" },
  DELINQUENT:     { color: "#7F1D1D", bg: "#FEE2E2", label: "Delinquent" },
};

function MonthlyCancelView({
  session,
  onCancel,
  actionState,
}: {
  session: SessionRow;
  onCancel: (immediately: boolean) => void;
  actionState: "idle" | "pending" | "success" | "error";
}) {
  const [confirmImmediate, setConfirmImmediate] = useState(false);

  const monthlyPayment = session.payments.find((p) => p.type === "MONTHLY_CHECKIN");
  const subscriptionId = monthlyPayment?.stripeSubscriptionId;
  const nextRenewal = new Date(session.expectedEnd);
  const bs = BILLING_BADGE[session.billingStatus ?? "CURRENT"];
  const isTerminal = session.billingStatus === "DELINQUENT" || session.status === "COMPLETED" || session.status === "CANCELLED";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 480 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, color: MUTED }}>Billing status</span>
        {bs ? (
          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 4, background: bs.bg, color: bs.color }}>
            {bs.label}
          </span>
        ) : (
          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 4, background: "#DCFCE7", color: "#166534" }}>
            Current
          </span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, color: MUTED }}>
          {isTerminal ? "Access ended" : "Access through / next renewal"}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: FG }}>{fmtDateTime(nextRenewal)}</span>
      </div>

      {subscriptionId && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, color: MUTED }}>Stripe subscription</span>
          <a
            href={`https://dashboard.stripe.com/test/subscriptions/${subscriptionId}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 13, color: ACCENT, textDecoration: "none", fontWeight: 500 }}
          >
            {subscriptionId.slice(0, 18)}… ↗
          </a>
        </div>
      )}

      {!isTerminal && subscriptionId && (
        <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 20, marginTop: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: FG, marginBottom: 14 }}>Cancel subscription</div>

          {!confirmImmediate ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                onClick={() => onCancel(false)}
                disabled={actionState === "pending"}
                style={{
                  padding: "12px 16px", borderRadius: 8, border: `1px solid ${BORDER}`,
                  background: "transparent", color: FG, fontSize: 13, cursor: actionState === "pending" ? "not-allowed" : "pointer",
                  textAlign: "left",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Cancel at period end</div>
                <div style={{ fontSize: 11, color: MUTED }}>
                  Driver keeps access until {fmtDateTime(nextRenewal)}. No future charges.
                </div>
              </button>
              <button
                onClick={() => setConfirmImmediate(true)}
                disabled={actionState === "pending"}
                style={{
                  padding: "12px 16px", borderRadius: 8, border: `1px solid ${DANGER}`,
                  background: "transparent", color: DANGER, fontSize: 13, cursor: actionState === "pending" ? "not-allowed" : "pointer",
                  textAlign: "left",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Cancel immediately</div>
                <div style={{ fontSize: 11, color: MUTED }}>
                  Access ends now. Cron will flag as overstay if driver is still on property.
                </div>
              </button>
            </div>
          ) : (
            <div style={{ background: "#FEF2F2", border: `1px solid ${DANGER}`, borderRadius: 8, padding: "16px" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#991B1B", marginBottom: 8 }}>
                Confirm immediate cancellation
              </div>
              <div style={{ fontSize: 12, color: "#7F1D1D", marginBottom: 16 }}>
                This ends the driver&apos;s access right now. If they are on property, the session will become an overstay on the next cron run.
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={() => setConfirmImmediate(false)}
                  style={{
                    flex: 1, padding: "9px 0", borderRadius: 6, border: `1px solid ${BORDER}`,
                    background: "transparent", color: FG, fontSize: 13, cursor: "pointer",
                  }}
                >
                  Go back
                </button>
                <button
                  onClick={() => { setConfirmImmediate(false); onCancel(true); }}
                  disabled={actionState === "pending"}
                  style={{
                    flex: 1, padding: "9px 0", borderRadius: 6, border: "none",
                    background: DANGER, color: "#fff", fontSize: 13, fontWeight: 600,
                    cursor: actionState === "pending" ? "not-allowed" : "pointer",
                  }}
                >
                  {actionState === "pending" ? "⏳ Canceling…"
                    : actionState === "success" ? "✅ Cancelled"
                    : actionState === "error" ? "🔴 Retry"
                    : "Yes, cancel now"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {isTerminal && (
        <div style={{ fontSize: 12, color: MUTED, textAlign: "center", paddingTop: 8 }}>
          This subscription has ended.
        </div>
      )}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export default function ManageSessionModal({ session, settings, onClose, onSuccess }: Props) {
  const [view, setView] = useState<View>("menu");
  const [actionState, setActionState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const { addToast } = useToast();
  const isMonthly = hasMonthly(session.payments);
  const paid = totalPaid(session.payments);

  function goBack() {
    setView("menu");
    setActionState("idle");
    setActionError(null);
  }

  async function callAdjust(effectiveEnd?: Date, refundAmount?: number) {
    setActionState("pending");
    setActionError(null);
    try {
      const body: Record<string, unknown> = { sessionId: session.id, action: "adjust" };
      if (effectiveEnd) body.effectiveEnd = effectiveEnd.toISOString();
      if (refundAmount && refundAmount > 0.005) body.refundAmount = refundAmount;

      const res = await fetch("/api/admin/sessions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Request failed");
      }
      if (!mountedRef.current) return;
      setActionState("success");
      addToast({
        type: "success",
        message: refundAmount && refundAmount > 0.005
          ? `Session adjusted · Stripe refund of $${refundAmount.toFixed(2)} issued`
          : "Session end time adjusted",
      });
      await new Promise((r) => setTimeout(r, 600));
      onSuccess();
      onClose();
    } catch (e) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setActionError(msg);
      setActionState("error");
      addToast({ type: "error", message: `Adjustment failed · ${msg}` });
    }
  }

  async function callRefund(amount: number, reason?: string) {
    setActionState("pending");
    setActionError(null);
    try {
      const body: Record<string, unknown> = { sessionId: session.id, action: "adjust", refundAmount: amount };
      if (reason) body.reason = reason;
      const res = await fetch("/api/admin/sessions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Request failed");
      }
      if (!mountedRef.current) return;
      setActionState("success");
      addToast({ type: "success", message: `Refund of $${amount.toFixed(2)} issued · Stripe processed` });
      await new Promise((r) => setTimeout(r, 600));
      onSuccess();
      onClose();
    } catch (e) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setActionError(msg);
      setActionState("error");
      addToast({ type: "error", message: `Refund failed · ${msg}` });
    }
  }

  async function callCancel(refundFirst: boolean, reason: string) {
    setActionState("pending");
    setActionError(null);
    try {
      if (refundFirst && paid > 0) {
        const res = await fetch("/api/admin/sessions", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.id, action: "adjust", refundAmount: paid }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(`Refund failed: ${j.error || "Unknown error"}`);
        }
      }
      const res = await fetch("/api/admin/sessions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, action: "cancel", reason: reason || "Admin cancelled" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Cancel failed");
      }
      if (!mountedRef.current) return;
      setActionState("success");
      addToast({
        type: "success",
        message: refundFirst && paid > 0
          ? `Session cancelled · Stripe refund of $${paid.toFixed(2)} issued`
          : "Session cancelled",
      });
      await new Promise((r) => setTimeout(r, 600));
      onSuccess();
      onClose();
    } catch (e) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setActionError(msg);
      setActionState("error");
      addToast({ type: "error", message: `Cancellation failed · ${msg}` });
    }
  }

  async function callCancelSubscription(immediately: boolean) {
    setActionState("pending");
    setActionError(null);
    try {
      const res = await fetch("/api/admin/sessions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, action: "cancel-subscription", cancelImmediately: immediately }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Request failed");
      }
      if (!mountedRef.current) return;
      setActionState("success");
      addToast({
        type: "success",
        message: immediately
          ? "Subscription cancelled immediately · Stripe updated"
          : "Subscription set to cancel at period end · Stripe updated",
      });
      await new Promise((r) => setTimeout(r, 600));
      onSuccess();
      onClose();
    } catch (e) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setActionError(msg);
      setActionState("error");
      addToast({ type: "error", message: `Cancellation failed · ${msg}` });
    }
  }

  const VIEW_TITLE: Record<Exclude<View, "menu">, string> = {
    adjust: "Adjust Session",
    refund: "Issue Refund",
    cancel: isMonthly ? "Cancel Subscription" : "Cancel Session",
  };

  const overlayStyle: React.CSSProperties = {
    position: "fixed", inset: 0, zIndex: 200,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(0,0,0,0.4)",
  };

  const errorBanner = actionError && (
    <div style={{
      fontSize: 11, color: "#991B1B", background: "#FEE2E2",
      border: "1px solid #DC2626", borderRadius: 6, padding: "8px 12px", marginBottom: 16,
    }}>
      {actionError}
    </div>
  );

  // ── Menu view ────────────────────────────────────────────────────────────────
  if (view === "menu") {
    return (
      <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div style={{
          background: CARD_BG, borderRadius: 12, width: 320,
          overflow: "hidden", fontFamily: "var(--font-body)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.18)",
        }}>
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "flex-start", justifyContent: "space-between",
            padding: "14px 16px", borderBottom: `1px solid ${BORDER}`,
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: FG }}>Manage Session</div>
              <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                {session.driver.name} · {session.spot.label}
              </div>
            </div>
            <button
              onClick={onClose}
              style={{ background: "transparent", border: "none", fontSize: 18, color: MUTED, cursor: "pointer", lineHeight: 1, padding: "0 4px" }}
            >
              &times;
            </button>
          </div>

          {/* Menu items */}
          <div style={{ padding: "6px 0" }}>
            <MenuRow icon="✏️" label="Adjust session" onClick={() => setView("adjust")} />
            {paid > 0 && <MenuRow icon="💸" label="Issue refund" onClick={() => setView("refund")} />}
            <MenuRow icon="🚫" label="Cancel session" onClick={() => setView("cancel")} danger />
          </div>
        </div>
      </div>
    );
  }

  // ── Full-size focused views ───────────────────────────────────────────────────
  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: CARD_BG, borderRadius: 12,
        width: "calc(100vw - 32px)", maxWidth: 720,
        maxHeight: "calc(100vh - 32px)", overflow: "hidden",
        display: "flex", flexDirection: "column",
        fontFamily: "var(--font-body)",
        boxShadow: "0 16px 48px rgba(0,0,0,0.18)",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", borderBottom: `1px solid ${BORDER}`, flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={goBack}
              style={{
                background: "transparent", border: "none", fontSize: 12,
                color: ACCENT, cursor: "pointer", padding: "4px 6px",
                fontFamily: "var(--font-body)", display: "flex", alignItems: "center", gap: 4,
                borderRadius: 4,
              }}
            >
              ← Back
            </button>
            <div style={{ width: 1, height: 18, background: BORDER }} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: FG }}>
                {VIEW_TITLE[view as Exclude<View, "menu">]} — {session.spot.label}
              </div>
              <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                {session.driver.name} · {session.vehicle.type === "TRUCK_TRAILER" ? "Truck + Trailer" : "Bobtail"}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", fontSize: 20, color: MUTED, cursor: "pointer", lineHeight: 1, padding: "0 4px" }}
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
          {errorBanner}

          {view === "adjust" && (
            <AdjustView
              session={session}
              settings={settings}
              onSubmit={(end, refund) => callAdjust(end, refund)}
              actionState={actionState}
            />
          )}

          {view === "refund" && (
            <RefundView
              session={session}
              onSubmit={callRefund}
              actionState={actionState}
            />
          )}

          {view === "cancel" && isMonthly && (
            <MonthlyCancelView
              session={session}
              onCancel={callCancelSubscription}
              actionState={actionState}
            />
          )}

          {view === "cancel" && !isMonthly && (
            <HourlyCancelView
              session={session}
              onCancel={callCancel}
              onBack={goBack}
              actionState={actionState}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Menu row item ────────────────────────────────────────────────────────────

function MenuRow({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10,
        padding: "12px 16px", background: hovered ? (danger ? "#FEF2F2" : INPUT_BG) : "transparent",
        border: "none", cursor: "pointer", fontFamily: "var(--font-body)",
        textAlign: "left",
      }}
    >
      <span style={{ fontSize: 15, lineHeight: 1, minWidth: 20, textAlign: "center" }}>{icon}</span>
      <span style={{ fontSize: 13, fontWeight: 500, color: danger ? DANGER : FG, flex: 1 }}>{label}</span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={danger ? DANGER : MUTED} strokeWidth="1.5" strokeLinecap="round">
        <path d="M6 3l5 5-5 5" />
      </svg>
    </button>
  );
}
