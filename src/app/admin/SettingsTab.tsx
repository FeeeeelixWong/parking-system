"use client";

import { useState, useEffect, useCallback } from "react";
import type { AppSettings } from "@/types/domain";
import {
  CARD_BG, BORDER, FG, FG_MUTED, FG_DIM, ACCENT, RADIUS,
  inputStyle,
} from "./_shared";

// ---------------------------------------------------------------------------
// QBConnectionStatus — self-contained, reads its own /api/settings slice
// ---------------------------------------------------------------------------
function QBConnectionStatus() {
  // Seed from URL params synchronously (OAuth redirect back from QB)
  const [status, setStatus] = useState<"loading" | "connected" | "disconnected">(() => {
    if (typeof window === "undefined") return "loading";
    const params = new URLSearchParams(window.location.search);
    return params.get("qb_connected") === "true" ? "connected" : "loading";
  });
  const [realmId, setRealmId] = useState("");
  const [tokenExpiringSoon, setTokenExpiringSoon] = useState(false);

  useEffect(() => {
    // Clear QB OAuth redirect params from URL
    const params = new URLSearchParams(window.location.search);
    if (params.get("qb_connected") || params.get("qb_error")) {
      if (params.get("qb_error")) {
        alert(`QuickBooks connection failed: ${params.get("qb_error")}`);
      }
      window.history.replaceState({}, "", window.location.pathname);
    }

    // Load authoritative status from API
    fetch("/api/settings").then((r) => r.json()).then((d) => {
      if (d.settings?.qbConnected) {
        setStatus("connected");
        setRealmId(d.settings.qbRealmId ?? "");
        setTokenExpiringSoon(d.settings.qbTokenExpiringSoon ?? false);
      } else {
        setStatus("disconnected");
      }
    }).catch(() => setStatus("disconnected"));
  }, []);

  if (status === "loading") {
    return <div style={{ fontSize: 12, color: FG_DIM }}>Checking connection…</div>;
  }

  if (status === "connected") {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#2D7A4A" }} />
          <span style={{ fontSize: 13, color: "#2D7A4A", fontWeight: 600 }}>Connected</span>
        </div>
        <div style={{ fontSize: 11, color: FG_DIM }}>
          Company ID: {realmId}
        </div>
        {tokenExpiringSoon && (
          <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 6, background: "#FEF3C7", border: "1px solid #D97706", fontSize: 12, color: "#92400E" }}>
            QB token expires within 14 days — reconnect soon to avoid payment failures.
          </div>
        )}
        <button
          onClick={() => window.location.href = "/api/admin/qb-auth"}
          style={{ marginTop: 10, padding: "6px 14px", borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: FG_MUTED, fontSize: 12, cursor: "pointer" }}
        >
          Reconnect
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: FG_MUTED, marginBottom: 12 }}>
        Connect your QuickBooks account to process payments. Drivers can pay with Apple Pay, PayPal, Venmo, or card.
      </div>
      <button
        onClick={() => window.location.href = "/api/admin/qb-auth"}
        style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: "#2CA01C", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
      >
        Connect to QuickBooks
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AllowListManager
// ---------------------------------------------------------------------------
function AllowListManager({ mobile }: { mobile: boolean }) {
  type Entry = { id: string; phone: string; name: string; label: string; active: boolean };
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addName, setAddName] = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [addLabel, setAddLabel] = useState<"EMPLOYEE" | "FAMILY" | "VENDOR" | "CONTRACTOR">("EMPLOYEE");

  const load = useCallback(() => {
    fetch("/api/admin/allowlist").then((r) => r.json())
      .then((d) => setEntries(d.entries ?? []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);

  async function handleAdd() {
    if (!addName.trim() || !addPhone.trim()) return;
    setFeedback(null);
    try {
      const res = await fetch("/api/admin/allowlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: addName, phone: addPhone, label: addLabel }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Add failed" }));
        setFeedback({ msg: body.error ?? "Add failed", ok: false });
        return;
      }
      setAddName(""); setAddPhone(""); setAddLabel("EMPLOYEE");
      setFeedback({ msg: "Added", ok: true });
      setLoading(true);
      load();
    } catch {
      setFeedback({ msg: "Network error — try again", ok: false });
    }
  }

  async function handleToggle(id: string, active: boolean) {
    setFeedback(null);
    try {
      const res = await fetch("/api/admin/allowlist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, active: !active }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Update failed" }));
        setFeedback({ msg: body.error ?? "Update failed", ok: false });
        return;
      }
      setLoading(true);
      load();
    } catch {
      setFeedback({ msg: "Network error — try again", ok: false });
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this person from the allow list?")) return;
    setFeedback(null);
    try {
      const res = await fetch("/api/admin/allowlist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Delete failed" }));
        setFeedback({ msg: body.error ?? "Delete failed", ok: false });
        return;
      }
      setFeedback({ msg: "Removed", ok: true });
      setLoading(true);
      load();
    } catch {
      setFeedback({ msg: "Network error — try again", ok: false });
    }
  }

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 16 }}>
        Allow List (Employees, Family, etc.)
      </div>

      {feedback && (
        <p style={{ fontSize: 12, color: feedback.ok ? "#16A34A" : "#EF4444", marginBottom: 12 }}>
          {feedback.msg}
        </p>
      )}

      {/* Add form */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <input placeholder="Name" value={addName} onChange={(e) => setAddName(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
        <input placeholder="Phone" value={addPhone} onChange={(e) => setAddPhone(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
        <select value={addLabel} onChange={(e) => setAddLabel(e.target.value as typeof addLabel)} style={{ ...inputStyle, width: mobile ? "100%" : 130 }}>
          <option value="EMPLOYEE">Employee</option>
          <option value="FAMILY">Family</option>
          <option value="VENDOR">Vendor</option>
          <option value="CONTRACTOR">Contractor</option>
        </select>
        <button onClick={handleAdd} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "#2D7A4A", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
          Add
        </button>
      </div>

      {/* List */}
      {loading ? (
        <p style={{ color: FG_DIM, fontSize: 13 }}>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: FG_DIM, fontSize: 13 }}>No entries. Add employees or family above.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {entries.map((e) => (
            <div
              key={e.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                background: CARD_BG,
                borderRadius: 8,
                opacity: e.active ? 1 : 0.5,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: FG }}>{e.name}</div>
                <div style={{ fontSize: 11, color: FG_DIM }}>{e.phone} · {e.label.charAt(0) + e.label.slice(1).toLowerCase()}</div>
              </div>
              <button
                onClick={() => handleToggle(e.id, e.active)}
                style={{ padding: "4px 10px", borderRadius: 4, border: `1px solid ${BORDER}`, background: "transparent", color: e.active ? "#2D7A4A" : FG_DIM, fontSize: 11, fontWeight: 600, cursor: "pointer" }}
              >
                {e.active ? "Active" : "Disabled"}
              </button>
              <button
                onClick={() => handleDelete(e.id)}
                style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid #DC262640", background: "transparent", color: "#DC2626", fontSize: 11, cursor: "pointer" }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsGroup / SettingsField helpers
// ---------------------------------------------------------------------------
function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: CARD_BG, borderRadius: RADIUS, padding: "18px 20px", border: `1px solid ${BORDER}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {children}
      </div>
    </div>
  );
}

function SettingsField({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step?: string }) {
  return (
    <div>
      <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>{label}</label>
      <input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={inputStyle} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsTab — default export
// ---------------------------------------------------------------------------
type Settings = AppSettings;

export default function SettingsTab({
  mobile,
  settingsForm,
  setSettingsForm,
  settings,
  handleSaveSettings,
  handleSandboxReset,
}: {
  mobile: boolean;
  settingsForm: Settings;
  setSettingsForm: React.Dispatch<React.SetStateAction<Settings | null>>;
  settings: Settings | null;
  handleSaveSettings: (e: React.FormEvent) => Promise<void>;
  handleSandboxReset: () => Promise<void>;
}) {
  return (
    <div style={{ maxWidth: mobile ? "100%" : 560 }}>
      <form onSubmit={handleSaveSettings} style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <SettingsGroup title="Payment">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              type="checkbox"
              id="paymentRequired"
              checked={settingsForm.paymentRequired ?? true}
              onChange={(e) => setSettingsForm({ ...settingsForm, paymentRequired: e.target.checked })}
              style={{ width: 16, height: 16, accentColor: ACCENT }}
            />
            <label htmlFor="paymentRequired" style={{ fontSize: 12, color: FG_MUTED, cursor: "pointer" }}>
              Require payment at check-in (disable for testing)
            </label>
          </div>
        </SettingsGroup>
        <SettingsGroup title="Subscription Delinquency">
          <div>
            <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>
              Block gate access when
            </label>
            <select
              value={settingsForm.failedPaymentPolicy ?? "on_subscription_deleted"}
              onChange={(e) => setSettingsForm({ ...settingsForm, failedPaymentPolicy: e.target.value as AppSettings["failedPaymentPolicy"] })}
              style={inputStyle}
            >
              <option value="on_subscription_deleted">Subscription is canceled by Stripe</option>
              <option value="immediate_on_payment_failed">First payment failure (immediately)</option>
              <option value="after_grace_days">Payment fails and grace period elapses</option>
            </select>
            <div style={{ fontSize: 10, color: FG_DIM, marginTop: 4 }}>
              Controls when a failed subscription payment suspends gate access for that driver.
            </div>
          </div>
          {settingsForm.failedPaymentPolicy === "after_grace_days" && (
            <SettingsField
              label="Grace period (days)"
              value={settingsForm.failedPaymentGraceDays ?? 7}
              onChange={(v) => setSettingsForm({ ...settingsForm, failedPaymentGraceDays: v })}
            />
          )}
        </SettingsGroup>
        <SettingsGroup title="QuickBooks Connection">
          <QBConnectionStatus />
        </SettingsGroup>
        <SettingsGroup title="Daily Rates">
          <SettingsField label="Bobtail ($/day)" value={settingsForm.dailyRateBobtail} onChange={(v) => setSettingsForm({ ...settingsForm, dailyRateBobtail: v })} step="0.01" />
          <SettingsField label="Truck/Trailer ($/day)" value={settingsForm.dailyRateTruck} onChange={(v) => setSettingsForm({ ...settingsForm, dailyRateTruck: v })} step="0.01" />
        </SettingsGroup>
        <SettingsGroup title="Monthly Rates">
          <SettingsField label="Bobtail ($/month)" value={settingsForm.monthlyRateBobtail} onChange={(v) => setSettingsForm({ ...settingsForm, monthlyRateBobtail: v })} step="0.01" />
          <SettingsField label="Truck/Trailer ($/month)" value={settingsForm.monthlyRateTruck} onChange={(v) => setSettingsForm({ ...settingsForm, monthlyRateTruck: v })} step="0.01" />
        </SettingsGroup>
        <SettingsGroup title="Overstay Rates (Premium)">
          <SettingsField label="Bobtail ($/day)" value={settingsForm.overstayRateBobtail} onChange={(v) => setSettingsForm({ ...settingsForm, overstayRateBobtail: v })} step="0.01" />
          <SettingsField label="Truck/Trailer ($/day)" value={settingsForm.overstayRateTruck} onChange={(v) => setSettingsForm({ ...settingsForm, overstayRateTruck: v })} step="0.01" />
        </SettingsGroup>
        <SettingsGroup title="Notifications">
          <SettingsField label="Reminder before expiry (min)" value={settingsForm.reminderMinutesBefore} onChange={(v) => setSettingsForm({ ...settingsForm, reminderMinutesBefore: v })} />
          <SettingsField label="Grace period (min)" value={settingsForm.gracePeriodMinutes} onChange={(v) => setSettingsForm({ ...settingsForm, gracePeriodMinutes: v })} />
          <div>
            <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Manager Email</label>
            <input type="email" value={settingsForm.managerEmail} onChange={(e) => setSettingsForm({ ...settingsForm, managerEmail: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Manager Phone</label>
            <input type="tel" value={settingsForm.managerPhone} onChange={(e) => setSettingsForm({ ...settingsForm, managerPhone: e.target.value })} style={inputStyle} />
          </div>
        </SettingsGroup>
        <SettingsGroup title="Spot Configuration">
          <SettingsField label="Total Bobtail Spots" value={settingsForm.totalSpotsBobtail} onChange={(v) => setSettingsForm({ ...settingsForm, totalSpotsBobtail: v })} />
          <SettingsField label="Total Truck/Trailer Spots" value={settingsForm.totalSpotsTruck} onChange={(v) => setSettingsForm({ ...settingsForm, totalSpotsTruck: v })} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            <input
              type="checkbox"
              id="bobtailOverflow"
              checked={settingsForm.bobtailOverflow ?? true}
              onChange={(e) => setSettingsForm({ ...settingsForm, bobtailOverflow: e.target.checked })}
              style={{ width: 16, height: 16, accentColor: ACCENT }}
            />
            <label htmlFor="bobtailOverflow" style={{ fontSize: 12, color: FG_MUTED, cursor: "pointer" }}>
              Allow bobtails in truck spots when bobtail spots are full
            </label>
          </div>
        </SettingsGroup>

        <SettingsGroup title="Parking Terms (Clickwrap)">
          <div>
            <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Version</label>
            <input
              type="text"
              value={settingsForm.termsVersion ?? ""}
              onChange={(e) => setSettingsForm({ ...settingsForm, termsVersion: e.target.value })}
              style={inputStyle}
              placeholder="1.0"
            />
            <div style={{ fontSize: 10, color: FG_DIM, marginTop: 4 }}>
              Bump this whenever you change the terms text below. Existing sessions stay bound to their original version.
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Terms body (shown to driver at check-in)</label>
            <textarea
              value={settingsForm.termsBody ?? ""}
              onChange={(e) => setSettingsForm({ ...settingsForm, termsBody: e.target.value })}
              style={{ ...inputStyle, minHeight: 220, fontFamily: "inherit", resize: "vertical" as const, lineHeight: 1.5 }}
              placeholder="Enter the terms drivers must accept to check in..."
            />
            <div style={{ fontSize: 10, color: "#92400E", marginTop: 6 }}>
              Have a Texas attorney review this text before production. Clickwrap consent is only enforceable if the terms are clear and the driver actively agrees.
            </div>
          </div>
        </SettingsGroup>

        <button type="submit" style={{ padding: "12px 24px", background: ACCENT, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer", alignSelf: "flex-start" }}>
          Save Settings
        </button>
      </form>

      {/* Allow list management */}
      <AllowListManager mobile={mobile} />

      {/* Sandbox reset — visible only when Stripe test keys are active */}
      {settings?.stripeTestMode && (
        <div style={{ marginTop: 40, padding: "20px 24px", background: "#1C1010", border: "1px solid #7F1D1D", borderRadius: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#FCA5A5", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
            Sandbox Reset
          </div>
          <p style={{ fontSize: 13, color: "#FCA5A5", opacity: 0.75, margin: "0 0 16px" }}>
            Wipes all local history (drivers, sessions, payments, audit log) and opens the Stripe and QuickBooks sandbox reset pages in new tabs. Spots, rates, and settings are preserved.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleSandboxReset}
              style={{ padding: "10px 20px", background: "#7F1D1D", border: "1px solid #DC2626", borderRadius: 7, color: "#FCA5A5", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
            >
              Wipe Local DB + Open Reset Pages
            </button>
            <a
              href="https://dashboard.stripe.com/test/developers"
              target="_blank"
              rel="noopener noreferrer"
              style={{ padding: "10px 20px", background: "transparent", border: "1px solid #555", borderRadius: 7, color: "#999", fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "none" }}
            >
              Stripe Dashboard ↗
            </a>
            <a
              href="https://developer.intuit.com/app/developer/sandbox"
              target="_blank"
              rel="noopener noreferrer"
              style={{ padding: "10px 20px", background: "transparent", border: "1px solid #555", borderRadius: 7, color: "#999", fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "none" }}
            >
              QB Developer Portal ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
