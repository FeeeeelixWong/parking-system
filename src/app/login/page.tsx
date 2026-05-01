"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

function LoginForm() {
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("next") || "/admin";
  const sessionExpired = searchParams.get("sessionExpired") === "1";

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || "Login failed");
      }
      // Full page navigation ensures the auth cookie is set before the
      // proxy middleware checks it on the next page load
      window.location.href = redirectTo;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#F2F2F7",
        fontFamily: "var(--font-body)",
        padding: 20,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: "100%",
          maxWidth: 360,
          background: "#FFFFFF",
          border: "1px solid #E5E5EA",
          borderRadius: 8,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 600,
              color: "#1C1C1E",
              letterSpacing: "-0.01em",
            }}
          >
            Manager Sign In
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "#636366" }}>
            Enter the admin password to continue.
          </p>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 500, color: "#636366" }}>
            Password
          </span>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              padding: "8px 10px",
              fontSize: 13,
              fontFamily: "var(--font-body)",
              background: "#FFFFFF",
              border: "1px solid #C7C7CC",
              borderRadius: 6,
              color: "#1C1C1E",
              outline: "none",
            }}
          />
        </label>

        {sessionExpired && !error && (
          <div
            style={{
              fontSize: 11,
              color: "#92400E",
              padding: "6px 10px",
              background: "#FEF3C7",
              border: "1px solid #D97706",
              borderRadius: 4,
            }}
          >
            Your session expired — please sign in again.
          </div>
        )}

        {error && (
          <div
            style={{
              fontSize: 11,
              color: "#991B1B",
              padding: "6px 10px",
              background: "#FEE2E2",
              border: "1px solid #DC2626",
              borderRadius: 4,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !password}
          style={{
            padding: "8px 14px",
            fontSize: 13,
            fontWeight: 600,
            border: "none",
            borderRadius: 6,
            background: loading || !password ? "#C7C7CC" : "#2D7A4A",
            color: "#fff",
            cursor: loading || !password ? "not-allowed" : "pointer",
            fontFamily: "var(--font-body)",
          }}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
