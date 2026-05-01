"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type { ApiSession, ApiVehicle, ApiSpot } from "@/types/domain";
import { loadDriver, clearDriver, getDeviceId } from "@/lib/driver-store";
import { apiFetch, apiPost } from "@/lib/fetch";
import { timeRemaining as _timeRemaining, vehicleLabel as _vehicleLabel } from "@/lib/time";

type ActiveSession = Pick<ApiSession, "id" | "startedAt" | "expectedEnd" | "status"> & {
  spot: Pick<ApiSpot, "label" | "type">;
  vehicle: ApiVehicle;
};

export default function WelcomePage() {
  return (
    <Suspense
      fallback={
        <div
          className="min-h-screen flex items-center justify-center"
          style={{ background: "var(--bg)" }}
        >
          <div
            className="animate-pulse"
            style={{
              color: "var(--fg-muted)",
              fontFamily: "var(--font-display)",
            }}
          >
            <p className="text-2xl font-semibold tracking-wide uppercase">
              Loading...
            </p>
            <p className="text-sm mt-1" style={{ color: "var(--fg-subtle)" }}>
              Cargando...
            </p>
          </div>
        </div>
      }
    >
      <WelcomeContent />
    </Suspense>
  );
}

function WelcomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const driverId = searchParams.get("driverId");

  const [now] = useState(() => Date.now());

  const [driverName, setDriverName] = useState("");
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [gateLoading, setGateLoading] = useState<string | null>(null);
  const [gateError, setGateError] = useState("");

  useEffect(() => {
    if (!driverId) {
      router.replace("/entry");
      return;
    }

    const saved = loadDriver();
    const savedName = saved?.name || "";

    apiFetch<{ activeSessions: ActiveSession[] }>(`/api/sessions?driverId=${driverId}`)
      .then((d) => {
        setDriverName(savedName);
        setSessions(d.activeSessions || []);
        setLoading(false);
      })
      .catch(() => {
        setFetchError("Could not load sessions. Please try again.");
        setLoading(false);
      });
  }, [driverId, router]);

  const vehicleLabel = _vehicleLabel;
  const timeRemaining = (s: string) => _timeRemaining(s);

  function isOverstayed(session: ActiveSession) {
    // Use status as primary signal; fall back to time-check to catch
    // sessions that are past expectedEnd but haven't been marked by cron yet
    return session.status === "OVERSTAY" || new Date(session.expectedEnd).getTime() < now;
  }

  async function handleOpenGate(session: ActiveSession) {
    if (isOverstayed(session)) {
      router.push(`/exit`);
      return;
    }

    setGateLoading(session.id);
    setGateError("");
    try {
      await apiPost("/api/gate", {
        driverId: loadDriver()?.id,
        sessionId: session.id,
        deviceId: getDeviceId(),
        direction: "ENTRANCE",
      });
      router.push(`/confirmation?gateOpened=true&sessionId=${session.id}`);
    } catch {
      setGateError("Gate could not be opened. Please try again.");
      setGateLoading(null);
    }
  }

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "var(--bg)" }}
      >
        <div
          className="animate-pulse"
          style={{
            color: "var(--fg-muted)",
            fontFamily: "var(--font-display)",
          }}
        >
          <p className="text-2xl font-semibold tracking-wide uppercase">
            Checking sessions...
          </p>
          <p className="text-sm mt-1" style={{ color: "var(--fg-subtle)" }}>
            Verificando sesiones...
          </p>
        </div>
      </div>
    );
  }

  const firstName = driverName.split(" ")[0] || "Driver";

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <div
        className="sticky top-0 z-10 px-5 py-4 border-b"
        style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
      >
        <h1
          className="text-2xl font-extrabold tracking-wider uppercase"
          style={{ fontFamily: "var(--font-display)", color: "var(--fg)" }}
        >
          Welcome Back
        </h1>
        <p className="text-xs mt-0.5" style={{ color: "var(--fg-subtle)" }}>
          Bienvenido de nuevo, {firstName}
        </p>
      </div>

      <div className="max-w-lg mx-auto px-5 py-6 space-y-5">
        {/* Error banners */}
        {fetchError && (
          <div className="rounded-lg p-4 text-sm font-medium" style={{ background: "#FEF2F2", color: "var(--error)", border: "1px solid #FECACA" }}>
            {fetchError}
            <button
              className="ml-3 underline font-semibold"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        )}
        {gateError && (
          <div className="rounded-lg p-4 text-sm font-medium" style={{ background: "#FEF2F2", color: "var(--error)", border: "1px solid #FECACA" }}>
            {gateError}
          </div>
        )}

        {/* Active sessions */}
        {sessions.length > 0 && (
          <section
            className="rounded-xl p-5 space-y-4 border"
            style={{
              background: "var(--bg-card)",
              borderColor: "var(--border)",
            }}
          >
            <div className="mb-1">
              <h2
                className="text-lg font-bold tracking-wide uppercase"
                style={{ fontFamily: "var(--font-display)" }}
              >
                Active Sessions
              </h2>
              <p className="text-xs" style={{ color: "var(--fg-subtle)" }}>
                Sesiones activas — tap to open gate / Toque para abrir la puerta
              </p>
            </div>

            {sessions.map((s) => {
              const overstayed = isOverstayed(s);
              const isOpening = gateLoading === s.id;

              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleOpenGate(s)}
                  disabled={isOpening}
                  className="w-full text-left rounded-lg border-2 p-4 transition-all duration-150 active:scale-[0.98]"
                  style={{
                    background: overstayed ? "#FEF2F2" : "var(--input-bg)",
                    borderColor: overstayed ? "var(--error)" : "var(--border)",
                  }}
                >
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      {/* Vehicle */}
                      <div
                        className="text-[16px] font-bold tracking-wider uppercase"
                        style={{ fontFamily: "var(--font-display)" }}
                      >
                        {vehicleLabel(s.vehicle)}
                      </div>
                      {/* Type + Nickname */}
                      <div
                        className="text-[13px]"
                        style={{ color: "var(--fg-muted)" }}
                      >
                        {s.vehicle.type === "BOBTAIL"
                          ? "Bobtail"
                          : "Truck / Trailer"}
                        {s.vehicle.nickname && (
                          <span
                            className="ml-1 italic"
                            style={{ color: "var(--fg-subtle)" }}
                          >
                            — {s.vehicle.nickname}
                          </span>
                        )}
                      </div>
                      {/* Spot */}
                      <div
                        className="text-[13px] font-semibold"
                        style={{
                          color: "var(--fg-muted)",
                          fontFamily: "var(--font-display)",
                        }}
                      >
                        Spot {s.spot.label}
                      </div>
                    </div>

                    {/* Time remaining / status */}
                    <div className="text-right flex flex-col items-end gap-1">
                      <span
                        className="text-[13px] font-bold"
                        style={{
                          color: overstayed
                            ? "var(--error)"
                            : "var(--success)",
                          fontFamily: "var(--font-display)",
                        }}
                      >
                        {timeRemaining(s.expectedEnd)}
                      </span>
                      {overstayed ? (
                        <span
                          className="text-[11px] px-2 py-0.5 rounded-full font-semibold"
                          style={{
                            background: "#FECACA",
                            color: "var(--error)",
                          }}
                        >
                          PAY TO EXIT
                        </span>
                      ) : (
                        <span
                          className="text-[11px] px-2 py-0.5 rounded-full font-semibold"
                          style={{
                            background: "#D1FAE5",
                            color: "var(--success)",
                          }}
                        >
                          OPEN GATE
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Loading state */}
                  {isOpening && (
                    <div className="mt-3 flex items-center gap-2 text-sm" style={{ color: "var(--fg-muted)" }}>
                      <svg
                        className="animate-spin h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <circle
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeDasharray="31.4"
                          strokeLinecap="round"
                        />
                      </svg>
                      Opening gate... / Abriendo puerta...
                    </div>
                  )}

                  {/* Extend link — only show on non-overstayed active sessions */}
                  {!overstayed && !isOpening && (
                    <div
                      className="mt-3 text-center text-[12px] font-semibold underline"
                      style={{ color: "var(--accent)" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/extend`);
                      }}
                    >
                      Extend time / Extender tiempo
                    </div>
                  )}
                </button>
              );
            })}
          </section>
        )}

        {/* New check-in */}
        <button
          type="button"
          onClick={() => router.push(`/checkin?driverId=${driverId}`)}
          className="w-full py-4 rounded-xl text-lg font-bold tracking-wider uppercase text-white transition-all duration-150 active:scale-[0.98]"
          style={{
            background: "var(--accent)",
            fontFamily: "var(--font-display)",
            boxShadow: "0 4px 12px rgba(212, 80, 10, 0.3)",
          }}
        >
          {sessions.length > 0
            ? "New Check-In / Nuevo registro"
            : "Check In / Registrar entrada"}
        </button>

        {/* Not you */}
        <button
          type="button"
          onClick={() => {
            clearDriver();
            router.replace("/entry");
          }}
          className="w-full text-center py-3 text-sm font-medium underline"
          style={{ color: "var(--fg-subtle)" }}
        >
          Not {firstName}? Start fresh / ¿No eres {firstName}? Empezar de nuevo
        </button>
      </div>
    </div>
  );
}
