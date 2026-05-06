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

function alreadyRefunded(payments: SessionRow["payments"]): number {
  return refundablePayments(payments).reduce((s, p) => s + (p.refundedAmount ?? 0), 0);
}

function totalPaidGross(payments: SessionRow["payments"]): number {
  return refundablePayments(payments).reduce((s, p) => s + p.amount, 0);
}

// ─── Shared: RefundChoice ─────────────────────────────────────────────────────
//
// Single component for refund disposition used by both Adjust and Cancel flows.
// The parent owns option state + custom string and computes the final amount via
// computeRefundAmount(); this component only renders.

type RefundOption = "none" | "unused_time" | "full" | "custom";

function computeRefundAmount(
  selected: RefundOption,
  refundable: number,
  unused: number,
  customStr: string,
): number {
  const round = (n: number) => Math.round(n * 100) / 100;
  switch (selected) {
    case "none": return 0;
    case "unused_time": return round(Math.max(0, Math.min(unused, refundable)));
    case "full": return round(refundable);
    case "custom": {
      const n = parseFloat(customStr);
      if (isNaN(n) || n <= 0) return 0;
      return round(Math.min(n, refundable));
    }
  }
}

function customAmountValid(customStr: string, refundable: number): boolean {
  const n = parseFloat(customStr);
  return !isNaN(n) && n > 0.005 && n <= refundable + 0.001;
}

function RefundRadioRow({
  value,
  label,
  amountStr,
  disabled,
  rightExtra,
  selected,
  onSelectedChange,
}: {
  value: RefundOption;
  label: string;
  amountStr?: string;
  disabled?: boolean;
  rightExtra?: React.ReactNode;
  selected: RefundOption;
  onSelectedChange: (o: RefundOption) => void;
}) {
  const active = selected === value;
  return (
    <label
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 10px", borderRadius: 6,
        background: active ? ACCENT + "10" : "transparent",
        border: `1px solid ${active ? ACCENT : BORDER}`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontSize: 13, color: FG,
      }}
    >
      <input
        type="radio"
        name="refund-choice"
        checked={active}
        disabled={disabled}
        onChange={() => !disabled && onSelectedChange(value)}
        style={{ width: 14, height: 14, accentColor: ACCENT, cursor: disabled ? "not-allowed" : "pointer" }}
      />
      <span style={{ flex: 1 }}>{label}</span>
      {amountStr && <span style={{ fontWeight: 600 }}>{amountStr}</span>}
      {rightExtra}
    </label>
  );
}

function RefundChoice({
  totalPaid: total,
  refunded,
  refundable,
  unused,
  selected,
  onSelectedChange,
  customAmount,
  onCustomChange,
}: {
  totalPaid: number;
  refunded: number;
  refundable: number;
  unused: number;
  selected: RefundOption;
  onSelectedChange: (o: RefundOption) => void;
  customAmount: string;
  onCustomChange: (s: string) => void;
}) {
  const refundableZero = refundable < 0.005;
  const unusedZero = unused < 0.005;
  const customInvalid = selected === "custom" && customAmount !== "" && !customAmountValid(customAmount, refundable);

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
        Refund
      </div>

      {/* Summary bar */}
      <div style={{
        background: INPUT_BG, borderRadius: 8, padding: "10px 12px", marginBottom: 12,
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 11,
      }}>
        <div>
          <div style={{ color: MUTED }}>Total paid</div>
          <div style={{ fontWeight: 600, color: FG, fontSize: 13 }}>${total.toFixed(2)}</div>
        </div>
        <div>
          <div style={{ color: MUTED }}>Already refunded</div>
          <div style={{ fontWeight: 600, color: FG, fontSize: 13 }}>${refunded.toFixed(2)}</div>
        </div>
        <div>
          <div style={{ color: MUTED }}>Refundable</div>
          <div style={{ fontWeight: 700, color: refundable > 0 ? ACCENT : MUTED, fontSize: 13 }}>${refundable.toFixed(2)}</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <RefundRadioRow value="none" label="No refund" amountStr="$0.00"
          selected={selected} onSelectedChange={onSelectedChange} />
        <RefundRadioRow
          value="unused_time"
          label="Refund unused time"
          amountStr={`$${Math.max(0, Math.min(unused, refundable)).toFixed(2)}`}
          disabled={refundableZero || unusedZero}
          selected={selected} onSelectedChange={onSelectedChange}
        />
        <RefundRadioRow
          value="full"
          label="Full refund (refundable balance)"
          amountStr={`$${refundable.toFixed(2)}`}
          disabled={refundableZero}
          selected={selected} onSelectedChange={onSelectedChange}
        />
        <RefundRadioRow
          value="custom"
          label="Custom refund"
          disabled={refundableZero}
          selected={selected} onSelectedChange={onSelectedChange}
          rightExtra={
            selected === "custom" ? (
              <span style={{ position: "relative", display: "inline-block", width: 100 }} onClick={(e) => e.preventDefault()}>
                <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: MUTED }}>$</span>
                <input
                  type="number"
                  min="0.01"
                  max={refundable}
                  step="0.01"
                  value={customAmount}
                  onChange={(e) => onCustomChange(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="0.00"
                  autoFocus
                  style={{
                    width: "100%", padding: "5px 6px 5px 18px", fontSize: 12,
                    border: `1px solid ${customInvalid ? DANGER : BORDER}`, borderRadius: 4,
                    background: CARD_BG, color: FG, outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </span>
            ) : null
          }
        />
      </div>

      {customInvalid && (
        <div style={{ fontSize: 11, color: DANGER, marginTop: 6 }}>
          Custom amount must be between $0.01 and ${refundable.toFixed(2)}.
        </div>
      )}
    </div>
  );
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
  onSubmit: (effectiveEnd: Date, refundAmount: number, reason: string) => void;
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

  // ── Refund disposition (daily only — monthly Adjust changes paid-through
  //     date but does not stop the subscription, so refunds belong in Cancel
  //     Session, not here, to prevent over/under-refund vs. future renewals.)
  const refundable = isMonthly ? 0 : totalPaid(session.payments);
  const refunded = isMonthly ? 0 : alreadyRefunded(session.payments);
  const totalPaidVal = isMonthly ? 0 : totalPaidGross(session.payments);
  const unusedRaw = isMonthly
    ? 0
    : Math.max(0, Math.round((origUnits - units) * perUnitRate * 100) / 100);
  const unused = Math.min(unusedRaw, refundable);

  const [refundOpt, setRefundOpt] = useState<RefundOption>(() =>
    unusedRaw > 0 && refundable > 0 ? "unused_time" : "none",
  );
  const [customAmount, setCustomAmount] = useState("");
  const [reason, setReason] = useState("");

  const newEnd = isMonthly
    ? addMonths(startedAt, units)
    : new Date(startedAt.getTime() + units * 86400000);

  const refund = computeRefundAmount(refundOpt, refundable, unused, customAmount);
  const shortening = units < origUnits;
  const changed = units !== origUnits;

  // Reason required when:
  //  - admin chose "custom" refund
  //  - shortening with unused>0 but selected "none" (intentionally keeping money)
  const reasonRequired =
    refundOpt === "custom" || (shortening && refundOpt === "none" && unused > 0.005);
  const customValid = refundOpt !== "custom" || customAmountValid(customAmount, refundable);

  const canSubmit =
    units >= 1 && changed && actionState !== "pending" &&
    customValid && (!reasonRequired || reason.trim().length > 0);

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
        background: INPUT_BG, borderRadius: 8, padding: "12px 14px", fontSize: 12, marginBottom: 20,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: MUTED }}>Rate per {unitLabel}</span>
          <span style={{ fontWeight: 600, color: FG }}>${perUnitRate.toFixed(2)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{ color: MUTED }}>Removed {unitLabel}{origUnits - units !== 1 ? "s" : ""}</span>
          <span style={{ fontWeight: 600, color: FG }}>{origUnits - units}</span>
        </div>
      </div>

      {/* Monthly shortening: no refund here — direct admin to Cancel Session. */}
      {shortening && isMonthly && (
        <div style={{
          fontSize: 12, color: "#92400E", background: "#FEF3C7",
          border: "1px solid #D97706", borderRadius: 6, padding: "10px 12px",
          marginBottom: 16, lineHeight: 1.5,
        }}>
          <strong>Heads up:</strong> this changes the paid-through date only. The Stripe subscription will still renew on its current schedule, so no refund is offered here. To stop future billing or refund the driver, use <strong>Cancel Session</strong>.
        </div>
      )}

      {/* Daily shortening: full refund disposition. */}
      {shortening && !isMonthly && (
        <RefundChoice
          totalPaid={totalPaidVal}
          refunded={refunded}
          refundable={refundable}
          unused={unused}
          selected={refundOpt}
          onSelectedChange={setRefundOpt}
          customAmount={customAmount}
          onCustomChange={setCustomAmount}
        />
      )}

      {reasonRequired && (
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
            Reason <span style={{ color: DANGER }}>*</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={refundOpt === "none"
              ? "Why keep the unused-time payment?"
              : "Reason for custom refund amount"}
            rows={2}
            style={{
              width: "100%", padding: "8px 10px", fontSize: 13,
              border: `1px solid ${BORDER}`, borderRadius: 6,
              background: CARD_BG, color: FG, outline: "none",
              resize: "vertical", fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
        </div>
      )}

      <button
        onClick={() => canSubmit && onSubmit(newEnd, refund, reason.trim())}
        disabled={!canSubmit}
        style={{
          width: "100%", padding: "12px 0", borderRadius: 8, border: "none",
          background: canSubmit ? ACCENT : "#C7C7CC",
          color: "#fff", fontSize: 14, fontWeight: 600,
          cursor: canSubmit ? "pointer" : "not-allowed",
        }}
      >
        {(() => {
          if (actionState === "pending") return "Saving…";
          if (actionState === "success") return "Saved";
          if (actionState === "error") return "Retry";
          const noun = isMonthly ? "Adjust Paid-Through Date" : "Adjust Time";
          return refund > 0
            ? `${noun} With $${refund.toFixed(2)} Refund`
            : `${noun} Without Refund`;
        })()}
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
            {actionState === "pending" ? "Refunding…"
              : actionState === "success" ? "Refunded"
              : actionState === "error" ? "Retry"
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
  onCancel: (refundAmount: number, reason: string) => void;
  onBack: () => void;
  actionState: "idle" | "pending" | "success" | "error";
}) {
  const startedAt = new Date(session.startedAt);

  // ── Refund accounting (daily payments only) ──────────────────────
  const refundable = totalPaid(session.payments);
  const refunded = alreadyRefunded(session.payments);
  const totalPaidVal = totalPaidGross(session.payments);

  // Unused-time = paid days - days elapsed since startedAt (ceil), times per-day rate.
  // Snapshot the elapsed-day count once at mount so the radio amount is stable while
  // the modal is open (and to satisfy react-hooks/purity for Date.now()).
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
  const [elapsedDays] = useState(() =>
    Math.max(0, Math.ceil((Date.now() - startedAt.getTime()) / 86400000)),
  );
  const unusedDays = Math.max(0, origDays - elapsedDays);
  const unusedRaw = Math.round(unusedDays * perDayRate * 100) / 100;
  const unused = Math.min(unusedRaw, refundable);

  const [refundOpt, setRefundOpt] = useState<RefundOption>(() =>
    unused > 0 && refundable > 0 ? "unused_time" : "none",
  );
  const [customAmount, setCustomAmount] = useState("");
  const [reason, setReason] = useState("");

  const refund = computeRefundAmount(refundOpt, refundable, unused, customAmount);

  // Reason rules: required when no-refund-but-money-left, or custom
  const reasonRequired =
    refundOpt === "custom" || (refundOpt === "none" && refundable > 0.005);
  const customValid = refundOpt !== "custom" || customAmountValid(customAmount, refundable);

  const canSubmit =
    actionState !== "pending" && customValid &&
    (!reasonRequired || reason.trim().length > 0);

  // TODO: future backend should accept (cancel + refundDisposition) as a single
  // command so reconcile can persistently distinguish "kept payment intentionally"
  // from "missed refund". Currently the parent issues adjust(refundAmount) then
  // cancel sequentially, with refund-first ordering for atomicity.

  return (
    <div style={{ maxWidth: 480 }}>
      {/* Warning banner */}
      <div style={{
        display: "flex", gap: 10, alignItems: "flex-start",
        background: "#FEF2F2", border: "1px solid #FCA5A5",
        borderRadius: 8, padding: "12px 14px", marginBottom: 24,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.4, color: "#7F1D1D" }}>!</span>
        <div style={{ fontSize: 13, color: "#7F1D1D", lineHeight: 1.5 }}>
          <strong>This ends the session immediately.</strong> The spot will be freed and the driver will lose access.
          {session.status === "ACTIVE" && " The session is currently active."}
          {session.status === "OVERSTAY" && " The driver is currently in overstay."}
        </div>
      </div>

      <RefundChoice
        totalPaid={totalPaidVal}
        refunded={refunded}
        refundable={refundable}
        unused={unused}
        selected={refundOpt}
        onSelectedChange={setRefundOpt}
        customAmount={customAmount}
        onCustomChange={setCustomAmount}
      />

      {/* Warn when admin is intentionally keeping money */}
      {refundOpt === "none" && refundable > 0.005 && (
        <div style={{
          fontSize: 12, color: "#7F1D1D", background: "#FEF2F2",
          border: "1px solid #FCA5A5", borderRadius: 6, padding: "8px 12px",
          marginBottom: 16, marginTop: -4,
        }}>
          ${refundable.toFixed(2)} of collected payment will not be refunded. Confirm this is intentional.
        </div>
      )}

      {/* Reason */}
      <div style={{ marginBottom: 24 }}>
        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
          Reason {reasonRequired ? <span style={{ color: DANGER }}>*</span> : "(optional)"}
        </label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={refundOpt === "none" && refundable > 0.005
            ? "Why keep the collected payment?"
            : refundOpt === "custom"
              ? "Reason for custom refund amount"
              : "e.g. parking violation, driver request"}
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
          onClick={() => canSubmit && onCancel(refund, reason.trim())}
          disabled={!canSubmit}
          style={{
            flex: 1, padding: "12px 0", borderRadius: 8, border: "none",
            background: canSubmit ? DANGER : "#C7C7CC",
            color: "#fff", fontSize: 14, fontWeight: 600,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          {actionState === "pending" ? "Cancelling…"
            : actionState === "success" ? "Cancelled"
            : actionState === "error" ? "Retry"
            : refund > 0 ? `Cancel Session With $${refund.toFixed(2)} Refund`
            : "Cancel Session Without Refund"}
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

type MonthlyAccessOption = "period_end" | "now" | "custom";

export type MonthlyCancelPayload = {
  accessEndsAt: "period_end" | "now" | string; // ISO when custom
  refund: { mode: RefundOption; amount?: number };
  reason: string;
};

function MonthlyCancelView({
  session,
  onCancel,
  actionState,
}: {
  session: SessionRow;
  onCancel: (payload: MonthlyCancelPayload) => void;
  actionState: "idle" | "pending" | "success" | "error";
}) {
  const [accessOpt, setAccessOpt] = useState<MonthlyAccessOption | null>(null);
  const [customDateStr, setCustomDateStr] = useState("");
  const [refundOpt, setRefundOpt] = useState<RefundOption>("none");
  const [customAmount, setCustomAmount] = useState("");
  const [reason, setReason] = useState("");

  const monthlyPayment = session.payments.find((p) => p.type === "MONTHLY_CHECKIN");
  const subscriptionId = monthlyPayment?.stripeSubscriptionId;
  const nextRenewal = new Date(session.expectedEnd);
  const startedAt = new Date(session.startedAt);
  const bs = BILLING_BADGE[session.billingStatus ?? "CURRENT"];
  const isTerminal = session.billingStatus === "DELINQUENT" || session.status === "COMPLETED" || session.status === "CANCELLED";

  // ── Refund accounting (current billing period only) ────────────────────
  // "Current period" = the most recent MONTHLY_CHECKIN or MONTHLY_RENEWAL payment.
  // Full or unused-time refunds are scoped to this period only — prior periods
  // are already reconciled and are not refundable here.
  // TODO: once Session.cancellationDisposition exists, surface prior-period
  //       payment history separately for historical auditing.
  const currentPeriodPayment = session.payments
    .filter(
      (p) =>
        (p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL") &&
        (p.status === "COMPLETED" || p.status === "PARTIALLY_REFUNDED") &&
        p.stripePaymentIntentId,
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;

  const refundable = currentPeriodPayment
    ? Math.max(0, currentPeriodPayment.amount - (currentPeriodPayment.refundedAmount ?? 0))
    : 0;
  const refunded = currentPeriodPayment?.refundedAmount ?? 0;
  const totalPaidVal = currentPeriodPayment?.amount ?? 0;

  // Day-prorated unused-time. The paid window runs from the current period's
  // payment date → expectedEnd (the next renewal boundary).
  // Snapshot `now` once so the radio amount doesn't drift while the modal is open.
  const [now] = useState(() => new Date());
  const periodStart = currentPeriodPayment ? new Date(currentPeriodPayment.createdAt) : startedAt;
  const paidWindowMs = Math.max(1, nextRenewal.getTime() - periodStart.getTime());
  const perMsRate = refundable / paidWindowMs;

  // ── Compute unused for the *currently selected* access option ───────────
  // - period_end: no refund permitted at all
  // - now: time remaining from now → expectedEnd
  // - custom: time remaining from customDate → expectedEnd
  const customDate = (() => {
    if (!customDateStr) return null;
    const d = new Date(customDateStr);
    return isNaN(d.getTime()) ? null : d;
  })();
  const customDateValid =
    customDate != null &&
    customDate > startedAt &&
    customDate <= nextRenewal;
  // Custom date equal to nextRenewal collapses to period-end semantics: nothing
  // to refund (entire paid window consumed). Lock disposition to "none".
  const customEqualsRenewal =
    customDate != null && customDate.getTime() === nextRenewal.getTime();

  const unused = (() => {
    if (accessOpt === "now") {
      const u = Math.max(0, nextRenewal.getTime() - now.getTime()) * perMsRate;
      return Math.min(Math.round(u * 100) / 100, refundable);
    }
    if (accessOpt === "custom" && customDate && !customEqualsRenewal) {
      const u = Math.max(0, nextRenewal.getTime() - customDate.getTime()) * perMsRate;
      return Math.min(Math.round(u * 100) / 100, refundable);
    }
    return 0;
  })();

  // Effective refund disposition: when custom date equals nextRenewal, treat
  // disposition as "none" regardless of the radio. Prevents Full/Custom from
  // refunding the full balance for time that was already consumed.
  const effectiveRefundOpt: RefundOption = customEqualsRenewal ? "none" : refundOpt;
  const refundAmount = computeRefundAmount(effectiveRefundOpt, refundable, unused, customAmount);
  const refundAllowed =
    (accessOpt === "now" || accessOpt === "custom") && !customEqualsRenewal;
  const customRefundValid = effectiveRefundOpt !== "custom" || customAmountValid(customAmount, refundable);

  // Reason rules (rule 6, monthly-scoped):
  //   - always required when an option is selected
  //   - text in placeholder shifts based on disposition
  const reasonValid = reason.trim().length > 0;

  const canSubmit =
    accessOpt != null &&
    actionState !== "pending" &&
    reasonValid &&
    customRefundValid &&
    (accessOpt !== "custom" || customDateValid);

  const stripeEffect =
    accessOpt === "period_end" ? `Stripe billing stops at period end (${fmtDateTime(nextRenewal)})`
    : accessOpt === "now" ? "Stripe billing stops now"
    : accessOpt === "custom" ? "Stripe billing stops now"
    : "—";
  const accessEffect =
    accessOpt === "period_end" ? `Parking access remains until ${fmtDateTime(nextRenewal)}`
    : accessOpt === "now" ? "Parking access ends now"
    : accessOpt === "custom" && customDate
      ? `Parking access remains until ${fmtDateTime(customDate)}`
      : "—";
  const refundEffect =
    !refundAllowed ? "none (not applicable)"
    : refundAmount > 0.005 ? `$${refundAmount.toFixed(2)}`
    : "none";

  function submit() {
    if (!canSubmit || !accessOpt) return;
    const accessEndsAt: MonthlyCancelPayload["accessEndsAt"] =
      accessOpt === "custom" ? customDate!.toISOString()
      : accessOpt; // "period_end" | "now"
    onCancel({
      accessEndsAt,
      refund: {
        mode: refundAllowed ? effectiveRefundOpt : "none",
        amount: effectiveRefundOpt === "custom" ? refundAmount : undefined,
      },
      reason: reason.trim(),
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 520 }}>
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
          {isTerminal ? "Access ended" : "Paid through / next renewal"}
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

      {isTerminal && (
        <div style={{ fontSize: 12, color: MUTED, textAlign: "center", paddingTop: 8 }}>
          This subscription has ended.
        </div>
      )}

      {!isTerminal && subscriptionId && (
        <>
          <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
              Access end
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <AccessOption
                value="period_end"
                title="Cancel renewal at period end"
                detail={`Driver keeps access until ${fmtDateTime(nextRenewal)}. No future charges. No refund.`}
                selected={accessOpt}
                onSelect={(o) => { setAccessOpt(o); setRefundOpt("none"); }}
              />
              <AccessOption
                value="now"
                title="Cancel access now"
                detail="Stripe subscription cancelled immediately. Session ends now. Refund disposition required."
                danger
                selected={accessOpt}
                onSelect={setAccessOpt}
              />
              <AccessOption
                value="custom"
                title="Cancel access at custom date"
                detail="Stripe billing stops now. Parking access remains until chosen date. Refund covers the time between that date and current paid-through."
                danger
                selected={accessOpt}
                onSelect={setAccessOpt}
              />
            </div>
          </div>

          {accessOpt === "custom" && (
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                Access end date <span style={{ color: DANGER }}>*</span>
              </label>
              <input
                type="datetime-local"
                value={customDateStr}
                onChange={(e) => setCustomDateStr(e.target.value)}
                style={{
                  width: "100%", padding: "8px 10px", fontSize: 13,
                  border: `1px solid ${customDate && !customDateValid ? DANGER : BORDER}`,
                  borderRadius: 6, background: CARD_BG, color: FG, outline: "none",
                  boxSizing: "border-box",
                }}
              />
              {customDate && !customDateValid && (
                <div style={{ fontSize: 11, color: DANGER, marginTop: 4 }}>
                  Must be after session start ({fmtDateTime(startedAt)}) and on/before {fmtDateTime(nextRenewal)}. Use Adjust Time to extend.
                </div>
              )}
            </div>
          )}

          {refundAllowed && (
            <RefundChoice
              totalPaid={totalPaidVal}
              refunded={refunded}
              refundable={refundable}
              unused={unused}
              selected={refundOpt}
              onSelectedChange={setRefundOpt}
              customAmount={customAmount}
              onCustomChange={setCustomAmount}
            />
          )}

          {refundAllowed && effectiveRefundOpt === "none" && refundable > 0.005 && (
            <div style={{
              fontSize: 12, color: "#7F1D1D", background: "#FEF2F2",
              border: "1px solid #FCA5A5", borderRadius: 6, padding: "8px 12px",
            }}>
              ${refundable.toFixed(2)} of collected payment will not be refunded. Confirm this is intentional.
            </div>
          )}

          {accessOpt === "custom" && customEqualsRenewal && (
            <div style={{
              fontSize: 12, color: "#92400E", background: "#FEF3C7",
              border: "1px solid #D97706", borderRadius: 6, padding: "8px 12px",
            }}>
              Chosen date equals the current paid-through date — no refund applies (the entire paid window is consumed).
            </div>
          )}

          {accessOpt && (
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                Reason <span style={{ color: DANGER }}>*</span>
              </label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  accessOpt === "period_end" ? "Why cancel renewal?"
                  : refundOpt === "none" && refundable > 0.005 ? "Why keep the collected payment?"
                  : refundOpt === "custom" ? "Reason for custom refund amount"
                  : "Why cancel access now?"
                }
                maxLength={200}
                style={{
                  width: "100%", padding: "9px 12px", fontSize: 13,
                  border: `1px solid ${BORDER}`, borderRadius: 6,
                  background: CARD_BG, color: FG, outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}

          {/* Effects summary — explicit, hard-to-misread */}
          {accessOpt && (
            <div style={{
              background: INPUT_BG, borderRadius: 8, padding: "12px 14px", fontSize: 12,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                Effects
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 4, columnGap: 12 }}>
                <span style={{ color: MUTED }}>Stripe subscription</span><span style={{ color: FG }}>{stripeEffect}</span>
                <span style={{ color: MUTED }}>Session access</span><span style={{ color: FG }}>{accessEffect}</span>
                <span style={{ color: MUTED }}>Refund</span><span style={{ color: refundAmount > 0.005 ? DANGER : FG, fontWeight: refundAmount > 0.005 ? 700 : 400 }}>{refundEffect}</span>
              </div>
            </div>
          )}

          <button
            onClick={submit}
            disabled={!canSubmit}
            style={{
              padding: "12px 0", borderRadius: 8, border: "none",
              background: !canSubmit ? "#C7C7CC"
                : accessOpt === "period_end" ? ACCENT
                : DANGER,
              color: "#fff", fontSize: 14, fontWeight: 600,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {actionState === "pending" ? "Cancelling…"
              : actionState === "success" ? "Cancelled"
              : actionState === "error" ? "Retry"
              : accessOpt === "period_end" ? "Cancel Renewal At Period End"
              : refundAmount > 0.005 ? `Cancel Session With $${refundAmount.toFixed(2)} Refund`
              : "Cancel Session Without Refund"}
          </button>
        </>
      )}
    </div>
  );
}

function AccessOption({
  value,
  title,
  detail,
  selected,
  onSelect,
  danger,
}: {
  value: MonthlyAccessOption;
  title: string;
  detail: string;
  selected: MonthlyAccessOption | null;
  onSelect: (o: MonthlyAccessOption) => void;
  danger?: boolean;
}) {
  const active = selected === value;
  const accent = danger ? DANGER : ACCENT;
  return (
    <button
      onClick={() => onSelect(value)}
      style={{
        padding: "12px 14px", borderRadius: 8,
        border: `1px solid ${active ? accent : BORDER}`,
        background: active ? accent + "10" : "transparent",
        color: FG, fontSize: 13, cursor: "pointer", textAlign: "left",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 3, color: active ? accent : FG }}>{title}</div>
      <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.5 }}>{detail}</div>
    </button>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export default function ManageSessionModal({ session, settings, onClose, onSuccess }: Props) {
  const [view, setView] = useState<View>("menu");
  const [actionState, setActionState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const { addToast } = useToast();
  const isMonthly = hasMonthly(session.payments);
  const paid = totalPaid(session.payments);

  function goBack() {
    setView("menu");
    setActionState("idle");
    setActionError(null);
  }

  async function callAdjust(effectiveEnd?: Date, refundAmount?: number, reason?: string) {
    setActionState("pending");
    setActionError(null);
    try {
      const body: Record<string, unknown> = { sessionId: session.id, action: "adjust" };
      if (effectiveEnd) body.effectiveEnd = effectiveEnd.toISOString();
      if (refundAmount && refundAmount > 0.005) body.refundAmount = refundAmount;
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

  async function callCancel(refundAmount: number, reason: string) {
    // TODO: a future single-command "cancel-with-refund-disposition" endpoint
    // would let reconcile distinguish "kept payment intentionally" from
    // "missed refund". Today we issue the refund first (so a Stripe failure
    // leaves the session untouched), then mark CANCELLED.
    setActionState("pending");
    setActionError(null);
    try {
      if (refundAmount > 0.005) {
        const res = await fetch("/api/admin/sessions", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.id, action: "adjust", refundAmount, ...(reason ? { reason } : {}) }),
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
        message: refundAmount > 0.005
          ? `Session cancelled · Stripe refund of $${refundAmount.toFixed(2)} issued`
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

  async function callCancelMonthlySession(payload: MonthlyCancelPayload) {
    // Single atomic backend command — refund + Stripe sub action + session update
    // happen server-side in a fixed order, with each step gated on the prior step's
    // success. See cancel-monthly-session in src/app/api/admin/sessions/route.ts.
    setActionState("pending");
    setActionError(null);
    try {
      const res = await fetch("/api/admin/sessions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          action: "cancel-monthly-session",
          accessEndsAt: payload.accessEndsAt,
          refund: payload.refund,
          reason: payload.reason,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Request failed");
      }
      if (!mountedRef.current) return;
      setActionState("success");
      const refundAmt = payload.refund.amount ?? 0;
      const refundNote = refundAmt > 0.005 ? ` · refund $${refundAmt.toFixed(2)}` : "";
      const accessNote =
        payload.accessEndsAt === "period_end" ? "at period end"
        : payload.accessEndsAt === "now" ? "now"
        : "on chosen date";
      addToast({
        type: "success",
        message: `Subscription cancelled ${accessNote}${refundNote}`,
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
            <MenuRow label="Adjust session" onClick={() => setView("adjust")} />
            {paid > 0 && <MenuRow label="Issue refund" onClick={() => setView("refund")} />}
            <MenuRow label="Cancel session" onClick={() => setView("cancel")} danger />
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
              onSubmit={(end, refund, reason) => callAdjust(end, refund, reason)}
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
              onCancel={callCancelMonthlySession}
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
  label,
  onClick,
  danger,
}: {
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
      <span style={{ fontSize: 13, fontWeight: 500, color: danger ? DANGER : FG, flex: 1 }}>{label}</span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={danger ? DANGER : MUTED} strokeWidth="1.5" strokeLinecap="round">
        <path d="M6 3l5 5-5 5" />
      </svg>
    </button>
  );
}
