"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

/**
 * Stripe Checkout completion callback.
 *
 * The driver lands here after paying on Stripe. The URL carries
 * `?cs=cs_...` — Stripe's Checkout session ID. Meanwhile the
 * `checkout.session.completed` webhook has been dispatched to our server
 * and writes the Payment + Session rows.
 *
 * We poll `GET /api/payments/lookup?cs=...` every 500ms for up to 10s,
 * waiting for the webhook to land. On success we redirect by payment type:
 *
 *   CHECKIN / MONTHLY_CHECKIN → /welcome?driverId=X
 *   EXTENSION                  → /welcome?driverId=X
 *   OVERSTAY                   → /exit with an "exited" state
 *
 * After 10s we show a fallback "still processing" screen with a retry
 * button. Webhook should almost always land within ~1s but Stripe's
 * dashboard suggests tolerating up to 30s in edge cases.
 */

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 10_000;

type LookupResponse = {
  status: "ready";
  payment: {
    id: string;
    type: "CHECKIN" | "MONTHLY_CHECKIN" | "MONTHLY_RENEWAL" | "EXTENSION" | "OVERSTAY";
    amount: number;
    stripePaymentIntentId: string | null;
    stripeChargeId: string | null;
  };
  session: { id: string; driverId: string; status: string } | null;
};

type UIState =
  | { kind: "polling" }
  | { kind: "redirecting"; target: string }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

export default function PaymentCompletePage() {
  return (
    <Suspense fallback={null}>
      <PaymentCompleteContent />
    </Suspense>
  );
}

function PaymentCompleteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const cs = searchParams.get("cs");

  const [ui, setUi] = useState<UIState>({ kind: "polling" });
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!cs) {
      Promise.resolve().then(() =>
        setUi({ kind: "error", message: "Missing checkout reference in URL." })
      );
      return;
    }

    const start = Date.now();
    cancelledRef.current = false;

    function handleReady(data: LookupResponse) {
      const { payment, session } = data;
      let target: string;
      if (payment.type === "OVERSTAY" && session) {
        target = `/exit?paid=1&sessionId=${session.id}`;
      } else if (session) {
        target = `/welcome?driverId=${session.driverId}`;
      } else {
        target = "/entry";
      }
      setUi({ kind: "redirecting", target });
      router.replace(target);
    }

    const poll = async () => {
      if (cancelledRef.current) return;
      try {
        const res = await fetch(`/api/payments/lookup?cs=${encodeURIComponent(cs)}`);
        if (res.status === 200) {
          const data = (await res.json()) as LookupResponse;
          handleReady(data);
          return;
        }
        // 404 = not yet written by webhook; any other code = surface error
        if (res.status !== 404) {
          const body = await res.json().catch(() => ({}));
          setUi({ kind: "error", message: body.error ?? `Unexpected response ${res.status}` });
          return;
        }
      } catch {
        // Network hiccup — keep trying until timeout.
      }

      if (Date.now() - start >= POLL_TIMEOUT_MS) {
        setUi({ kind: "timeout" });
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();

    return () => {
      cancelledRef.current = true;
    };
  }, [cs, router]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        fontFamily: "var(--font-body)",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 400 }}>
        {ui.kind === "polling" && <Spinner title="Confirming your payment…" subtitle="Verificando tu pago…" />}
        {ui.kind === "redirecting" && <Spinner title="Redirecting…" subtitle="Redirigiendo…" />}
        {ui.kind === "timeout" && (
          <Block
            icon="!"
            iconColor="#F59E0B"
            title="Payment still processing"
            messages={[
              "Stripe is still confirming your payment. This usually takes under 10 seconds — occasionally a bit longer.",
              "Your card has been charged and we'll catch up momentarily.",
            ]}
            actions={[
              { label: "Check again", onClick: () => window.location.reload(), primary: true },
              { label: "Back to start", href: "/entry" },
            ]}
          />
        )}
        {ui.kind === "error" && (
          <Block
            icon="×"
            iconColor="var(--error)"
            title="Something went wrong"
            messages={[ui.message]}
            actions={[
              { label: "Try again", href: "/checkin", primary: true },
              { label: "Back to start", href: "/entry" },
            ]}
          />
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function Spinner({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <div
        style={{
          width: 48,
          height: 48,
          border: "3px solid var(--border)",
          borderTopColor: "var(--accent)",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
          margin: "0 auto 24px",
        }}
      />
      <h1 style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--font-display)", marginBottom: 8 }}>
        {title}
      </h1>
      <p style={{ fontSize: 13, color: "var(--fg-muted)" }}>{subtitle}</p>
    </>
  );
}

function Block({
  icon, iconColor, title, messages, actions,
}: {
  icon: string;
  iconColor: string;
  title: string;
  messages: string[];
  actions: Array<{ label: string; href?: string; onClick?: () => void; primary?: boolean }>;
}) {
  return (
    <>
      <div
        style={{
          width: 48, height: 48, borderRadius: "50%", background: "#FEF2F2",
          border: `2px solid ${iconColor}`, display: "flex", alignItems: "center",
          justifyContent: "center", fontSize: 24, color: iconColor, margin: "0 auto 24px",
        }}
      >
        {icon}
      </div>
      <h1 style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--font-display)", marginBottom: 8 }}>
        {title}
      </h1>
      {messages.map((m, i) => (
        <p key={i} style={{ fontSize: 14, color: "var(--fg-muted)", marginBottom: 16 }}>{m}</p>
      ))}
      <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 8 }}>
        {actions.map((a, i) => (
          a.href ? (
            <Link
              key={i}
              href={a.href}
              style={{
                padding: "10px 20px",
                background: a.primary ? "var(--accent)" : "var(--input-bg)",
                color: a.primary ? "#fff" : "var(--fg)",
                border: a.primary ? "none" : "1px solid var(--border)",
                borderRadius: 8,
                textDecoration: "none",
                fontSize: 14,
                fontWeight: a.primary ? 600 : 400,
              }}
            >
              {a.label}
            </Link>
          ) : (
            <button
              key={i}
              type="button"
              onClick={a.onClick}
              style={{
                padding: "10px 20px",
                background: a.primary ? "var(--accent)" : "var(--input-bg)",
                color: a.primary ? "#fff" : "var(--fg)",
                border: a.primary ? "none" : "1px solid var(--border)",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 14,
                fontWeight: a.primary ? 600 : 400,
              }}
            >
              {a.label}
            </button>
          )
        ))}
      </div>
    </>
  );
}
