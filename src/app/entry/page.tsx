"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import type { SavedDriver } from "@/types/domain";
import type { ActionState } from "@/types/domain";
import { loadDriver, saveDriver, clearDriver, getDeviceId } from "@/lib/driver-store";
import { apiFetch, apiPost } from "@/lib/fetch";
import { timeRemaining, timeOverdue, vehicleLabel } from "@/lib/time";
import PhoneInput from "@/components/PhoneInput";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type State =
  | "init"            // mounting — checking localStorage
  | "checking"        // API in flight
  | "gate_active"     // has active session → gate opening on load
  | "gate_overstay"   // has overstay session → show fee, no gate
  | "allowlist"       // on allow list → gate opening, no session needed
  | "recognized"      // saved driver, no active session → "Welcome back!"
  | "ask_type"        // no saved driver → "New or existing?"
  | "enter_phone"     // existing user, enter phone number
  | "confirm"         // phone found, no session → "Are you [name]?"
  | "not_found";      // phone not in DB

type AllowListEntry = { name: string; label: string };

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
  allowedActions: ActionState[];
};

/** Detect if page load is a fresh QR scan (not refresh, back button, or shared link). */
function isExternalNavigation(): boolean {
  if (typeof window === "undefined") return false;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (!nav || nav.type !== "navigate") return false;
  try {
    if (document.referrer && new URL(document.referrer).origin === window.location.origin) {
      return false;
    }
  } catch { /* invalid referrer URL — treat as external */ }
  return true;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function ScanPage() {
  const router = useRouter();
  const [state, setState] = useState<State>("init");
  const [driver, setDriver] = useState<SavedDriver | null>(null);
  const [session, setSession] = useState<DriverStateSession | null>(null);
  const [allowEntry, setAllowEntry] = useState<AllowListEntry | null>(null);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [gateTriggered, setGateTriggered] = useState(false);
  const [gateDenied, setGateDenied] = useState(false);
  const phoneRef = useRef<HTMLInputElement>(null);
  const freshScan = useRef(false);

  // Resolve driver state → UI state
  function resolveState(data: DriverStateResponse, currentPhone: string) {
    if (data.allowList.allowed) {
      setAllowEntry({ name: data.allowList.name!, label: data.allowList.label! });
      setState("allowlist");
      return;
    }

    if (!data.driver) {
      clearDriver();
      setState("ask_type");
      return;
    }

    const saved: SavedDriver = { id: data.driver.id, name: data.driver.name, phone: data.driver.phone };
    saveDriver(saved);
    setDriver(saved);

    // Effective status is already computed server-side
    const active = data.activeSessions.find((s) => s.status === "ACTIVE");
    const overstay = data.activeSessions.find((s) => s.status === "OVERSTAY");

    if (active) {
      setSession(active);
      setState("gate_active");
    } else if (overstay) {
      setSession(overstay);
      setState("gate_overstay");
    } else {
      setState("recognized");
    }
    void currentPhone;
  }

  // Must run first — gate effects below read freshScan.current.
  // useRef initial value is evaluated during SSR (window === undefined → false),
  // so we set the real value here on the client after mount.
  useEffect(() => {
    freshScan.current = isExternalNavigation();
  }, []);

  // On mount: check localStorage, then verify against server
  useEffect(() => {
    const saved = loadDriver();
    if (!saved) {
      Promise.resolve().then(() => setState("ask_type"));
      return;
    }

    const digits = saved.phone.replace(/\D/g, "");
    Promise.resolve()
      .then(() => { setState("checking"); })
      .then(() =>
        apiFetch<DriverStateResponse>(`/api/driver/state?phone=${digits}`)
          .then((data) => {
            // Verify the saved driver ID still matches
            if (data.driver && data.driver.id !== saved.id) {
              clearDriver();
              setState("ask_type");
              return;
            }
            resolveState(data, digits);
          })
          .catch(() => {
            clearDriver();
            setState("ask_type");
          }),
      );
  }, []);

  // Auto-trigger gate for allow list entries
  useEffect(() => {
    if (state !== "allowlist" || gateTriggered) return;
    if (!freshScan.current) {
      Promise.resolve().then(() => setGateDenied(true));
      return;
    }
    Promise.resolve().then(() => {
      setGateTriggered(true);
      apiPost("/api/allowlist/open-gate", {
        phone: phone.replace(/\D/g, "") || loadDriver()?.phone?.replace(/\D/g, ""),
        deviceId: getDeviceId(),
        direction: "ENTRANCE",
        scanContext: "fresh",
      }).catch(() => {});
    });
  }, [state, gateTriggered, phone]);

  // Auto-trigger gate when entering gate_active — only on fresh external scan
  useEffect(() => {
    if (state !== "gate_active" || gateTriggered) return;
    if (!freshScan.current) {
      Promise.resolve().then(() => setGateDenied(true));
      return;
    }
    if (!session || !driver) return;
    Promise.resolve().then(() => {
      setGateTriggered(true);
      apiPost<
        | { ok: true; result: { openedAt: string } }
        | { ok: false; denial: { code: string; message: string } }
      >(`/api/sessions/${session.id}/open-gate`, {
        driverId: driver.id,
        deviceId: getDeviceId(),
        direction: "ENTRANCE",
        scanContext: "fresh",
      })
        .then((result) => {
          if (!result.ok) {
            setGateDenied(true);
          }
        })
        .catch(() => {
          // Fail silently — driver still sees session info
        });
    });
  }, [state, gateTriggered, driver, session]);

  useEffect(() => {
    if (state === "enter_phone") {
      setTimeout(() => phoneRef.current?.focus(), 120);
    }
  }, [state]);

  // Phone lookup for returning drivers
  async function lookupPhone() {
    setError("");
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7) { setError("Enter a valid phone number"); return; }
    setState("checking");
    try {
      const data = await apiFetch<DriverStateResponse>(`/api/driver/state?phone=${digits}`);

      if (data.allowList.allowed) {
        setAllowEntry({ name: data.allowList.name!, label: data.allowList.label! });
        setState("allowlist");
        return;
      }

      if (!data.driver) {
        setState("not_found");
        return;
      }

      // If they have active sessions, resolve immediately (skip confirm step)
      if (data.activeSessions.length > 0) {
        resolveState(data, digits);
      } else {
        // No active session — set as pending driver, ask to confirm
        setDriver({ id: data.driver.id, name: data.driver.name, phone: data.driver.phone });
        setState("confirm");
      }
    } catch {
      setError("Connection error. Try again.");
      setState("enter_phone");
    }
  }

  function confirmIdentity() {
    if (!driver) return;
    saveDriver(driver);
    router.push("/checkin?locked=true");
  }

  function proceedAsRecognized() {
    router.push("/checkin?locked=true");
  }

  function reset() {
    clearDriver();
    setDriver(null);
    setSession(null);
    setPhone("");
    setError("");
    setGateTriggered(false);
    setGateDenied(false);
    setState("ask_type");
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .g {
          min-height: 100dvh;
          background: #0D0C0E;
          color: #F2F0EB;
          font-family: 'DM Sans', sans-serif;
          display: flex;
          flex-direction: column;
        }

        .g-bar {
          padding: 18px 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(242,240,235,0.07);
        }
        .g-bar-name {
          font-family: 'Syne', sans-serif;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.04em;
          color: rgba(242,240,235,0.55);
        }
        .g-bar-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 500;
          color: rgba(242,240,235,0.35);
        }
        .g-bar-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: currentColor;
        }
        .g-bar-dot.green { color: #34C759; }
        .g-bar-dot.blue  { color: #4A9EFF; }
        .g-bar-dot.amber { color: #F59E0B; }
        .g-bar-dot.red   { color: #EF4444; }

        .g-body {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding: 40px 28px 60px;
          max-width: 420px;
          width: 100%;
          margin: 0 auto;
          animation: g-in 0.25s ease both;
        }
        @keyframes g-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .g-eyebrow {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: rgba(242,240,235,0.35);
          margin-bottom: 12px;
        }

        .g-h1 {
          font-family: 'Syne', sans-serif;
          font-size: clamp(32px, 8vw, 42px);
          font-weight: 800;
          line-height: 1.05;
          letter-spacing: -0.02em;
          color: #F2F0EB;
          margin-bottom: 10px;
        }
        .g-h1 span { color: #2D7A4A; }
        .g-h1 .green { color: #34C759; }
        .g-h1 .amber { color: #F59E0B; }
        .g-eyebrow.amber { color: #F59E0B; }

        .g-sub {
          font-size: 15px;
          color: rgba(242,240,235,0.45);
          line-height: 1.55;
          margin-bottom: 36px;
        }

        .g-divider {
          height: 1px;
          background: rgba(242,240,235,0.07);
          margin: 0 0 28px;
        }

        .g-btn {
          width: 100%;
          padding: 16px 20px;
          border-radius: 10px;
          border: none;
          font-family: 'DM Sans', sans-serif;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.15s, transform 0.1s;
          display: flex;
          align-items: center;
          justify-content: space-between;
          text-decoration: none;
        }
        .g-btn:active { transform: scale(0.985); }

        .g-btn-primary {
          background: #2D7A4A;
          color: #fff;
          margin-bottom: 10px;
        }
        .g-btn-primary:hover { opacity: 0.9; }

        .g-btn-success {
          background: #1A3D26;
          color: #34C759;
          border: 1px solid rgba(52,199,89,0.2);
          margin-bottom: 10px;
        }
        .g-btn-success:hover { opacity: 0.85; }

        .g-btn-ghost {
          background: rgba(242,240,235,0.05);
          color: rgba(242,240,235,0.6);
          border: 1px solid rgba(242,240,235,0.1);
        }
        .g-btn-ghost:hover { background: rgba(242,240,235,0.08); }

        .g-menu {
          border: 1px solid rgba(242,240,235,0.08);
          border-radius: 12px;
          overflow: hidden;
          margin-bottom: 16px;
        }
        .g-menu-row {
          width: 100%;
          padding: 18px 20px;
          background: rgba(242,240,235,0.025);
          border: none;
          cursor: pointer;
          text-align: left;
          display: flex;
          align-items: center;
          justify-content: space-between;
          transition: background 0.15s;
          font-family: 'DM Sans', sans-serif;
          color: #F2F0EB;
        }
        .g-menu-row + .g-menu-row {
          border-top: 1px solid rgba(242,240,235,0.07);
        }
        .g-menu-row:hover { background: rgba(242,240,235,0.06); }
        .g-menu-row:active { background: rgba(242,240,235,0.09); }
        .g-menu-row-label {
          font-size: 15px;
          font-weight: 600;
          color: #F2F0EB;
          display: block;
          margin-bottom: 2px;
        }
        .g-menu-row-sub {
          font-size: 13px;
          color: rgba(242,240,235,0.38);
        }
        .g-menu-arrow {
          color: rgba(242,240,235,0.3);
          font-size: 18px;
          flex-shrink: 0;
          margin-left: 12px;
        }

        .g-input-wrap { margin-bottom: 6px; }
        .g-input-label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: rgba(242,240,235,0.4);
          margin-bottom: 10px;
        }
        .g-input {
          width: 100%;
          background: rgba(242,240,235,0.04);
          border: 1px solid rgba(242,240,235,0.1);
          border-radius: 10px;
          padding: 16px 18px;
          color: #F2F0EB;
          font-family: 'DM Sans', sans-serif;
          font-size: 20px;
          font-weight: 500;
          outline: none;
          transition: border-color 0.15s, background 0.15s;
          text-align: center;
          letter-spacing: 0.05em;
          margin-bottom: 14px;
        }
        .g-input::placeholder { color: rgba(242,240,235,0.18); letter-spacing: 0; }
        .g-input:focus {
          border-color: rgba(242,240,235,0.25);
          background: rgba(242,240,235,0.06);
        }

        .g-error {
          font-size: 13px;
          color: #F87171;
          min-height: 20px;
          margin-bottom: 14px;
          text-align: center;
        }

        .g-identity {
          padding: 20px;
          border-radius: 10px;
          background: rgba(242,240,235,0.04);
          border: 1px solid rgba(242,240,235,0.09);
          margin-bottom: 24px;
        }
        .g-identity-name {
          font-family: 'Syne', sans-serif;
          font-size: 22px;
          font-weight: 700;
          letter-spacing: -0.01em;
          color: #F2F0EB;
          margin-bottom: 4px;
        }
        .g-identity-phone {
          font-size: 14px;
          color: rgba(242,240,235,0.4);
          letter-spacing: 0.04em;
        }

        .g-verified {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 600;
          color: #34C759;
          background: rgba(52,199,89,0.1);
          border: 1px solid rgba(52,199,89,0.18);
          border-radius: 6px;
          padding: 4px 10px;
          margin-bottom: 20px;
        }

        .g-secondary {
          text-align: center;
          margin-top: 20px;
        }
        .g-secondary button, .g-secondary a {
          background: none;
          border: none;
          font-family: 'DM Sans', sans-serif;
          font-size: 13px;
          color: rgba(242,240,235,0.28);
          cursor: pointer;
          letter-spacing: 0.01em;
          transition: color 0.15s;
          text-decoration: none;
        }
        .g-secondary button:hover, .g-secondary a:hover { color: rgba(242,240,235,0.5); }

        .g-back {
          background: none;
          border: none;
          font-family: 'DM Sans', sans-serif;
          font-size: 13px;
          color: rgba(242,240,235,0.3);
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 8px 0;
          margin-top: 4px;
          transition: color 0.15s;
        }
        .g-back:hover { color: rgba(242,240,235,0.55); }

        .g-dots {
          display: flex;
          gap: 6px;
          margin-bottom: 28px;
        }
        .g-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: rgba(242,240,235,0.2);
          animation: g-pulse 1.2s ease-in-out infinite;
        }
        .g-dot:nth-child(2) { animation-delay: 0.2s; }
        .g-dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes g-pulse {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.9); }
          40% { opacity: 1; transform: scale(1); }
        }

        .g-icon-wrap {
          width: 52px;
          height: 52px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 24px;
          margin-bottom: 20px;
        }

        /* ── Session card ── */
        .g-session-card {
          padding: 20px;
          border-radius: 12px;
          background: rgba(242,240,235,0.04);
          border: 1px solid rgba(242,240,235,0.09);
          margin-bottom: 20px;
        }
        .g-session-row {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          padding: 5px 0;
        }
        .g-session-label {
          font-size: 12px;
          color: rgba(242,240,235,0.38);
        }
        .g-session-value {
          font-size: 14px;
          font-weight: 500;
          color: #F2F0EB;
          text-align: right;
        }

        /* ── Gate opening animation ── */
        @keyframes g-gate-pulse {
          0%   { transform: scale(1); opacity: 0.9; }
          50%  { transform: scale(1.15); opacity: 0.6; }
          100% { transform: scale(1); opacity: 0.9; }
        }
        .g-gate-icon {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          background: rgba(52,199,89,0.12);
          border: 1.5px solid rgba(52,199,89,0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 28px;
          color: #34C759;
          margin: 0 auto 24px;
          animation: g-gate-pulse 2s ease-in-out infinite;
        }
      `}</style>

      <div className="g">

        {/* ── Top bar ── */}
        <div className="g-bar">
          <span className="g-bar-name">Parking Gate</span>
          <span className="g-bar-status">
            <span className={`g-bar-dot ${
              state === "gate_active" ? "green"
              : state === "gate_overstay" ? "red"
              : state === "recognized" || state === "confirm" ? "green"
              : state === "not_found" ? "amber"
              : "blue"
            }`} />
            {state === "init" || state === "checking"
              ? "Checking…"
              : state === "gate_active"
              ? "Gate opening"
              : state === "gate_overstay"
              ? "Overstay"
              : state === "recognized"
              ? "Pass active"
              : state === "confirm"
              ? "Found"
              : state === "not_found"
              ? "Not found"
              : "Gate access"}
          </span>
        </div>

        {/* ── CHECKING ── */}
        {(state === "init" || state === "checking") && (
          <div className="g-body">
            <div className="g-dots">
              <div className="g-dot" />
              <div className="g-dot" />
              <div className="g-dot" />
            </div>
            <p className="g-eyebrow">Please wait</p>
            <h1 className="g-h1">Verifying<br />your pass…</h1>
          </div>
        )}

        {/* ── ALLOW LIST — gate opening, no session ── */}
        {state === "allowlist" && allowEntry && (
          <div className="g-body">
            {gateDenied ? (
              <>
                <div className="g-icon-wrap" style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.28)", margin: "0 auto 20px" }}>
                  <span style={{ fontSize: 22, color: "#F59E0B" }}>↻</span>
                </div>
                <p className="g-eyebrow amber">{allowEntry.label}</p>
                <h1 className="g-h1">Hey,<br /><span className="green">{allowEntry.name.split(" ")[0]}</span>.</h1>
                <p className="g-sub">Please re-scan the QR code at the gate to open it.</p>
              </>
            ) : (
              <>
                <div className="g-gate-icon">↑</div>
                <p className="g-eyebrow">{allowEntry.label}</p>
                <h1 className="g-h1">Welcome,<br /><span className="green">{allowEntry.name.split(" ")[0]}</span>.</h1>
                <p className="g-sub">The gate is opening. Drive through when ready.</p>
              </>
            )}
            <div className="g-secondary">
              <button onClick={reset}>Not {allowEntry.name.split(" ")[0]}? Reset</button>
            </div>
          </div>
        )}

        {/* ── GATE ACTIVE — auto-opened (or denied if not fresh scan) ── */}
        {state === "gate_active" && driver && session && (
          <div className="g-body">
            {gateDenied ? (
              <>
                <div className="g-icon-wrap" style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.28)", margin: "0 auto 20px" }}>
                  <span style={{ fontSize: 22, color: "#F59E0B" }}>↻</span>
                </div>
                <p className="g-eyebrow amber">Re-scan required</p>
                <h1 className="g-h1">Hey,<br /><span className="green">{driver.name.split(" ")[0]}</span>.</h1>
                <p className="g-sub" style={{ marginBottom: 24 }}>
                  Please re-scan the QR code at the gate to open it.
                </p>
              </>
            ) : (
              <>
                <div className="g-gate-icon">↑</div>
                <p className="g-eyebrow">Gate opening</p>
                <h1 className="g-h1">Welcome,<br /><span className="green">{driver.name.split(" ")[0]}</span>.</h1>
                <p className="g-sub" style={{ marginBottom: 24 }}>The gate is opening. Drive through when ready.</p>
              </>
            )}

            <div className="g-session-card">
              <div className="g-session-row">
                <span className="g-session-label">Spot</span>
                <span className="g-session-value" style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 18 }}>
                  {session.spot.label}
                </span>
              </div>
              <div className="g-session-row">
                <span className="g-session-label">Vehicle</span>
                <span className="g-session-value">{vehicleLabel(session.vehicle)}</span>
              </div>
              <div className="g-session-row">
                <span className="g-session-label">Time remaining</span>
                <span className="g-session-value" style={{ color: "#34C759", fontWeight: 600 }}>
                  {timeRemaining(session.expectedEnd)}
                </span>
              </div>
              <div className="g-session-row">
                <span className="g-session-label">Expires</span>
                <span className="g-session-value">
                  {new Date(session.expectedEnd).toLocaleString("en-US", {
                    hour: "numeric", minute: "2-digit", hour12: true,
                  })}
                </span>
              </div>
            </div>

            <Link href="/extend" className="g-btn g-btn-ghost" style={{ textAlign: "center", justifyContent: "center" }}>
              Extend parking time
            </Link>

            <div className="g-secondary">
              <button onClick={reset}>Not {driver.name.split(" ")[0]}? Reset</button>
            </div>
          </div>
        )}

        {/* ── GATE OVERSTAY — no auto-open, show fee info ── */}
        {state === "gate_overstay" && driver && session && (
          <div className="g-body">
            <div className="g-icon-wrap" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", margin: "0 auto 20px" }}>
              <span style={{ fontSize: 22, color: "#EF4444" }}>!</span>
            </div>
            <p className="g-eyebrow" style={{ color: "#EF4444" }}>Overstay</p>
            <h1 className="g-h1"><span>{driver.name.split(" ")[0]}</span>,<br />time&apos;s up.</h1>
            <p className="g-sub" style={{ marginBottom: 24 }}>
              Your session at spot {session.spot.label} expired{" "}
              <strong style={{ color: "#EF4444" }}>{timeOverdue(session.expectedEnd)}</strong> ago.
              Please settle the overstay fee to open the gate.
            </p>

            <div className="g-session-card" style={{ borderColor: "rgba(239,68,68,0.2)" }}>
              <div className="g-session-row">
                <span className="g-session-label">Spot</span>
                <span className="g-session-value">{session.spot.label}</span>
              </div>
              <div className="g-session-row">
                <span className="g-session-label">Vehicle</span>
                <span className="g-session-value">{vehicleLabel(session.vehicle)}</span>
              </div>
              <div className="g-session-row">
                <span className="g-session-label">Overdue</span>
                <span className="g-session-value" style={{ color: "#EF4444", fontWeight: 600 }}>
                  {timeOverdue(session.expectedEnd)}
                </span>
              </div>
            </div>

            <Link href="/exit" className="g-btn g-btn-primary" style={{ justifyContent: "center" }}>
              Settle overstay & open gate
            </Link>

            <div className="g-secondary" style={{ marginTop: 16 }}>
              <button onClick={reset}>Not {driver.name.split(" ")[0]}? Reset</button>
            </div>
          </div>
        )}

        {/* ── RECOGNIZED (no active session) ── */}
        {state === "recognized" && driver && (
          <div className="g-body">
            <div className="g-verified">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M2 5.5l2.5 2.5 4.5-5" stroke="#34C759" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Device verified
            </div>
            <p className="g-eyebrow">Welcome back</p>
            <h1 className="g-h1"><span>{driver.name.split(" ")[0]}</span>.</h1>
            <p className="g-sub">No active session. Check in to reserve a spot.</p>
            <div className="g-divider" />
            <button className="g-btn g-btn-success" onClick={proceedAsRecognized}>
              Continue to check in
              <span>→</span>
            </button>
            <div className="g-secondary">
              <button onClick={reset}>Not you? Reset device</button>
            </div>
          </div>
        )}

        {/* ── ASK TYPE ── */}
        {state === "ask_type" && (
          <div className="g-body">
            <p className="g-eyebrow">Gate access</p>
            <h1 className="g-h1">How can<br />we help?</h1>
            <p className="g-sub" style={{ marginBottom: 28 }}>Select an option to continue.</p>
            <div className="g-menu">
              <button className="g-menu-row" onClick={() => router.push("/checkin?new=true")}>
                <span>
                  <span className="g-menu-row-label">New driver</span>
                  <span className="g-menu-row-sub">First time at this facility</span>
                </span>
                <span className="g-menu-arrow">›</span>
              </button>
              <button className="g-menu-row" onClick={() => setState("enter_phone")}>
                <span>
                  <span className="g-menu-row-label">Returning driver</span>
                  <span className="g-menu-row-sub">I&apos;ve parked here before</span>
                </span>
                <span className="g-menu-arrow">›</span>
              </button>
            </div>
          </div>
        )}

        {/* ── ENTER PHONE ── */}
        {state === "enter_phone" && (
          <div className="g-body">
            <p className="g-eyebrow">Returning driver</p>
            <h1 className="g-h1">Enter your<br />phone number</h1>
            <p className="g-sub">We&apos;ll look up your account.</p>
            <div className="g-input-wrap">
              <label className="g-input-label">Phone number</label>
              <PhoneInput
                ref={phoneRef}
                className="g-input"
                placeholder="(555) 000-0000"
                value={phone}
                onChange={setPhone}
                onKeyDown={(e) => e.key === "Enter" && lookupPhone()}
              />
            </div>
            <div className="g-error">{error}</div>
            <button className="g-btn g-btn-primary" onClick={lookupPhone}>
              Look up account
              <span>→</span>
            </button>
            <button className="g-back" onClick={() => { setError(""); setState("ask_type"); }}>
              ← Back
            </button>
          </div>
        )}

        {/* ── CONFIRM IDENTITY (no active session) ── */}
        {state === "confirm" && driver && (
          <div className="g-body">
            <p className="g-eyebrow">Confirm identity</p>
            <h1 className="g-h1">Is this<br />you?</h1>
            <p className="g-sub" style={{ marginBottom: 20 }}>We found a match for that number.</p>
            <div className="g-identity">
              <div className="g-identity-name">{driver.name}</div>
              <div className="g-identity-phone">{driver.phone}</div>
            </div>
            <button className="g-btn g-btn-success" onClick={confirmIdentity}>
              Yes, that&apos;s me
              <span>→</span>
            </button>
            <button className="g-btn g-btn-ghost" style={{ marginTop: 8 }} onClick={() => { setDriver(null); setPhone(""); setState("enter_phone"); }}>
              No, try a different number
              <span />
            </button>
          </div>
        )}

        {/* ── NOT FOUND ── */}
        {state === "not_found" && (
          <div className="g-body">
            <div className="g-icon-wrap" style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.28)" }}>
              <span style={{ fontSize: 22, color: "#F59E0B" }}>?</span>
            </div>
            <p className="g-eyebrow amber">No account found</p>
            <h1 className="g-h1">Number<br />not on file</h1>
            <p className="g-sub">
              We couldn&apos;t find an account for{" "}
              <span style={{ color: "#F2F0EB", fontWeight: 500 }}>{phone}</span>.
            </p>
            <div className="g-divider" />
            <button className="g-btn g-btn-primary" onClick={() => router.push(`/checkin?new=true&prefillPhone=${encodeURIComponent(phone.replace(/\D/g, ""))}`)}>
              Sign up as new driver
              <span>→</span>
            </button>
            <button className="g-btn g-btn-ghost" style={{ marginTop: 8 }} onClick={() => { setPhone(""); setState("enter_phone"); }}>
              Try a different number
              <span />
            </button>
          </div>
        )}

      </div>
    </>
  );
}
