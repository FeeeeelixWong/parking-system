"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import type { OverstayInfo, ActionState } from "@/types/domain";
import { loadDriver, saveDriver, clearDriver, getDeviceId } from "@/lib/driver-store";
import { apiFetch, apiPost } from "@/lib/fetch";
import { isExternalNavigation } from "@/lib/navigation";
import PhoneInput from "@/components/PhoneInput";

/* ─── types ─────────────────────────────────────────────── */
type DriverStateSession = {
  id: string;
  status: "ACTIVE" | "OVERSTAY";
  expectedEnd: string;
  spot: { label: string; type: string };
  vehicle: {
    id: string;
    licensePlate: string | null;
    unitNumber: string | null;
    type: string;
    nickname: string | null;
  };
  isMonthly: boolean;
};

type DriverStateResponse = {
  driver: { id: string; name: string; phone: string; email: string | null } | null;
  allowList: { allowed: boolean; name?: string; label?: string };
  activeSessions: DriverStateSession[];
  overstayPreview: {
    sessionId: string;
    overstayDays: number;
    overstayAmount: number;
    overstayRate: number;
  } | null;
  allowedActions: ActionState[];
};

type ExitDriver = { id: string; name: string; phone: string };

type State =
  | "init"
  | "checking"
  | "has_session"
  | "overstayed"
  | "no_session"
  | "ask_type"
  | "enter_phone"
  | "confirm"
  | "not_registered"
  | "gate_opening"
  | "gate_opened"
  | "exited";

/* ─── root ───────────────────────────────────────────────── */
export default function ExitPage() {
  return (
    <Suspense fallback={<LoadingShell />}>
      <ExitContent />
    </Suspense>
  );
}

function LoadingShell() {
  return (
    <Shell>
      <Spinner />
    </Shell>
  );
}

/* ─── main content ───────────────────────────────────────── */
function ExitContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Set by /payment-complete after a successful overstay settlement — the
  // webhook has already marked the session COMPLETED and written the
  // Payment row; we just need to show the confirmation state.
  const paidRedirect = searchParams.get("paid") === "1";

  const [state, setState] = useState<State>(paidRedirect ? "exited" : "init");
  const [driver, setDriver] = useState<ExitDriver | null>(null);
  const [session, setSession] = useState<DriverStateSession | null>(null);
  const [overstayInfo, setOverstayInfo] = useState<OverstayInfo | null>(null);
  const [managerPhone, setManagerPhone] = useState<string>("");

  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [gateDenied, setGateDenied] = useState(false);
  const freshScan = useRef(false);

  // Must run before the saved-driver lookup resolves: passive page loads must
  // not self-report scanContext:"fresh" to the gate endpoints.
  useEffect(() => {
    freshScan.current = isExternalNavigation();
  }, []);

  /* fetch settings for manager phone */
  useEffect(() => {
    apiFetch<{ settings: { managerPhone?: string } }>("/api/settings")
      .then((d) => {
        if (d.settings?.managerPhone) setManagerPhone(d.settings.managerPhone);
      })
      .catch(() => {});
  }, []);

  /* resolve driver state → UI state */
  async function resolveState(digits: string, data: DriverStateResponse, fresh: boolean) {
    setGateDenied(false);

    if (data.allowList.allowed) {
      if (!fresh) {
        setGateDenied(true);
        setState("gate_opened");
        return;
      }

      setState("gate_opening");
      try {
        await apiPost("/api/allowlist/open-gate", {
          phone: digits,
          deviceId: getDeviceId(),
          direction: "EXIT",
          scanContext: "fresh",
        });
      } catch { /* show gate_opened even if gate call fails */ }
      setState("gate_opened");
      return;
    }

    if (!data.driver) {
      setState("not_registered");
      return;
    }

    const d: ExitDriver = { id: data.driver.id, name: data.driver.name, phone: data.driver.phone };
    saveDriver({ id: d.id, name: d.name, phone: d.phone });
    setDriver(d);

    if (!data.activeSessions.length) {
      setState("no_session");
      return;
    }

    const s = data.activeSessions[0];
    setSession(s);

    if (s.status === "ACTIVE") {
      if (!fresh) {
        setGateDenied(true);
        setState("has_session");
        return;
      }

      setState("gate_opening");
      try {
        const result = await apiPost<
          | { ok: true; result: { openedAt: string } }
          | { ok: false; denial: { message: string } }
        >(`/api/sessions/${s.id}/open-gate`, {
          driverId: d.id,
          deviceId: getDeviceId(),
          direction: "EXIT",
          scanContext: "fresh",
        });
        if (!result.ok) {
          setError(result.denial.message);
          setState("has_session");
        } else {
          setState("gate_opened");
        }
      } catch {
        setState("gate_opened"); // show info even if gate call fails
      }
      return;
    }

    // OVERSTAY
    if (data.overstayPreview) {
      setOverstayInfo({
        requiresPayment: true,
        overstayDays: data.overstayPreview.overstayDays,
        overstayAmount: data.overstayPreview.overstayAmount,
        overstayRate: data.overstayPreview.overstayRate,
        sessionId: data.overstayPreview.sessionId,
      });
    }
    setState("overstayed");
  }

  /* on mount: check localStorage */
  useEffect(() => {
    if (paidRedirect) return;

    const saved = loadDriver();
    if (!saved) {
      setState("ask_type");
      return;
    }
    setState("checking");

    const digits = saved.phone.replace(/\D/g, "");
    apiFetch<DriverStateResponse>(`/api/driver/state?phone=${digits}`)
      .then((data) => {
        if (data.driver?.id === saved.id || data.allowList.allowed) {
          resolveState(digits, data, freshScan.current);
        } else {
          clearDriver();
          setState("ask_type");
        }
      })
      .catch(() => {
        clearDriver();
        setState("ask_type");
      });
  }, [paidRedirect]);

  /* ── phone lookup (existing user flow) ── */
  async function handlePhoneLookup(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      setError("Enter a valid 10-digit phone number.");
      return;
    }
    setActionLoading(true);
    try {
      const data = await apiFetch<DriverStateResponse>(`/api/driver/state?phone=${digits}`);
      await resolveState(digits, data, true);
    } catch {
      setError("Could not look up your number. Try again.");
    } finally {
      setActionLoading(false);
    }
  }

  /* ── gate open (active session, manual trigger) ── */
  async function handleOpenGate() {
    if (!session || !driver) return;
    setActionLoading(true);
    setError("");
    setGateDenied(false);
    setState("gate_opening");
    try {
      const result = await apiPost<
        | { ok: true; result: { openedAt: string } }
        | { ok: false; denial: { message: string } }
      >(`/api/sessions/${session.id}/open-gate`, {
        driverId: driver.id,
        deviceId: getDeviceId(),
        direction: "EXIT",
        scanContext: "fresh",
      });
      if (!result.ok) {
        setError(result.denial.message);
        setState("has_session");
      } else {
        setState("exited");
      }
    } catch {
      setError("Network error. Please try again.");
      setState("has_session");
    } finally {
      setActionLoading(false);
    }
  }

  /* ── overstay payment ── */
  async function handlePayOverstay() {
    if (!session || !driver) return;
    setActionLoading(true);
    setError("");
    try {
      const result = await apiPost<
        | { ok: true; result: { checkoutUrl: string } }
        | { ok: false; denial: { message: string } }
      >(`/api/sessions/${session.id}/request-overstay-checkout`, {
        driverId: driver.id,
      });
      if (!result.ok) {
        setError(result.denial.message);
        setActionLoading(false);
        return;
      }
      window.location.href = result.result.checkoutUrl;
    } catch {
      setError("Payment failed. Please try again.");
      setActionLoading(false);
    }
  }

  /* ─── render ─────────────────────────────────────────── */
  return (
    <Shell>
      {state === "init" || state === "checking" ? (
        <CheckingView />
      ) : gateDenied ? (
        <RescanRequiredView onStartOver={() => { clearDriver(); setGateDenied(false); setState("ask_type"); }} />
      ) : state === "gate_opening" ? (
        <GateOpeningView />
      ) : state === "gate_opened" && driver && session ? (
        <GateOpenedView driver={driver} session={session} onNotYou={() => { clearDriver(); setState("ask_type"); }} />
      ) : state === "exited" ? (
        <ExitedView />
      ) : state === "has_session" ? (
        <ActiveSessionView
          driver={driver!}
          session={session!}
          onOpenGate={handleOpenGate}
          loading={actionLoading}
          error={error}
          onNotYou={() => { clearDriver(); setState("ask_type"); }}
        />
      ) : state === "overstayed" ? (
        <OverstayView
          driver={driver!}
          session={session!}
          overstayInfo={overstayInfo}
          managerPhone={managerPhone}
          onPay={handlePayOverstay}
          loading={actionLoading}
          error={error}
          onNotYou={() => { clearDriver(); setState("ask_type"); }}
        />
      ) : state === "no_session" ? (
        <NoSessionView
          driver={driver!}
          onNotYou={() => { clearDriver(); setState("ask_type"); }}
        />
      ) : state === "ask_type" ? (
        <AskTypeView
          onExisting={() => setState("enter_phone")}
          onNew={() => router.push("/entry")}
        />
      ) : state === "enter_phone" ? (
        <EnterPhoneView
          phone={phone}
          setPhone={setPhone}
          onSubmit={handlePhoneLookup}
          loading={actionLoading}
          error={error}
          onBack={() => setState("ask_type")}
        />
      ) : state === "not_registered" ? (
        <NotRegisteredView onBack={() => setState("enter_phone")} />
      ) : null}
    </Shell>
  );
}

/* ═══════════════════════════════════════════════════════════
   SUB-VIEWS
═══════════════════════════════════════════════════════════ */

function CheckingView() {
  return (
    <div style={styles.center}>
      <Spinner />
      <p style={styles.hint}>Verifying identity…</p>
    </div>
  );
}

function GateOpeningView() {
  return (
    <div style={styles.center}>
      <div style={styles.gateIcon}>↑</div>
      <p style={{ ...styles.heading, color: "#2D7A4A" }}>Gate opening… · Puerta abierta…</p>
      <p style={styles.hint}>Please proceed through the gate.</p>
    </div>
  );
}

function GateOpenedView({
  driver,
  session,
  onNotYou,
}: {
  driver: ExitDriver;
  session: DriverStateSession;
  onNotYou: () => void;
}) {
  const expiresAt = new Date(session.expectedEnd).toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return (
    <div>
      <WelcomeBar name={driver.name} onNotYou={onNotYou} />

      <div style={styles.center}>
        <div style={styles.gateIcon}>↑</div>
        <p style={{ ...styles.heading, color: "#2D7A4A", marginBottom: 8 }}>Gate opening · Puerta abierta</p>
        <p style={styles.hint}>Drive safe! Your spot is still reserved.</p>
      </div>

      <div style={{ ...styles.card, marginTop: 24 }}>
        <div style={styles.cardLabel}>Your session</div>
        <div style={styles.cardRow}>
          <span style={styles.cardKey}>Spot</span>
          <span style={styles.cardVal}>{session.spot.label}</span>
        </div>
        <div style={styles.cardRow}>
          <span style={styles.cardKey}>Plate</span>
          <span style={styles.cardVal}>{session.vehicle.licensePlate ?? "—"}</span>
        </div>
        <div style={styles.cardRow}>
          <span style={styles.cardKey}>Expires</span>
          <span style={styles.cardVal}>{expiresAt}</span>
        </div>
      </div>

      <p style={styles.hint}>Scan the entry QR code to re-enter.</p>
    </div>
  );
}

function RescanRequiredView({ onStartOver }: { onStartOver: () => void }) {
  return (
    <div style={styles.center}>
      <div style={styles.gateIcon}>↻</div>
      <p style={styles.heading}>Please re-scan the QR code at the gate</p>
      <p style={styles.hint}>Refresh, back, and internal links cannot open the gate.</p>
      <button style={{ ...styles.secondaryBtn, marginTop: 24 }} onClick={onStartOver}>
        Start over
      </button>
    </div>
  );
}

function ExitedView() {
  return (
    <div style={styles.center}>
      <div style={styles.successMark} />
      <p style={styles.heading}>Overstay settled</p>
      <p style={styles.hint}>Drive safe!</p>
      <p style={{ ...styles.hint, marginTop: 32 }}>
        <Link href="/entry" style={styles.linkMuted}>
          Return to start
        </Link>
      </p>
    </div>
  );
}

function ActiveSessionView({
  driver,
  session,
  onOpenGate,
  loading,
  error,
  onNotYou,
}: {
  driver: ExitDriver;
  session: DriverStateSession;
  onOpenGate: () => void;
  loading: boolean;
  error: string;
  onNotYou: () => void;
}) {
  const expiresAt = new Date(session.expectedEnd).toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return (
    <div>
      <WelcomeBar name={driver.name} onNotYou={onNotYou} />

      <div style={styles.card}>
        <div style={styles.cardLabel}>Active session · Sesión activa</div>
        <div style={styles.cardRow}>
          <span style={styles.cardKey}>Spot</span>
          <span style={styles.cardVal}>{session.spot.label}</span>
        </div>
        <div style={styles.cardRow}>
          <span style={styles.cardKey}>Plate</span>
          <span style={styles.cardVal}>{session.vehicle.licensePlate ?? "—"}</span>
        </div>
        <div style={styles.cardRow}>
          <span style={styles.cardKey}>Expires</span>
          <span style={styles.cardVal}>{expiresAt}</span>
        </div>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      <button
        style={loading ? styles.btnDisabled : styles.btn}
        onClick={onOpenGate}
        disabled={loading}
      >
        {loading ? "Opening gate…" : "Open gate & exit"}
      </button>

      <p style={styles.hint}>The gate will open automatically once confirmed.</p>
    </div>
  );
}

function OverstayView({
  driver,
  session,
  overstayInfo,
  managerPhone,
  onPay,
  loading,
  error,
  onNotYou,
}: {
  driver: ExitDriver;
  session: DriverStateSession;
  overstayInfo: OverstayInfo | null;
  managerPhone: string;
  onPay: () => void;
  loading: boolean;
  error: string;
  onNotYou: () => void;
}) {
  const expiredAt = new Date(session.expectedEnd).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return (
    <div>
      <WelcomeBar name={driver.name} onNotYou={onNotYou} />

      <div style={{ ...styles.card, borderColor: "#DC2626" }}>
        <div style={{ ...styles.cardLabel, color: "#DC2626" }}>
          Overstay detected
        </div>
        <div style={styles.cardRow}>
          <span style={styles.cardKey}>Spot</span>
          <span style={styles.cardVal}>{session.spot.label}</span>
        </div>
        <div style={styles.cardRow}>
          <span style={styles.cardKey}>Expired</span>
          <span style={styles.cardVal}>{expiredAt}</span>
        </div>
        {overstayInfo && (
          <>
            <div style={{ ...styles.cardDivider }} />
            <div style={styles.cardRow}>
              <span style={styles.cardKey}>Duration</span>
              <span style={styles.cardVal}>{overstayInfo.overstayDays}d</span>
            </div>
            <div style={styles.cardRow}>
              <span style={styles.cardKey}>Rate</span>
              <span style={styles.cardVal}>${overstayInfo.overstayRate}/day</span>
            </div>
            <div style={{ ...styles.cardRow, marginTop: 8 }}>
              <span style={{ ...styles.cardKey, fontWeight: 600 }}>
                Amount due
              </span>
              <span style={{ ...styles.cardVal, color: "#DC2626", fontWeight: 700, fontSize: 20 }}>
                ${overstayInfo.overstayAmount.toFixed(2)}
              </span>
            </div>
          </>
        )}
      </div>

      {error && <p style={styles.error}>{error}</p>}

      {overstayInfo && (
        <button
          style={loading ? styles.btnDisabled : styles.btn}
          onClick={onPay}
          disabled={loading}
        >
          {loading
            ? "Processing…"
            : `Pay $${overstayInfo.overstayAmount.toFixed(2)} & exit`}
        </button>
      )}

      {managerPhone && (
        <a
          href={`tel:${managerPhone}`}
          style={styles.secondaryBtn}
        >
          Call for assistance
        </a>
      )}

      <p style={styles.hint}>
        Overstay fees must be settled before the gate can open.
      </p>
    </div>
  );
}

function NoSessionView({
  driver,
  onNotYou,
}: {
  driver: ExitDriver;
  onNotYou: () => void;
}) {
  return (
    <div>
      <WelcomeBar name={driver.name} onNotYou={onNotYou} />

      <div style={{ ...styles.card, borderColor: "#444" }}>
        <div style={styles.cardLabel}>No active session · Sin sesión activa</div>
        <p style={{ ...styles.hint, margin: 0, lineHeight: 1.6 }}>
          We couldn&apos;t find an active parking session for your account.
          If you believe this is an error, please contact staff.
        </p>
      </div>

      <Link href="/entry" style={styles.btn}>
        Go to check-in
      </Link>
    </div>
  );
}

function AskTypeView({
  onExisting,
  onNew,
}: {
  onExisting: () => void;
  onNew: () => void;
}) {
  return (
    <div>
      <p style={styles.eyebrow}>Exit</p>
      <h1 style={styles.heading}>Checking out?</h1>
      <p style={styles.sub}>Select how you checked in to continue.</p>

      <div style={styles.menuList}>
        <button style={styles.menuRow} onClick={onExisting}>
          <span style={styles.menuLabel}>I have a session</span>
          <span style={styles.menuArrow}>→</span>
        </button>
        <button style={styles.menuRow} onClick={onNew}>
          <span style={styles.menuLabel}>I haven&apos;t checked in yet</span>
          <span style={styles.menuArrow}>→</span>
        </button>
      </div>
    </div>
  );
}

function EnterPhoneView({
  phone,
  setPhone,
  onSubmit,
  loading,
  error,
  onBack,
}: {
  phone: string;
  setPhone: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
  error: string;
  onBack: () => void;
}) {
  return (
    <div>
      <button onClick={onBack} style={styles.backBtn}>← Back</button>
      <p style={styles.eyebrow}>Exit</p>
      <h1 style={styles.heading}>Your phone number</h1>
      <p style={styles.sub}>We&apos;ll look up your session.</p>

      <form onSubmit={onSubmit} autoComplete="off">
        <PhoneInput
          style={styles.input}
          placeholder="(555) 000-0000"
          value={phone}
          onChange={setPhone}
          autoFocus
        />
        {error && <p style={styles.error}>{error}</p>}
        <button
          type="submit"
          style={loading ? styles.btnDisabled : styles.btn}
          disabled={loading}
        >
          {loading ? "Looking up…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

function NotRegisteredView({ onBack }: { onBack: () => void }) {
  return (
    <div>
      <button onClick={onBack} style={styles.backBtn}>← Back</button>
      <div style={{ ...styles.card, borderColor: "#444", marginTop: 24 }}>
        <div style={styles.cardLabel}>Not found</div>
        <p style={{ ...styles.hint, margin: 0, lineHeight: 1.6 }}>
          No account was found with that phone number.
          You may not have an active session, or you may need to check in first.
        </p>
      </div>
      <Link href="/entry" style={styles.btn}>
        Go to check-in
      </Link>
    </div>
  );
}

/* ─── shared components ──────────────────────────────────── */
function WelcomeBar({
  name,
  onNotYou,
}: {
  name: string;
  onNotYou: () => void;
}) {
  return (
    <div style={styles.welcomeBar}>
      <div>
        <p style={styles.eyebrow}>Welcome back</p>
        <p style={styles.welcomeName}>{name}</p>
      </div>
      <button onClick={onNotYou} style={styles.notYouBtn}>
        Not you?
      </button>
    </div>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: 32,
        height: 32,
        border: "2px solid #2a2a2a",
        borderTopColor: "#2D7A4A",
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
        margin: "0 auto 16px",
      }}
    />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500;600&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          background: #0D0C0E;
          color: #F0EDE8;
          font-family: 'DM Sans', sans-serif;
          min-height: 100dvh;
          -webkit-font-smoothing: antialiased;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div
        style={{
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px 20px",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 400,
            animation: "fadeUp 0.35s ease both",
          }}
        >
          {/* wordmark */}
          <p
            style={{
              fontFamily: "Syne, sans-serif",
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "#2D7A4A",
              marginBottom: 40,
            }}
          >
            PARKLOGIC · EXIT
          </p>

          {children}
        </div>
      </div>
    </>
  );
}

/* ─── styles ─────────────────────────────────────────────── */
const styles: Record<string, React.CSSProperties> = {
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    paddingTop: 24,
  },
  eyebrow: {
    fontFamily: "DM Sans, sans-serif",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: "0.14em",
    textTransform: "uppercase" as const,
    color: "#888",
    marginBottom: 8,
  },
  heading: {
    fontFamily: "Syne, sans-serif",
    fontWeight: 700,
    fontSize: 28,
    lineHeight: 1.15,
    color: "#F0EDE8",
    marginBottom: 8,
  },
  sub: {
    fontSize: 15,
    color: "#888",
    marginBottom: 32,
    lineHeight: 1.5,
  },
  hint: {
    fontSize: 13,
    color: "#666",
    marginTop: 16,
    textAlign: "center" as const,
    lineHeight: 1.5,
  },
  error: {
    fontSize: 13,
    color: "#e05228",
    marginBottom: 12,
    padding: "10px 14px",
    background: "rgba(224,82,40,0.08)",
    borderRadius: 8,
    border: "1px solid rgba(224,82,40,0.2)",
  },

  /* cards */
  card: {
    background: "#161518",
    border: "1px solid #2a2827",
    borderRadius: 14,
    padding: "20px 22px",
    marginBottom: 20,
  },
  cardLabel: {
    fontFamily: "Syne, sans-serif",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.12em",
    textTransform: "uppercase" as const,
    color: "#666",
    marginBottom: 14,
  },
  cardRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  cardKey: {
    fontSize: 13,
    color: "#888",
  },
  cardVal: {
    fontSize: 14,
    fontWeight: 500,
    color: "#F0EDE8",
    fontFamily: "Syne, sans-serif",
  },
  cardDivider: {
    height: 1,
    background: "#2a2827",
    margin: "12px 0",
  },

  /* buttons */
  btn: {
    display: "block",
    width: "100%",
    padding: "15px 20px",
    background: "#2D7A4A",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "DM Sans, sans-serif",
    cursor: "pointer",
    textAlign: "center" as const,
    textDecoration: "none",
    marginBottom: 10,
    letterSpacing: "0.01em",
  },
  btnDisabled: {
    display: "block",
    width: "100%",
    padding: "15px 20px",
    background: "#3a2820",
    color: "#a0603a",
    border: "none",
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "DM Sans, sans-serif",
    cursor: "not-allowed",
    textAlign: "center" as const,
    textDecoration: "none",
    marginBottom: 10,
  },
  secondaryBtn: {
    display: "block",
    width: "100%",
    padding: "14px 20px",
    background: "transparent",
    color: "#aaa",
    border: "1px solid #2e2e2e",
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 500,
    fontFamily: "DM Sans, sans-serif",
    cursor: "pointer",
    textAlign: "center" as const,
    textDecoration: "none",
    marginBottom: 10,
    letterSpacing: "0.01em",
  },
  backBtn: {
    background: "none",
    border: "none",
    color: "#666",
    fontSize: 13,
    cursor: "pointer",
    padding: 0,
    marginBottom: 28,
    fontFamily: "DM Sans, sans-serif",
  },

  /* menu list */
  menuList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
    marginTop: 4,
  },
  menuRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 20px",
    background: "#161518",
    border: "1px solid #2a2827",
    borderRadius: 12,
    cursor: "pointer",
    width: "100%",
    textAlign: "left" as const,
  },
  menuLabel: {
    fontSize: 15,
    fontWeight: 500,
    color: "#F0EDE8",
    fontFamily: "DM Sans, sans-serif",
  },
  menuArrow: {
    fontSize: 16,
    color: "#2D7A4A",
  },

  /* welcome bar */
  welcomeBar: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 28,
  },
  welcomeName: {
    fontFamily: "Syne, sans-serif",
    fontWeight: 700,
    fontSize: 22,
    color: "#F0EDE8",
    marginTop: 2,
  },
  notYouBtn: {
    background: "none",
    border: "none",
    color: "#666",
    fontSize: 13,
    cursor: "pointer",
    padding: 0,
    fontFamily: "DM Sans, sans-serif",
    marginTop: 4,
  },

  /* success */
  successMark: {
    width: 64,
    height: 64,
    borderRadius: "50%",
    background: "rgba(224,82,40,0.12)",
    border: "1px solid rgba(224,82,40,0.3)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 28,
    color: "#2D7A4A",
    marginBottom: 24,
  },
  gateIcon: {
    width: 64,
    height: 64,
    borderRadius: "50%",
    background: "rgba(224,82,40,0.08)",
    border: "1px solid rgba(224,82,40,0.2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 28,
    color: "#2D7A4A",
    marginBottom: 24,
    animation: "fadeUp 0.4s ease both",
  },

  /* input */
  input: {
    display: "block",
    width: "100%",
    padding: "14px 16px",
    background: "#161518",
    border: "1px solid #2a2827",
    borderRadius: 10,
    color: "#F0EDE8",
    fontSize: 16,
    fontFamily: "DM Sans, sans-serif",
    marginBottom: 12,
    outline: "none",
  },

  /* link */
  linkMuted: {
    color: "#666",
    textDecoration: "underline",
    fontFamily: "DM Sans, sans-serif",
    fontSize: 13,
  },
};
