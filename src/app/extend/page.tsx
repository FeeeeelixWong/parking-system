"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { loadDriver } from "@/lib/driver-store";
import { apiFetch, apiPost } from "@/lib/fetch";
import type { ActionState } from "@/types/domain";

export default function ExtendPage() {
  return (
    <Suspense
      fallback={
        <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <p style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-display)", letterSpacing: "0.05em" }}>Loading…</p>
        </div>
      }
    >
      <ExtendContent />
    </Suspense>
  );
}

function formatDateTime(date: Date) {
  return (
    date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) +
    " at " +
    date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  );
}

type DriverStateSession = {
  id: string;
  status: "ACTIVE" | "OVERSTAY";
  expectedEnd: string;
  spot: { label: string; type: string };
  vehicle: { id: string; type: string; licensePlate: string | null; nickname: string | null };
  isMonthly: boolean;
};

function ExtendContent() {
  const router = useRouter();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [days, setDays] = useState(1);
  const [dailyRate, setDailyRate] = useState(0);
  const [currentEnd, setCurrentEnd] = useState<Date | null>(null);
  const [spotLabel, setSpotLabel] = useState("");
  const [driverName, setDriverName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isMonthly, setIsMonthly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [allowedExtend, setAllowedExtend] = useState<ActionState | null>(null);

  useEffect(() => {
    const saved = loadDriver();
    if (!saved) {
      Promise.resolve().then(() => {
        setLoadError("Driver identity not found. Please check in again.");
        setLoading(false);
      });
      return;
    }

    const phone = saved.phone ?? "";
    if (!phone) {
      Promise.resolve().then(() => {
        setLoadError("No phone on file. Please check in again.");
        setLoading(false);
      });
      return;
    }

    apiFetch<{
      driver: { id: string; name: string } | null;
      activeSessions: DriverStateSession[];
      allowedActions: ActionState[];
    }>(`/api/driver/state?phone=${encodeURIComponent(phone)}`)
      .then(async (state) => {
        if (!state.driver) {
          setLoadError("Driver not found. Please check in again.");
          setLoading(false);
          return;
        }

        setDriverId(state.driver.id);
        setDriverName(state.driver.name);

        const activeSession = state.activeSessions[0];

        if (!activeSession) {
          setLoadError("No active session found.");
          setLoading(false);
          return;
        }

        if (activeSession.status === "OVERSTAY") {
          router.replace("/exit");
          return;
        }

        if (activeSession.isMonthly) {
          setIsMonthly(true);
          setLoading(false);
          return;
        }

        const extendAction = state.allowedActions.find(
          (a) => a.code === "REQUEST_EXTENSION_CHECKOUT",
        ) ?? null;
        setAllowedExtend(extendAction);

        setSessionId(activeSession.id);
        setCurrentEnd(new Date(activeSession.expectedEnd));
        setSpotLabel(activeSession.spot.label);

        // Fetch daily rate from pricing preview (1 day = the per-day rate)
        const preview = await apiFetch<{ ok: boolean; result?: { rate: number } }>(
          `/api/pricing/preview?vehicleType=${activeSession.vehicle.type}&durationType=DAILY&days=1`,
        );
        setDailyRate(preview.result?.rate ?? 0);
        setLoading(false);
      })
      .catch(() => {
        setLoadError("Could not load session details. Please try again.");
        setLoading(false);
      });
  }, [router]);

  const totalAmount = dailyRate * days;
  const newEnd = currentEnd
    ? new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000)
    : null;

  async function handleExtend(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId || !driverId || submitting) return;
    setSubmitting(true);
    setError("");

    try {
      const result = await apiPost<
        | { ok: true; result: { checkoutUrl: string } }
        | { ok: false; denial: { message: string } }
      >(`/api/sessions/${sessionId}/request-extension-checkout`, { driverId, days });

      if (!result.ok) {
        setError(result.denial.message);
        setSubmitting(false);
        return;
      }
      window.location.href = result.result.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-display)" }}>Loading session…</p>
      </div>
    );
  }

  if (isMonthly) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 360 }}>
          <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#DCFCE7", border: "2px solid var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, margin: "0 auto 20px" }}>
            ↻
          </div>
          <p style={{ fontSize: 18, fontWeight: 700, color: "var(--fg)", marginBottom: 10 }}>Monthly subscription active</p>
          <p style={{ fontSize: 14, color: "var(--fg-subtle)", marginBottom: 28, lineHeight: 1.6 }}>
            Your parking renews automatically each month — no action needed. If you have questions about your subscription, please contact the lot manager.
          </p>
          <button
            onClick={() => router.replace("/welcome")}
            style={{ padding: "12px 24px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}
          >
            Back to home
          </button>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 360 }}>
          <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#FEF2F2", border: "2px solid var(--error)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: "var(--error)", margin: "0 auto 20px" }}>
            !
          </div>
          <p style={{ fontSize: 15, color: "var(--error)", marginBottom: 24 }}>{loadError}</p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button
              onClick={() => window.location.reload()}
              style={{ padding: "12px 24px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" }}
            >
              Retry
            </button>
            <Link
              href="/entry"
              style={{ padding: "12px 24px", background: "var(--input-bg)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 10, textDecoration: "none", fontSize: 15 }}
            >
              Back to start
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!currentEnd) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center" }}>
          <p style={{ marginBottom: 16, color: "var(--fg-muted)" }}>No active session found.</p>
          <Link href="/entry" style={{ color: "var(--accent)", fontWeight: 600 }}>
            Back to start
          </Link>
        </div>
      </div>
    );
  }

  const firstName = driverName ? driverName.split(" ")[0] : null;
  const extendDisabled = allowedExtend !== null && !allowedExtend.enabled;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "36px 20px 48px",
        fontFamily: "var(--font-body)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440 }}>
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <p
            style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--fg-subtle)",
              fontFamily: "var(--font-display)",
              marginBottom: 6,
            }}
          >
            Extend Parking · Extender estacionamiento
          </p>
          <h1
            style={{
              fontSize: 30,
              fontWeight: 800,
              fontFamily: "var(--font-display)",
              color: "var(--fg)",
              lineHeight: 1.15,
            }}
          >
            {firstName ? `Add more time, ${firstName}` : "Add more time"}
          </h1>
        </div>

        {extendDisabled && allowedExtend?.reason && (
          <div style={{ padding: "12px 16px", background: "#FEF3C7", border: "1px solid #D97706", borderRadius: 10, marginBottom: 20, fontSize: 14, color: "#92400E" }}>
            {allowedExtend.reason}
          </div>
        )}

        {/* Current session context */}
        <div
          style={{
            background: "var(--input-bg)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: "16px 20px",
            marginBottom: 20,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div>
            <p
              style={{
                fontSize: 11,
                color: "var(--fg-subtle)",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.07em",
                marginBottom: 5,
              }}
            >
              Current expiry
            </p>
            <p style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)" }}>
              {formatDateTime(currentEnd)}
            </p>
          </div>
          {spotLabel && (
            <div
              style={{
                background: "var(--accent-light)",
                border: "1.5px solid var(--accent)",
                borderRadius: 10,
                padding: "6px 16px",
                textAlign: "center",
                flexShrink: 0,
              }}
            >
              <p
                style={{
                  fontSize: 10,
                  color: "var(--accent)",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 2,
                }}
              >
                Spot
              </p>
              <p
                style={{
                  fontSize: 22,
                  fontWeight: 900,
                  color: "var(--accent)",
                  fontFamily: "var(--font-display)",
                  lineHeight: 1,
                }}
              >
                {spotLabel}
              </p>
            </div>
          )}
        </div>

        {/* Day stepper */}
        <div
          style={{
            background: "var(--input-bg)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: "24px 20px",
            marginBottom: 20,
          }}
        >
          <p
            style={{
              fontSize: 12,
              color: "var(--fg-subtle)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              marginBottom: 22,
              textAlign: "center",
            }}
          >
            Additional Days · <span style={{ fontWeight: 400 }}>Días adicionales</span>
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 28,
            }}
          >
            <button
              type="button"
              onClick={() => setDays((d) => Math.max(1, d - 1))}
              disabled={days <= 1}
              aria-label="Decrease days"
              style={{
                width: 54,
                height: 54,
                borderRadius: "50%",
                border: "2px solid var(--border)",
                background: days <= 1 ? "var(--border)" : "var(--input-bg)",
                color: days <= 1 ? "var(--fg-subtle)" : "var(--fg)",
                fontSize: 28,
                fontWeight: 700,
                cursor: days <= 1 ? "default" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s",
                flexShrink: 0,
              }}
            >
              −
            </button>

            <div style={{ textAlign: "center", minWidth: 90 }}>
              <span
                style={{
                  fontSize: 64,
                  fontWeight: 900,
                  fontFamily: "var(--font-display)",
                  color: "var(--fg)",
                  lineHeight: 1,
                  display: "block",
                }}
              >
                {days}
              </span>
              <p style={{ fontSize: 13, color: "var(--fg-subtle)", marginTop: 4, fontWeight: 500 }}>
                {days === 1 ? "day" : "days"}
              </p>
            </div>

            <button
              type="button"
              onClick={() => setDays((d) => Math.min(30, d + 1))}
              disabled={days >= 30}
              aria-label="Increase days"
              style={{
                width: 54,
                height: 54,
                borderRadius: "50%",
                border: "none",
                background: days >= 30 ? "var(--border)" : "var(--accent)",
                color: days >= 30 ? "var(--fg-subtle)" : "#fff",
                fontSize: 28,
                fontWeight: 700,
                cursor: days >= 30 ? "default" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s",
                flexShrink: 0,
              }}
            >
              +
            </button>
          </div>
        </div>

        {/* Price + new expiry summary */}
        <div
          style={{
            background: "var(--accent-light)",
            border: "1.5px solid var(--accent)",
            borderRadius: 14,
            padding: "18px 20px",
            marginBottom: 24,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <p style={{ fontSize: 14, color: "var(--accent)", fontWeight: 600 }}>Total due</p>
            <p
              style={{
                fontSize: 30,
                fontWeight: 900,
                color: "var(--accent)",
                fontFamily: "var(--font-display)",
              }}
            >
              ${totalAmount.toFixed(2)}
            </p>
          </div>
          <div style={{ height: 1, background: "var(--accent)", opacity: 0.2, marginBottom: 12 }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <p
              style={{
                fontSize: 11,
                color: "var(--accent)",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.07em",
                flexShrink: 0,
              }}
            >
              New expiry
            </p>
            {newEnd && (
              <p style={{ fontSize: 14, fontWeight: 700, color: "var(--accent)", textAlign: "right" }}>
                {formatDateTime(newEnd)}
              </p>
            )}
          </div>
        </div>

        {error && (
          <p
            style={{
              fontSize: 14,
              color: "var(--error)",
              marginBottom: 16,
              padding: "12px 16px",
              background: "#FEF2F2",
              borderRadius: 10,
              border: "1px solid var(--error)",
            }}
          >
            {error}
          </p>
        )}

        <form onSubmit={handleExtend}>
          <button
            type="submit"
            disabled={submitting || extendDisabled}
            style={{
              width: "100%",
              padding: "17px 24px",
              background: submitting || extendDisabled ? "var(--fg-subtle)" : "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 12,
              fontWeight: 700,
              fontSize: 17,
              cursor: submitting || extendDisabled ? "default" : "pointer",
              fontFamily: "var(--font-display)",
              letterSpacing: "0.02em",
              transition: "background 0.15s",
            }}
          >
            {submitting ? "Processing…" : `Pay $${totalAmount.toFixed(2)} & Extend`}
          </button>
        </form>

        <Link
          href="/entry"
          style={{
            display: "block",
            textAlign: "center",
            marginTop: 16,
            fontSize: 14,
            color: "var(--fg-subtle)",
            textDecoration: "underline",
          }}
        >
          Cancel
        </Link>
      </div>
    </div>
  );
}
