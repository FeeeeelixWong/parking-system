"use client";

// ---------------------------------------------------------------------------
// AdminExternalWriteStatus — presentational receipt for admin write actions.
// No API calls inside. Caller assembles steps and passes them as props.
// ---------------------------------------------------------------------------

const MONO: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
};

const STEP_BG = "#FAFAFA";
const STEP_BORDER = "#E5E5EA";
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
const SUCCESS_BG = "#DCFCE7";
const SUCCESS_BORDER = "#86EFAC";
const SUCCESS_FG = "#166534";

// ─── Public types ─────────────────────────────────────────────────────────────

export type ExternalWriteStepKey =
  | "stripe_refund"
  | "stripe_subscription"
  | "stripe_read"
  | "db_payment"
  | "db_session"
  | "qb_sales_receipt"
  | "qb_refund_receipt"
  | "access"
  | "audit"
  | "needs_review";

export type ExternalWriteStep = {
  key: ExternalWriteStepKey;
  label: string;
  status: "pending" | "working" | "confirmed" | "skipped" | "warning" | "failed";
  detail?: string;
  externalId?: string;
  href?: string;
};

export type ExternalWriteTone = "success" | "warning" | "failed" | "partial";

export type AdminExternalWriteStatusProps = {
  title: string;
  summary: string;
  tone: ExternalWriteTone;
  steps: ExternalWriteStep[];
  landed?: Record<string, string[]>;
  onClose?: () => void;
  shape?: "inline" | "modal";
};

// ─── Tone config ──────────────────────────────────────────────────────────────

const TONE: Record<ExternalWriteTone, { bg: string; border: string; color: string }> = {
  success: { bg: SUCCESS_BG, border: SUCCESS_BORDER, color: SUCCESS_FG },
  warning: { bg: WARN_LIGHT, border: WARN_BORDER, color: WARN },
  failed:  { bg: ERR_LIGHT,  border: ERR_BORDER,   color: ERR },
  partial: { bg: WARN_LIGHT, border: WARN_BORDER,  color: WARN },
};

// ─── Step icon + color ────────────────────────────────────────────────────────

function statusIcon(status: ExternalWriteStep["status"]): string {
  switch (status) {
    case "confirmed": return "✓";
    case "warning":   return "⚠";
    case "failed":    return "✗";
    case "working":   return "⟳";
    case "pending":   return "·";
    case "skipped":   return "—";
  }
}

function statusColor(status: ExternalWriteStep["status"]): string {
  switch (status) {
    case "confirmed": return SUCCESS_FG;
    case "warning":   return WARN;
    case "failed":    return ERR;
    case "working":   return ACCENT;
    case "pending":   return FG_DIM;
    case "skipped":   return FG_DIM;
  }
}

// ─── Step row ─────────────────────────────────────────────────────────────────

function StepRow({ step }: { step: ExternalWriteStep }) {
  const color = statusColor(step.status);

  let idEl: React.ReactNode = null;
  if (step.externalId) {
    if (step.href) {
      idEl = (
        <a
          href={step.href}
          target="_blank"
          rel="noreferrer"
          style={{ ...MONO, color: ACCENT, textDecoration: "none" }}
        >
          {step.externalId} ↗
        </a>
      );
    } else {
      idEl = (
        <code style={{ ...MONO, color: FG_MUTED, background: STEP_BG, padding: "1px 4px", borderRadius: 3 }}>
          {step.externalId}
        </code>
      );
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 0" }}>
      <span style={{
        minWidth: 16,
        textAlign: "center",
        fontSize: 13,
        fontWeight: 700,
        color,
        flexShrink: 0,
        marginTop: 1,
      }}>
        {statusIcon(step.status)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, color: FG }}>
          {step.label}
        </span>
        {idEl && (
          <span style={{ marginLeft: 6 }}>{idEl}</span>
        )}
        {step.detail && (
          <div style={{ fontSize: 12, color: FG_MUTED, marginTop: 2 }}>
            {step.detail}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Landed block (partial failure) ──────────────────────────────────────────

function LandedBlock({ landed }: { landed: Record<string, string[]> }) {
  const entries = Object.entries(landed).filter(([, items]) => items.length > 0);
  if (!entries.length) return null;
  return (
    <div style={{ marginTop: 12, padding: "10px 12px", background: WARN_LIGHT, border: `1px solid ${WARN_BORDER}`, borderRadius: 5 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: WARN, marginBottom: 6 }}>
        What landed before failure
      </div>
      {entries.map(([system, items]) => (
        <div key={system} style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: FG_MUTED }}>{system}:</span>{" "}
          {items.map((item, i) => (
            <span key={i} style={{ fontSize: 12, color: FG }}>
              {item}{i < items.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AdminExternalWriteStatus({
  title,
  summary,
  tone,
  steps,
  landed,
  onClose,
  shape = "inline",
}: AdminExternalWriteStatusProps) {
  const tc = TONE[tone];
  const hasWarningOrFailed = steps.some(
    (s) => s.status === "warning" || s.status === "failed",
  );

  const card = (
    <div
      role="status"
      aria-label={title}
      style={{
        background: "#FFFFFF",
        border: `1px solid ${tc.border}`,
        borderLeft: `3px solid ${tc.color}`,
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 14px",
        background: tc.bg,
        borderBottom: `1px solid ${tc.border}`,
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: tc.color }}>{title}</div>
          <div style={{ fontSize: 12, color: FG_MUTED, marginTop: 2 }}>{summary}</div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: FG_DIM,
              fontSize: 16,
              lineHeight: 1,
              padding: "2px 4px",
              borderRadius: 3,
              flexShrink: 0,
              marginLeft: 12,
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Step list */}
      <div style={{ padding: "10px 14px 4px" }}>
        <div style={{ display: "grid", gap: 0 }}>
          {steps.map((step) => (
            <StepRow key={step.key} step={step} />
          ))}
        </div>

        {landed && <LandedBlock landed={landed} />}

        {hasWarningOrFailed && (
          <div style={{
            marginTop: 10,
            marginBottom: 8,
            padding: "8px 10px",
            background: STEP_BG,
            border: `1px solid ${STEP_BORDER}`,
            borderRadius: 4,
            fontSize: 12,
            color: FG_MUTED,
          }}>
            <span style={{ fontWeight: 700, color: FG }}>Next:</span>{" "}
            {steps.some((s) => s.key === "needs_review" && s.status === "warning")
              ? "Open Needs Review to track until QuickBooks catches up."
              : steps.some((s) => s.key === "db_session" && s.status === "failed")
              ? "Review session and reconcile before retrying."
              : "Review and reconcile before taking another action."}
          </div>
        )}
      </div>
    </div>
  );

  if (shape === "modal") {
    return (
      <div style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        padding: 16,
      }}>
        <div style={{ width: "100%", maxWidth: 480 }}>
          {card}
        </div>
      </div>
    );
  }

  return card;
}
