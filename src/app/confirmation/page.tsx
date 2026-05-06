"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

import type { ApiSession, ApiSpot, ApiVehicle, ApiPayment } from "@/types/domain";
import { loadDriver } from "@/lib/driver-store";
import { apiFetch } from "@/lib/fetch";

type SessionData = Pick<ApiSession, "id" | "startedAt" | "expectedEnd"> & {
  spot: Pick<ApiSpot, "label" | "type">;
  driver: { name: string };
  vehicle: Pick<ApiVehicle, "licensePlate" | "type" | "nickname">;
  payments: Pick<ApiPayment, "amount" | "type">[];
};

function formatDateTime(date: Date) {
  return (
    date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) +
    " at " +
    date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: "100vh",
            background: "var(--bg)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <p style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-display)" }}>Loading…</p>
        </div>
      }
    >
      <ConfirmationContent />
    </Suspense>
  );
}

function ConfirmationContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const gateOpened = searchParams.get("gateOpened");
  const sessionIdParam = searchParams.get("sessionId");

  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState("");
  const [driverId, setDriverId] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadDriver();
    if (!saved) {
      // No driver identity → redirect to entry instead of showing an
      // error that loops on retry (reload finds no driver again).
      router.replace("/entry");
      return;
    }
    Promise.resolve(saved.id)
      .then((id) => {
        setDriverId(id);
        return apiFetch<{ session: SessionData | null; activeSessions: SessionData[] }>(`/api/sessions?driverId=${id}`);
      })
      .then((d) => {
        const target = sessionIdParam
          ? d.activeSessions.find(s => s.id === sessionIdParam) ?? d.session
          : d.session;
        if (target) {
          setSession(target);
        } else {
          setError("Session not found.");
        }
      })
      .catch(() => {
        setError("Could not load session details.");
      });
  }, [router, sessionIdParam]);

  if (error) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 360 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: "50%",
              background: "#FEF2F2",
              border: "2px solid var(--error)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              color: "var(--error)",
              margin: "0 auto 20px",
            }}
          >
            !
          </div>
          <h2
            style={{
              fontSize: 20,
              fontWeight: 700,
              fontFamily: "var(--font-display)",
              marginBottom: 8,
            }}
          >
            Something went wrong
          </h2>
          <p style={{ color: "var(--error)", fontSize: 14, marginBottom: 24 }}>{error}</p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button
              onClick={() => {
                setError("");
                window.location.reload();
              }}
              style={{
                padding: "12px 24px",
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                fontWeight: 700,
                fontSize: 15,
                cursor: "pointer",
              }}
            >
              Retry
            </button>
            <Link
              href="/entry"
              style={{
                padding: "12px 24px",
                background: "var(--input-bg)",
                color: "var(--fg)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                textDecoration: "none",
                fontSize: 15,
              }}
            >
              Back to start
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <p style={{ color: "var(--fg-subtle)", fontFamily: "var(--font-display)" }}>
          Loading confirmation…
        </p>
      </div>
    );
  }

  const expectedEnd = new Date(session.expectedEnd);
  const totalPaid = session.payments
    .filter(p => p.type !== "MONTHLY_RENEWAL")
    .reduce((sum, p) => sum + p.amount, 0);
  const firstName = session.driver.name.split(" ")[0];
  const vehicleLabel =
    session.vehicle.type === "BOBTAIL" ? "Bobtail" : "Truck / Trailer";

  const detailRows = [
    {
      label: "Vehicle",
      value: `${session.vehicle.licensePlate}${session.vehicle.nickname ? ` · ${session.vehicle.nickname}` : ""} (${vehicleLabel})`,
    },
    { label: "Paid", value: `$${totalPaid.toFixed(2)}` },
    { label: "Expires", value: formatDateTime(expectedEnd) },
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "44px 20px 56px",
        fontFamily: "var(--font-body)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440 }}>
        {/* Success icon + heading */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              width: 76,
              height: 76,
              borderRadius: "50%",
              background: "var(--accent-light)",
              border: "3px solid var(--accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 20px",
              fontSize: 36,
              color: "var(--accent)",
              fontWeight: 700,
            }}
          >
          </div>
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
            {gateOpened ? "Gate Opening · Puerta abierta" : "Checked In · Registrado"}
          </p>
          <h1
            style={{
              fontSize: 32,
              fontWeight: 900,
              fontFamily: "var(--font-display)",
              color: "var(--fg)",
              lineHeight: 1.15,
            }}
          >
            You&rsquo;re good to go{firstName ? `, ${firstName}` : ""}!
          </h1>
          {gateOpened && (
            <p style={{ fontSize: 15, color: "var(--fg-muted)", marginTop: 8 }}>
              The gate is opening — head to your spot.
              <br />
              <span style={{ fontSize: 13, color: "var(--fg-subtle)" }}>La puerta se está abriendo — dirígete a tu lugar.</span>
            </p>
          )}
        </div>

        {/* Spot badge */}
        <div
          style={{
            background: "var(--accent)",
            borderRadius: 16,
            padding: "20px 24px",
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <p
              style={{
                fontSize: 11,
                color: "rgba(255,255,255,0.65)",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.09em",
                marginBottom: 4,
              }}
            >
              Your Spot
            </p>
            <p
              style={{
                fontSize: 52,
                fontWeight: 900,
                fontFamily: "var(--font-display)",
                color: "#fff",
                lineHeight: 1,
              }}
            >
              {session.spot.label}
            </p>
          </div>
        </div>

        {/* Session detail rows */}
        <div
          style={{
            background: "var(--input-bg)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            overflow: "hidden",
            marginBottom: 28,
          }}
        >
          {detailRows.map((row, i) => (
            <div
              key={row.label}
              style={{
                padding: "14px 20px",
                borderTop: i > 0 ? "1px solid var(--border)" : "none",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 16,
              }}
            >
              <p
                style={{
                  fontSize: 12,
                  color: "var(--fg-subtle)",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  flexShrink: 0,
                }}
              >
                {row.label}
              </p>
              <p
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--fg)",
                  textAlign: "right",
                }}
              >
                {row.value}
              </p>
            </div>
          ))}
        </div>

        {/* Actions */}
        {driverId && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Link
              href={`/welcome?driverId=${driverId}`}
              style={{
                display: "block",
                padding: "17px 20px",
                background: "var(--accent)",
                color: "#fff",
                borderRadius: 12,
                textAlign: "center",
                textDecoration: "none",
                fontWeight: 700,
                fontSize: 16,
                fontFamily: "var(--font-display)",
                letterSpacing: "0.02em",
              }}
            >
              View your sessions · Ver tus sesiones
            </Link>
            <Link
              href="/entry"
              style={{
                display: "block",
                padding: "14px 20px",
                textAlign: "center",
                color: "var(--fg-subtle)",
                textDecoration: "underline",
                fontSize: 14,
              }}
            >
              Return to start
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
