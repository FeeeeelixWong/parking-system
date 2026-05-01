"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";

import type { ApiSpotWithSessions, ApiAuditEntry, AppSettings, SpotLayout, LotSpotStatus, LotSpotDetail } from "@/types/domain";
import { apiFetch, apiPost } from "@/lib/fetch";
import { deriveLotStatus } from "@/lib/lot-status";
import { useIsMobile } from "@/lib/hooks";
import { timeRemaining } from "@/lib/time";
import LotMapViewer, { countStatuses } from "@/components/lot/LotMapViewer";
import { useEditorReducer } from "@/components/lot/editor/useEditorReducer";
import SpotDetailPanel from "@/app/lot/SpotDetailPanel";
import PhoneInput, { digitsOnly } from "@/components/PhoneInput";
import ManageSessionModal from "@/app/admin/ManageSessionModal";
import ReconcileView from "@/app/admin/ReconcileView";
import { ToastProvider } from "@/app/admin/ToastContext";
import PaymentsTab from "@/app/admin/PaymentsTab";
import SettingsTab from "@/app/admin/SettingsTab";

type Spot = ApiSpotWithSessions;
type AuditEntry = ApiAuditEntry;
type Settings = AppSettings;

// ---------------------------------------------------------------------------
// Sessions tab types
// ---------------------------------------------------------------------------
type SessionRow = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  expectedEnd: string;
  status: "ACTIVE" | "COMPLETED" | "OVERSTAY" | "CANCELLED";
  billingStatus: "CURRENT" | "PAYMENT_FAILED" | "DELINQUENT";
  driver: { id: string; name: string; email: string | null; phone: string };
  vehicle: { id: string; unitNumber: string | null; licensePlate: string | null; type: "BOBTAIL" | "TRUCK_TRAILER"; nickname: string | null };
  spot: { id: string; label: string; type: "BOBTAIL" | "TRUCK_TRAILER" };
  payments: { id: string; type: string; amount: number; days: number | null; createdAt: string; stripePaymentIntentId?: string | null; stripeSubscriptionId?: string | null; refundedAmount: number; status?: string; refunds?: { id: string; amount: number; stripeRefundId: string; qbRefundReceiptId: string | null; createdAt: string }[] }[];
};

type SessionsResponse = {
  sessions: SessionRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

type StatusFilter = "" | "ACTIVE" | "COMPLETED" | "OVERSTAY" | "CANCELLED";

// ---------------------------------------------------------------------------
// Log tab config
// ---------------------------------------------------------------------------
type LogFilter = "ALL" | "ENTRY" | "EXIT" | "EXTEND" | "OVERSTAY" | "GATE" | "ADMIN" | "NOTIFICATION" | "SECURITY";

const LOG_CATEGORIES: { key: LogFilter; label: string; actions: string[] }[] = [
  { key: "ALL", label: "All", actions: [] },
  { key: "ENTRY", label: "Entry", actions: ["CHECKIN"] },
  { key: "EXIT", label: "Exit", actions: ["CHECKOUT"] },
  { key: "EXTEND", label: "Extension", actions: ["EXTEND"] },
  { key: "OVERSTAY", label: "Overstay", actions: ["OVERSTAY_START", "OVERSTAY_PAYMENT"] },
  { key: "GATE", label: "Gate", actions: ["GATE_OPEN"] },
  { key: "ADMIN", label: "Admin", actions: ["SPOT_FREED"] },
  { key: "NOTIFICATION", label: "Notification", actions: ["REMINDER_SENT", "OVERSTAY_ALERT"] },
  { key: "SECURITY", label: "Security", actions: ["SUSPICIOUS_ENTRY", "GATE_DENIED", "ALLOWLIST_ENTRY"] },
];

const ACTION_BADGE: Record<string, { color: string; bg: string; label: string }> = {
  CHECKIN:          { color: "#166534", bg: "#DCFCE7", label: "Check-in" },
  CHECKOUT:         { color: "#1D4ED8", bg: "#DBEAFE", label: "Check-out" },
  EXTEND:           { color: "#92400E", bg: "#FEF3C7", label: "Extension" },
  OVERSTAY_START:   { color: "#991B1B", bg: "#FEE2E2", label: "Overstay" },
  OVERSTAY_PAYMENT: { color: "#991B1B", bg: "#FEE2E2", label: "Overstay paid" },
  GATE_OPEN:        { color: "#636366", bg: "#F2F2F7", label: "Gate" },
  SPOT_FREED:       { color: "#92400E", bg: "#FEF3C7", label: "Override" },
  REMINDER_SENT:    { color: "#115E59", bg: "#CCFBF1", label: "Reminder" },
  OVERSTAY_ALERT:   { color: "#991B1B", bg: "#FEE2E2", label: "Alert" },
  SUSPICIOUS_ENTRY: { color: "#78350F", bg: "#FEF3C7", label: "Suspicious" },
  GATE_DENIED:      { color: "#991B1B", bg: "#FEE2E2", label: "Denied" },
  ALLOWLIST_ENTRY:  { color: "#1D4ED8", bg: "#DBEAFE", label: "Allow list" },
};

const STATUS_STYLE: Record<string, { color: string; bg: string }> = {
  ACTIVE:    { color: "#166534", bg: "#DCFCE7" },
  COMPLETED: { color: "#636366", bg: "#F2F2F7" },
  OVERSTAY:  { color: "#991B1B", bg: "#FEE2E2" },
  CANCELLED: { color: "#6B21A8", bg: "#F3E8FF" },
};

const BILLING_STATUS_STYLE: Record<string, { color: string; bg: string; label: string } | undefined> = {
  CURRENT:        undefined,                                           // no badge — normal state
  PAYMENT_FAILED: { color: "#92400E", bg: "#FEF3C7", label: "Payment Failed" },
  DELINQUENT:     { color: "#7F1D1D", bg: "#FEE2E2", label: "Delinquent" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function calcDuration(start: string, end: string | null): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

function sumPayments(payments: { amount: number; refundedAmount: number }[]): number {
  return payments.reduce((s, p) => s + Math.max(0, p.amount - p.refundedAmount), 0);
}


// ---------------------------------------------------------------------------
// Shared inline style constants — light theme
// ---------------------------------------------------------------------------
const DARK_BG = "#F2F2F7";
/** Returns "Monthly (X/N)" progress label for a monthly payment within its session's billing cycle. */
function monthlyLabel(
  allPayments: { id: string; type: string; createdAt: string }[],
  currentId: string,
): string {
  const monthly = allPayments
    .filter(p => p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const idx = monthly.findIndex(p => p.id === currentId);
  if (idx < 0) return "Monthly";
  return `Monthly (${idx + 1} of ${monthly.length})`;
}

const CARD_BG = "#FFFFFF";
const BORDER = "#E5E5EA";
const FG = "#1C1C1E";
const FG_MUTED = "#636366";
const FG_DIM = "#8E8E93";
const ACCENT = "#2D7A4A";
const RADIUS = 12;

const chip = (active: boolean, mobile: boolean): React.CSSProperties => ({
  padding: mobile ? "10px 16px" : "6px 14px", borderRadius: 20,
  border: active ? "1px solid transparent" : `1px solid ${BORDER}`,
  background: active ? BORDER : "transparent",
  color: active ? FG : FG_MUTED,
  fontSize: mobile ? 13 : 12, fontWeight: 600,
  cursor: "pointer", letterSpacing: "0.02em",
});

const inputStyle: React.CSSProperties = {
  padding: "10px 12px", fontSize: 14, background: CARD_BG, border: `1px solid ${BORDER}`,
  borderRadius: 6, color: FG, outline: "none", width: "100%",
};

const paginationBtn = (disabled: boolean, mobile: boolean): React.CSSProperties => ({
  padding: mobile ? "10px 18px" : "6px 16px", borderRadius: 6, border: `1px solid ${BORDER}`,
  background: disabled ? "transparent" : CARD_BG,
  color: disabled ? "#AEAEB2" : FG,
  fontSize: mobile ? 13 : 12, fontWeight: 600, cursor: disabled ? "default" : "pointer",
});

// ═══════════════════════════════════════════════════════════════════════════
// Main component
// ═══════════════════════════════════════════════════════════════════════════
export default function AdminDashboard() {
  const mobile = useIsMobile();
  const [spots, setSpots] = useState<Spot[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsForm, setSettingsForm] = useState<Settings | null>(null);
  const [tab, setTab] = useState<"overview" | "sessions" | "payments" | "reconcile" | "drivers" | "log" | "settings">("overview");
  const [paymentsInitialSearch, setPaymentsInitialSearch] = useState("");
  const [reconcileHasIssues, setReconcileHasIssues] = useState(false);

  // Read ?tab and ?q URL params on mount so deep-links (e.g. "View in Payments") work
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    const validTabs = ["overview", "sessions", "payments", "drivers", "log", "settings"] as const;
    if (t && (validTabs as readonly string[]).includes(t)) {
      setTab(t as typeof tab);
    }
    const q = params.get("q");
    if (q) setPaymentsInitialSearch(q);
    if (t || q) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  useEffect(() => {
    fetch("/api/admin/reconcile?health=warning&limit=1")
      .then((r) => r.json())
      .then((d) => setReconcileHasIssues((d.total ?? 0) > 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.body.style.background = DARK_BG;
    document.body.style.color = FG;
    document.body.style.fontFamily = "system-ui, sans-serif";
    return () => {
      document.body.style.background = "";
      document.body.style.color = "";
      document.body.style.fontFamily = "";
    };
  }, []);

  // ── Drivers tab state ──
  type DriverRow = {
    id: string;
    name: string;
    email: string | null;
    phone: string;
    vehicles: { id: string; licensePlate: string | null; unitNumber: string | null; type: string; nickname: string | null }[];
    sessions: { id: string; status: string; spot: { label: string } }[];
    _count: { sessions: number };
  };
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [driversTotal, setDriversTotal] = useState(0);
  const [driversSearch, setDriversSearch] = useState("");
  const [driversOffset, setDriversOffset] = useState(0);
  const [driversLoading, setDriversLoading] = useState(false);
  const [editingDriver, setEditingDriver] = useState<DriverRow | null>(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", phone: "" });
  const [editErrors, setEditErrors] = useState<{ name?: string; email?: string; phone?: string }>({});
  const DRIVERS_LIMIT = 30;

  // ── Session actions state ──
  const [manageSession, setManageSession] = useState<SessionRow | null>(null);

  // ── New session modal ────────────────────────────────────────────────────
  type NsForm = {
    name: string; phone: string; email: string;
    vehicleType: "BOBTAIL" | "TRUCK_TRAILER";
    licensePlate: string; unitNumber: string; nickname: string;
    startImmediately: boolean; startDate: string; startTime: string;
    durationType: "DAILY" | "MONTHLY";
    days: number; months: number;
    spotMode: "auto" | "manual"; spotId: string;
    stripeId: string; qbReceiptId: string;
  };
  const NS_DEFAULT: NsForm = {
    name: "", phone: "", email: "",
    vehicleType: "TRUCK_TRAILER",
    licensePlate: "", unitNumber: "", nickname: "",
    startImmediately: true, startDate: "", startTime: "",
    durationType: "DAILY", days: 1, months: 1,
    spotMode: "auto", spotId: "",
    stripeId: "", qbReceiptId: "",
  };
  const [nsOpen, setNsOpen] = useState(false);
  const [nsForm, setNsForm] = useState<NsForm>(NS_DEFAULT);
  const [nsErrors, setNsErrors] = useState<Record<string, string>>({});
  const [nsSubmitting, setNsSubmitting] = useState(false);
  // ── Overview / lot map state ──
  const editor = useEditorReducer();
  const allSpots = useMemo<SpotLayout[]>(
    () => Object.values(editor.state.spots),
    [editor.state.spots],
  );
  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(null);

  // ── Sessions tab state ──
  const [sessionsData, setSessionsData] = useState<SessionsResponse | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessSearch, setSessSearch] = useState("");
  const [sessStatus, setSessStatus] = useState<StatusFilter>("");
  const [sessOffset, setSessOffset] = useState(0);
  const [sessExpanded, setSessExpanded] = useState<string | null>(null);
  const SESS_LIMIT = 30;

  // ── Log tab state ──
  const [logEntries, setLogEntries] = useState<AuditEntry[]>([]);
  const [logFilter, setLogFilter] = useState<LogFilter>("ALL");
  const [logOffset, setLogOffset] = useState(0);
  const [logTotal, setLogTotal] = useState(0);
  const [logLoading, setLogLoading] = useState(false);
  const LOG_LIMIT = 30;

  // ── Data loaders ──
  const loadData = useCallback(() => {
    fetch("/api/spots").then((r) => r.json()).then((d) => setSpots(d.spots || []));
    fetch("/api/settings").then((r) => r.json()).then((d) => {
      setSettings(d.settings);
      setSettingsForm(d.settings);
    });
  }, []);

  const sessQueryStr = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", String(SESS_LIMIT));
    p.set("offset", String(sessOffset));
    if (sessSearch.trim()) p.set("q", sessSearch.trim());
    if (sessStatus) p.set("status", sessStatus);
    return p.toString();
  }, [sessSearch, sessStatus, sessOffset]);

  const skipSessionSync = useRef(false);

  const loadSessions = useCallback(() => {
    setSessionsLoading(true);
    apiFetch<SessionsResponse>(`/api/sessions/history?${sessQueryStr}`)
      .then((d) => {
        setSessionsData(d);
        if (skipSessionSync.current) { skipSessionSync.current = false; return; }
        const ids = d.sessions.flatMap((s) => s.payments.map((p) => p.id));
        if (!ids.length) return;
        fetch("/api/admin/payments/sync-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentIds: ids }),
        }).then((r) => r.json()).then((res) => {
          if (res.synced > 0) { skipSessionSync.current = true; loadSessions(); }
        }).catch(() => {/* silent */});
      })
      .catch(() => setSessionsData(null))
      .finally(() => setSessionsLoading(false));
  }, [sessQueryStr]);

  const driversQueryStr = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", String(DRIVERS_LIMIT));
    p.set("offset", String(driversOffset));
    if (driversSearch.trim()) p.set("q", driversSearch.trim());
    return p.toString();
  }, [driversSearch, driversOffset]);

  const loadDrivers = useCallback(() => {
    setDriversLoading(true);
    apiFetch<{ drivers: DriverRow[]; total: number }>(`/api/admin/drivers?${driversQueryStr}`)
      .then((d) => { setDrivers(d.drivers); setDriversTotal(d.total); })
      .catch(() => setDrivers([]))
      .finally(() => setDriversLoading(false));
  }, [driversQueryStr]);

  const loadLog = useCallback((filter: LogFilter, offset: number) => {
    setLogLoading(true);
    const category = LOG_CATEGORIES.find((c) => c.key === filter);
    const actionParam = category && category.actions.length === 1 ? `&action=${category.actions[0]}` : "";
    apiFetch<{ logs: AuditEntry[]; total: number }>(
      `/api/audit?limit=${LOG_LIMIT}&offset=${offset}${actionParam}`
    )
      .then((d) => {
        let filtered = d.logs;
        if (category && category.actions.length > 1) {
          filtered = d.logs.filter((l) => category.actions.includes(l.action));
        }
        setLogEntries(filtered);
        setLogTotal(d.total);
      })
      .catch(() => setLogEntries([]))
      .finally(() => setLogLoading(false));
  }, []);

  // ── Effects ──
  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    if (tab === "sessions") loadSessions();
    if (tab === "drivers") loadDrivers();
  }, [tab, loadSessions, loadDrivers]);

  useEffect(() => {
    if (tab === "log") loadLog(logFilter, logOffset);
  }, [tab, logFilter, logOffset, loadLog]);

  // Reset offset when filters change
  useEffect(() => { setSessOffset(0); }, [sessSearch, sessStatus]);
  useEffect(() => { setDriversOffset(0); }, [driversSearch]);

  // ── Derived state ──
  const lotStatuses = useMemo<Record<string, LotSpotStatus>>(() => {
    const map: Record<string, LotSpotStatus> = {};
    for (const spot of spots) {
      map[spot.label] = deriveLotStatus(spot.sessions?.[0]);
    }
    return map;
  }, [spots]);

  const lotCounts = useMemo(() => countStatuses(allSpots, lotStatuses), [allSpots, lotStatuses]);

  const spotDetails = useMemo<Record<string, LotSpotDetail>>(() => {
    const map: Record<string, LotSpotDetail> = {};
    for (const spot of spots) {
      const session = spot.sessions?.[0] ?? null;
      const status = lotStatuses[spot.label] ?? "VACANT";
      map[spot.label] = {
        spotId: spot.id,
        spotLabel: spot.label,
        status,
        session: session
          ? {
              id: session.id,
              driver: session.driver,
              vehicle: session.vehicle,
              startedAt: new Date(session.startedAt),
              expectedEnd: new Date(session.expectedEnd),
              endedAt: session.endedAt ? new Date(session.endedAt) : null,
              sessionStatus: session.status,
              reminderSent: session.reminderSent,
              payments: [],
            }
          : null,
      };
    }
    return map;
  }, [spots, lotStatuses]);

  // ── Handlers ──
  async function handleSeedTestData() {
    const res = await fetch("/api/dev/seed", { method: "POST" });
    const d = await res.json();
    if (res.ok) { loadData(); console.log("Dev seed:", d); }
    else alert(d.error || "Failed to seed test data");
  }

  async function handleClearTestData() {
    if (!confirm("Clear all drivers, vehicles, sessions, and payments?")) return;
    const res = await fetch("/api/dev/clear", { method: "POST" });
    const d = await res.json();
    if (res.ok) loadData();
    else alert(d.error || "Failed to clear data");
  }

  async function handleSandboxReset() {
    if (!confirm("This will wipe ALL local DB history (drivers, vehicles, sessions, payments, audit log). Continue?")) return;
    const res = await fetch("/api/dev/clear", { method: "POST" });
    if (!res.ok) { alert("DB wipe failed"); return; }
    loadData();
    window.open("https://dashboard.stripe.com/test/developers", "_blank");
    window.open("https://developer.intuit.com/app/developer/sandbox", "_blank");
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settingsForm) return;
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settingsForm),
    });
    loadData();
  }

  // ── Available spots (for new session modal) ────────────────────────────
  const availableSpots = useMemo(
    () => spots.filter((s) => s.sessions.length === 0),
    [spots]
  );

  // ── New session handlers ────────────────────────────────────────────────
  function nsSetField<K extends keyof NsForm>(k: K, v: NsForm[K]) {
    setNsForm((f) => ({ ...f, [k]: v }));
    setNsErrors((e) => { const next = { ...e }; delete next[k]; return next; });
  }

  const nsPaymentRequired = settingsForm?.paymentRequired ?? true;

  function validateNs(): boolean {
    const errs: Record<string, string> = {};
    const digits = digitsOnly(nsForm.phone);
    if (!nsForm.name.trim()) errs.name = "Required";
    if (digits.length !== 10) errs.phone = "Must be 10 digits";
    if (nsForm.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nsForm.email)) errs.email = "Invalid email";
    if (!nsForm.licensePlate.trim() && !nsForm.unitNumber.trim()) errs.licensePlate = "Provide plate or unit number";
    if (nsForm.durationType === "DAILY" && (nsForm.days < 1 || nsForm.days > 30)) errs.days = "1–30 days";
    if (nsForm.durationType === "MONTHLY" && (nsForm.months < 1 || nsForm.months > 12)) errs.months = "1–12 months";
    if (nsForm.spotMode === "manual" && !nsForm.spotId) errs.spotId = "Select a spot";
    // Invoice only required when payments are enabled
    if (nsPaymentRequired) {
      if (!nsForm.stripeId.trim()) errs.stripeId = "Required";
    }
    setNsErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleNewSession() {
    if (!validateNs() || nsSubmitting) return;
    setNsSubmitting(true);
    setNsErrors({});
    try {
      await apiPost("/api/admin/sessions", {
        name: nsForm.name.trim(),
        phone: digitsOnly(nsForm.phone),
        email: nsForm.email.trim() || undefined,
        vehicleType: nsForm.vehicleType,
        licensePlate: nsForm.licensePlate.trim() || undefined,
        unitNumber: nsForm.unitNumber.trim() || undefined,
        nickname: nsForm.nickname.trim() || undefined,
        durationType: nsForm.durationType,
        days: nsForm.durationType === "DAILY" ? nsForm.days : undefined,
        months: nsForm.durationType === "MONTHLY" ? nsForm.months : undefined,
        spotId: nsForm.spotMode === "manual" ? nsForm.spotId : undefined,
        stripeId: nsPaymentRequired ? nsForm.stripeId.trim() : undefined,
      });
      setNsOpen(false);
      setNsForm(NS_DEFAULT);
      loadSessions();
    } catch (err) {
      setNsErrors({ _: err instanceof Error ? err.message : "Something went wrong" });
    } finally {
      setNsSubmitting(false);
    }
  }

  // ── Driver update ──
  async function handleSaveDriver() {
    if (!editingDriver) return;

    const errors: typeof editErrors = {};
    if (!editForm.name.trim()) errors.name = "Name is required";
    const phoneDigits = digitsOnly(editForm.phone);
    if (phoneDigits.length < 10) errors.phone = "Enter a valid 10-digit phone number";
    if (editForm.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editForm.email)) errors.email = "Enter a valid email address";
    if (Object.keys(errors).length > 0) { setEditErrors(errors); return; }
    setEditErrors({});

    const body: Record<string, string> = { id: editingDriver.id };
    if (editForm.name)  body.name  = editForm.name.trim();
    if (editForm.phone) body.phone = editForm.phone;
    if (editForm.email) body.email = editForm.email;
    const res = await fetch("/api/admin/drivers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const d = await res.json(); alert(d.error || "Failed to save driver"); return; }
    setEditingDriver(null);
    loadDrivers();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Render
  // ═════════════════════════════════════════════════════════════════════════
  const tabs: { key: typeof tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "sessions", label: "Sessions" },
    { key: "payments", label: "Payments" },
    { key: "reconcile", label: "Reconcile" },
    { key: "drivers", label: "Drivers" },
    { key: "log", label: "Log" },
    { key: "settings", label: "Settings" },
  ];

  return (
    <ToastProvider>
    <>
      {/* Header */}
      <div style={{ padding: mobile ? "16px 16px 0" : "20px 24px 0", borderBottom: `1px solid ${BORDER}` }}>
        <h1 style={{ fontSize: mobile ? 17 : 20, fontWeight: 700, letterSpacing: "0.04em", marginBottom: 12 }}>
          Parking Admin
        </h1>
        <div style={{ display: "flex", gap: 0 }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: mobile ? "10px 12px" : "10px 20px",
                background: "transparent",
                border: "none",
                borderBottom: tab === t.key ? `2px solid ${FG}` : "2px solid transparent",
                color: tab === t.key ? FG : FG_DIM,
                fontSize: mobile ? 12 : 13,
                fontWeight: 600,
                cursor: "pointer",
                letterSpacing: "0.02em",
              }}
            >
              <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 5 }}>
                {t.label}
                {t.key === "reconcile" && reconcileHasIssues && (
                  <span style={{
                    width: 7, height: 7,
                    borderRadius: "50%",
                    background: "#F59E0B",
                    display: "inline-block",
                    flexShrink: 0,
                    marginBottom: 1,
                  }} />
                )}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: tab === "reconcile" ? 0 : mobile ? "16px 16px 32px" : "24px 24px 40px" }}>

        {/* ═══ OVERVIEW (Lot Map) ═══ */}
        {tab === "overview" && (
          <div style={{ display: "flex", flexDirection: "column", minHeight: mobile ? "auto" : "calc(100vh - 120px)" }}>
            {/* Compact stats bar */}
            <div style={{ display: "flex", alignItems: "center", gap: mobile ? 12 : 20, marginBottom: 12, fontSize: mobile ? 13 : 12, flexShrink: 0, flexWrap: "wrap" }}>
              <span style={{ color: FG_MUTED }}>
                <span style={{ color: "#2D7A4A", fontWeight: 700 }}>{lotCounts.vacant}</span> vacant
              </span>
              <span style={{ color: FG_MUTED }}>
                <span style={{ color: "#6366F1", fontWeight: 700 }}>{lotCounts.reserved}</span> reserved
              </span>
              <span style={{ color: FG_MUTED }}>
                <span style={{ color: "#DC2626", fontWeight: 700 }}>{lotCounts.overdue}</span> overdue
              </span>
              <span style={{ color: FG_MUTED }}>
                <span style={{ color: FG, fontWeight: 700 }}>{lotCounts.total}</span> total
              </span>

              {process.env.NODE_ENV !== "production" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={handleSeedTestData} style={{ padding: "8px 16px", background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 6, color: "#f59e0b", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                    Seed Test Data
                  </button>
                  <button onClick={handleClearTestData} style={{ padding: "8px 16px", background: CARD_BG, border: `1px solid #ef4444`, borderRadius: 6, color: "#ef4444", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                    Clear Data
                  </button>
                </div>
              )}
            </div>

            {/* Lot map + detail panel */}
            <div style={{ flex: mobile ? "none" : 1, height: mobile ? "60vh" : undefined, display: "flex", flexDirection: mobile ? "column" : "row", overflow: "hidden", borderRadius: RADIUS, border: `1px solid ${BORDER}`, position: "relative" }}>
              <div style={{ flex: 1, overflow: "hidden" }}>
                <LotMapViewer
                  spots={allSpots}
                  statuses={lotStatuses}
                  selectedSpotId={selectedSpotId}
                  onSelectSpot={setSelectedSpotId}
                />
              </div>

              <SpotDetailPanel
                detail={selectedSpotId ? spotDetails[allSpots.find(s => s.id === selectedSpotId)?.label ?? ""] ?? null : null}
                open={selectedSpotId !== null}
                onClose={() => setSelectedSpotId(null)}
                mobile={mobile}
              />
            </div>
          </div>
        )}

        {/* ═══ SESSIONS ═══ */}
        {tab === "sessions" && (
          <div>
            {/* Filters */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
              {(["", "ACTIVE", "OVERSTAY", "COMPLETED", "CANCELLED"] as StatusFilter[]).map((s) => {
                const active = sessStatus === s;
                const label = s || "All";
                return (
                  <button key={label} onClick={() => setSessStatus(s)} style={chip(active, mobile)}>
                    {label}
                  </button>
                );
              })}

              <div style={{ flex: 1, minWidth: mobile ? "100%" : 180, maxWidth: mobile ? "100%" : 300 }}>
                <input
                  type="text"
                  placeholder="Search name, plate, spot…"
                  value={sessSearch}
                  onChange={(e) => setSessSearch(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <button
                onClick={() => { setNsForm(NS_DEFAULT); setNsErrors({}); setNsOpen(true); }}
                style={{ padding: "8px 16px", background: ACCENT, color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
              >
                + New Session
              </button>
            </div>

            {/* Results */}
            {sessionsLoading ? (
              <p style={{ color: FG_DIM, textAlign: "center", padding: 40 }}>Loading…</p>
            ) : !sessionsData || sessionsData.sessions.length === 0 ? (
              <p style={{ color: FG_DIM, textAlign: "center", padding: 40 }}>No sessions found.</p>
            ) : (
              <>
                {/* Count */}
                <div style={{ fontSize: 11, color: FG_DIM, marginBottom: 12 }}>
                  Showing {sessOffset + 1}–{Math.min(sessOffset + SESS_LIMIT, sessionsData.total)} of {sessionsData.total} sessions
                </div>

                {/* Session rows */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {sessionsData.sessions.map((s) => {
                    const isExpanded = sessExpanded === s.id;
                    const st = STATUS_STYLE[s.status] || STATUS_STYLE.COMPLETED;
                    const total = sumPayments(s.payments);
                    const vLabel = s.vehicle.unitNumber
                      ? `#${s.vehicle.unitNumber}` + (s.vehicle.licensePlate ? ` · ${s.vehicle.licensePlate}` : "")
                      : s.vehicle.licensePlate || "—";

                    return (
                      <div key={s.id}>
                        {/* Row */}
                        <div
                          onClick={() => setSessExpanded(isExpanded ? null : s.id)}
                          style={{
                            display: "grid",
                            gridTemplateColumns: mobile ? "auto 1fr auto" : "60px 1fr 1fr auto auto",
                            gap: mobile ? 8 : 12,
                            alignItems: "center",
                            padding: mobile ? "12px 14px" : "14px 16px",
                            background: isExpanded ? "#F4F4F5" : CARD_BG,
                            borderRadius: isExpanded ? `${RADIUS}px ${RADIUS}px 0 0` : RADIUS,
                            cursor: "pointer",
                            transition: "background 0.1s",
                          }}
                        >
                          {/* Spot */}
                          <div>
                            <div style={{ fontSize: mobile ? 14 : 15, fontWeight: 700, color: FG }}>{s.spot.label}</div>
                            <div style={{ fontSize: mobile ? 10 : 10, color: FG_DIM, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                              {s.spot.type === "BOBTAIL" ? "Bob" : "Truck"}
                            </div>
                          </div>

                          {/* Driver + vehicle */}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: FG, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {s.driver.name}
                              </div>
                              {s.payments.some(p => p.type === "MONTHLY_CHECKIN") && (
                                <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 6px", borderRadius: 4, background: "#EDE9FE", color: "#5B21B6", whiteSpace: "nowrap", flexShrink: 0 }}>
                                  Monthly
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: FG_DIM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {mobile ? (s.vehicle.licensePlate || vLabel) : vLabel}
                            </div>
                            {mobile && (
                              <div style={{ fontSize: 11, color: FG_DIM, marginTop: 2 }}>
                                {fmtDate(s.startedAt)} · {calcDuration(s.startedAt, s.endedAt)} · ${total.toFixed(2)}
                              </div>
                            )}
                          </div>

                          {/* Time — desktop only */}
                          {!mobile && (
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 12, color: FG_MUTED }}>{fmtDate(s.startedAt)}</div>
                              <div style={{ fontSize: 11, color: FG_DIM }}>
                                {s.status === "ACTIVE"
                                  ? `${timeRemaining(s.expectedEnd)} left`
                                  : calcDuration(s.startedAt, s.endedAt)}
                              </div>
                            </div>
                          )}

                          {/* Status + billing badges */}
                          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                            <span style={{
                              fontSize: mobile ? 9 : 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
                              padding: mobile ? "3px 8px" : "4px 10px", borderRadius: 4, background: st.bg, color: st.color,
                              whiteSpace: "nowrap",
                            }}>
                              {s.status}
                            </span>
                            {(() => {
                              const bs = BILLING_STATUS_STYLE[s.billingStatus];
                              return bs ? (
                                <span style={{
                                  fontSize: mobile ? 8 : 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
                                  padding: mobile ? "2px 6px" : "3px 8px", borderRadius: 4, background: bs.bg, color: bs.color,
                                  whiteSpace: "nowrap",
                                }}>
                                  {bs.label}
                                </span>
                              ) : null;
                            })()}
                          </div>

                          {/* Total — desktop only */}
                          {!mobile && (
                            <div style={{ fontSize: 13, fontWeight: 600, color: FG, fontVariantNumeric: "tabular-nums", textAlign: "right", minWidth: 60 }}>
                              ${total.toFixed(2)}
                            </div>
                          )}
                        </div>

                        {/* Expanded detail */}
                        {isExpanded && (
                          <div style={{
                            background: "#F4F4F5", borderRadius: `0 0 ${RADIUS}px ${RADIUS}px`,
                            padding: mobile ? "12px 14px 14px" : "0 16px 16px",
                            display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr 1fr", gap: mobile ? 16 : 20,
                          }}>
                            {/* Driver */}
                            <DetailCol title="Driver">
                              <DetailRow label="Name" value={s.driver.name} />
                              <DetailRow label="Email" value={s.driver.email ?? "—"} />
                              <DetailRow label="Phone" value={s.driver.phone} />
                            </DetailCol>

                            {/* Vehicle */}
                            <DetailCol title="Vehicle">
                              <DetailRow label="Type" value={s.vehicle.type === "BOBTAIL" ? "Bobtail" : "Truck/Trailer"} />
                              <DetailRow label="Unit #" value={s.vehicle.unitNumber || "—"} />
                              <DetailRow label="Plate" value={s.vehicle.licensePlate || "—"} />
                              {s.vehicle.nickname && <DetailRow label="Nickname" value={s.vehicle.nickname} />}
                            </DetailCol>

                            {/* Timing */}
                            {(() => {
                              const isMonthlySession = s.payments.some(p => p.type === "MONTHLY_CHECKIN");
                              const billingBadge = BILLING_STATUS_STYLE[s.billingStatus];
                              return (
                                <DetailCol title="Timing">
                                  <DetailRow label="Started" value={fmtDate(s.startedAt)} />
                                  <DetailRow label="Expected end" value={fmtDate(s.expectedEnd)} />
                                  {s.status === "ACTIVE" && (
                                    <DetailRow label="Remaining" value={timeRemaining(s.expectedEnd)} />
                                  )}
                                  <DetailRow label="Ended" value={fmtDate(s.endedAt)} />
                                  <DetailRow label="Duration" value={calcDuration(s.startedAt, s.endedAt)} />
                                  {isMonthlySession && (
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                                      <span style={{ fontSize: 11, color: FG_MUTED }}>Billing</span>
                                      {billingBadge ? (
                                        <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", padding: "2px 8px", borderRadius: 4, background: billingBadge.bg, color: billingBadge.color }}>
                                          {billingBadge.label}
                                        </span>
                                      ) : (
                                        <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", padding: "2px 8px", borderRadius: 4, background: "#DCFCE7", color: "#166534" }}>
                                          Current
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </DetailCol>
                              );
                            })()}

                            {/* Payments */}
                            <DetailCol title="Payments">
                              {(() => {
                                const subId = s.payments.find(p => p.stripeSubscriptionId)?.stripeSubscriptionId;
                                if (!subId) return null;
                                const stripeBase = settings?.stripeTestMode ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
                                return (
                                  <a
                                    href={`${stripeBase}/subscriptions/${subId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ fontSize: 11, color: "#6366F1", textDecoration: "none", display: "block", marginBottom: 8, fontWeight: 600 }}
                                  >
                                    Stripe Subscription ↗
                                  </a>
                                );
                              })()}
                              {s.payments.map((p) => (
                                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                                  <span style={{ color: p.type === "OVERSTAY" ? "#DC2626" : FG_MUTED }}>
                                    {p.type === "CHECKIN" ? "Daily"
                                      : p.type === "MONTHLY_CHECKIN" || p.type === "MONTHLY_RENEWAL" ? monthlyLabel(s.payments, p.id)
                                      : p.type === "EXTENSION" ? "Extension" : "Overstay"}
                                    {p.days ? ` (${p.days}d)` : ""}
                                  </span>
                                  {p.refundedAmount > 0 ? (
                                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                                      <span style={{ color: "#9CA3AF", textDecoration: "line-through", marginRight: 4 }}>${p.amount.toFixed(2)}</span>
                                      <span style={{ color: "#B45309", fontWeight: 600 }}>${(p.amount - p.refundedAmount).toFixed(2)}</span>
                                    </span>
                                  ) : (
                                    <span style={{ color: FG, fontVariantNumeric: "tabular-nums" }}>${p.amount.toFixed(2)}</span>
                                  )}
                                </div>
                              ))}
                              <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 6, paddingTop: 6, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                                <span style={{ color: FG, fontWeight: 600 }}>Total</span>
                                <span style={{ color: FG, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>${total.toFixed(2)}</span>
                              </div>
                            </DetailCol>

                            {/* View in QB link — only show if payments tab exists */}
                            <div style={{ gridColumn: mobile ? undefined : "1 / -1", display: "flex", gap: 8, marginTop: 4 }}>
                              <a
                                href={`/admin?tab=payments&q=${encodeURIComponent(s.driver.name)}`}
                                style={{ fontSize: 11, color: "#2563EB", textDecoration: "none" }}
                              >
                                View in Payments →
                              </a>
                            </div>

                            {/* Admin actions */}
                            {s.status !== "COMPLETED" && s.status !== "CANCELLED" && (
                              <div style={{ gridColumn: mobile ? undefined : "1 / -1", borderTop: `1px solid ${BORDER}`, paddingTop: 12, marginTop: 4 }}>
                                <button
                                  onClick={() => setManageSession(s)}
                                  style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #2D7A4A", background: "transparent", color: "#2D7A4A", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                                >
                                  Manage
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Pagination */}
                {sessionsData.total > SESS_LIMIT && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
                    <button onClick={() => setSessOffset(Math.max(0, sessOffset - SESS_LIMIT))} disabled={sessOffset === 0} style={paginationBtn(sessOffset === 0, mobile)}>
                      ← Newer
                    </button>
                    <span style={{ fontSize: 11, color: FG_DIM }}>
                      {sessOffset + 1}–{Math.min(sessOffset + SESS_LIMIT, sessionsData.total)} of {sessionsData.total}
                    </span>
                    <button onClick={() => setSessOffset(sessOffset + SESS_LIMIT)} disabled={!sessionsData.hasMore} style={paginationBtn(!sessionsData.hasMore, mobile)}>
                      Older →
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ═══ PAYMENTS ═══ */}
        {tab === "payments" && <PaymentsTab mobile={mobile} initialSearch={paymentsInitialSearch} />}
        {tab === "reconcile" && <ReconcileView mobile={mobile} />}

        {/* ═══ DRIVERS ═══ */}
        {tab === "drivers" && (
          <div>
            {/* Search */}
            <div style={{ marginBottom: 16 }}>
              <input
                type="text"
                placeholder="Search by name, phone, email, plate, unit #…"
                value={driversSearch}
                onChange={(e) => setDriversSearch(e.target.value)}
                style={{ ...inputStyle, maxWidth: mobile ? "100%" : 400 }}
              />
            </div>

            {/* Driver edit modal */}
            {editingDriver && (
              <div style={{ background: CARD_BG, borderRadius: RADIUS, border: `1px solid ${BORDER}`, padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
                  Edit Driver
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Name</label>
                    <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} style={{ ...inputStyle, borderColor: editErrors.name ? "#ef4444" : undefined }} />
                    {editErrors.name && <div style={{ fontSize: 11, color: "#ef4444", marginTop: 3 }}>{editErrors.name}</div>}
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Email <span style={{ color: FG_MUTED, fontWeight: 400 }}>(optional)</span></label>
                    <input type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} style={{ ...inputStyle, borderColor: editErrors.email ? "#ef4444" : undefined }} />
                    {editErrors.email && <div style={{ fontSize: 11, color: "#ef4444", marginTop: 3 }}>{editErrors.email}</div>}
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Phone</label>
                    <PhoneInput value={editForm.phone} onChange={(v) => setEditForm({ ...editForm, phone: v })} style={{ ...inputStyle, borderColor: editErrors.phone ? "#ef4444" : undefined }} />
                    {editErrors.phone && <div style={{ fontSize: 11, color: "#ef4444", marginTop: 3 }}>{editErrors.phone}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button onClick={handleSaveDriver} style={{ padding: "8px 18px", borderRadius: 6, border: "none", background: "#2D7A4A", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                      Save
                    </button>
                    <button onClick={() => setEditingDriver(null)} style={{ padding: "8px 18px", borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: FG_MUTED, fontSize: 13, cursor: "pointer" }}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Driver list */}
            {driversLoading ? (
              <p style={{ color: FG_DIM, textAlign: "center", padding: 40 }}>Loading…</p>
            ) : drivers.length === 0 ? (
              <p style={{ color: FG_DIM, textAlign: "center", padding: 40 }}>No drivers found.</p>
            ) : (
              <>
                <div style={{ fontSize: 11, color: FG_DIM, marginBottom: 10 }}>
                  {driversOffset + 1}–{Math.min(driversOffset + DRIVERS_LIMIT, driversTotal)} of {driversTotal} drivers
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {drivers.map((d) => {
                    const activeSession = d.sessions[0];
                    return (
                      <div
                        key={d.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: mobile ? "1fr auto" : "1fr 1fr auto auto",
                          gap: mobile ? 8 : 16,
                          alignItems: "center",
                          padding: mobile ? "12px 14px" : "14px 16px",
                          background: CARD_BG,
                          borderRadius: RADIUS,
                        }}
                      >
                        {/* Name + phone */}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: FG, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {d.name}
                          </div>
                          <div style={{ fontSize: 12, color: FG_DIM }}>
                            {d.phone} {d.email && <span style={{ color: FG_DIM }}>· {d.email}</span>}
                          </div>
                          {mobile && (
                            <div style={{ fontSize: 11, color: FG_DIM, marginTop: 2 }}>
                              {d.vehicles.length} vehicle{d.vehicles.length !== 1 ? "s" : ""} · {d._count.sessions} session{d._count.sessions !== 1 ? "s" : ""}
                              {activeSession && <span style={{ color: "#2D7A4A" }}> · Active @ {activeSession.spot.label}</span>}
                            </div>
                          )}
                        </div>

                        {/* Vehicles + sessions — desktop */}
                        {!mobile && (
                          <div style={{ fontSize: 12, color: FG_MUTED, minWidth: 0 }}>
                            <div>{d.vehicles.map((v) => v.licensePlate || v.unitNumber || "—").join(", ")}</div>
                            <div style={{ color: FG_DIM }}>{d._count.sessions} session{d._count.sessions !== 1 ? "s" : ""}</div>
                          </div>
                        )}

                        {/* Status */}
                        {!mobile && (
                          activeSession ? (
                            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "4px 10px", borderRadius: 4, background: "#DCFCE7", color: "#166534", whiteSpace: "nowrap" }}>
                              Active · {activeSession.spot.label}
                            </span>
                          ) : (
                            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "4px 10px", borderRadius: 4, background: CARD_BG, color: FG_DIM }}>
                              Inactive
                            </span>
                          )
                        )}

                        {/* Edit button */}
                        <button
                          onClick={() => {
                            setEditingDriver(d);
                            setEditForm({ name: d.name, email: d.email ?? "", phone: d.phone });
                            setEditErrors({});
                          }}
                          style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: FG_MUTED, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
                        >
                          Edit
                        </button>
                      </div>
                    );
                  })}
                </div>

                {/* Pagination */}
                {driversTotal > DRIVERS_LIMIT && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
                    <button onClick={() => setDriversOffset(Math.max(0, driversOffset - DRIVERS_LIMIT))} disabled={driversOffset === 0} style={paginationBtn(driversOffset === 0, mobile)}>
                      ← Prev
                    </button>
                    <span style={{ fontSize: 11, color: FG_DIM }}>
                      {driversOffset + 1}–{Math.min(driversOffset + DRIVERS_LIMIT, driversTotal)} of {driversTotal}
                    </span>
                    <button onClick={() => setDriversOffset(driversOffset + DRIVERS_LIMIT)} disabled={driversOffset + DRIVERS_LIMIT >= driversTotal} style={paginationBtn(driversOffset + DRIVERS_LIMIT >= driversTotal, mobile)}>
                      Next →
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ═══ LOG ═══ */}
        {tab === "log" && (
          <div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 20 }}>
              {LOG_CATEGORIES.map((cat) => (
                <button
                  key={cat.key}
                  onClick={() => { setLogFilter(cat.key); setLogOffset(0); }}
                  style={chip(logFilter === cat.key, mobile)}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            {logLoading ? (
              <p style={{ color: FG_DIM, textAlign: "center", padding: 40 }}>Loading…</p>
            ) : logEntries.length === 0 ? (
              <p style={{ color: FG_DIM, textAlign: "center", padding: 40 }}>No log entries.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {logEntries.map((entry) => {
                  const badge = ACTION_BADGE[entry.action] || { color: FG_MUTED, bg: CARD_BG, label: entry.action };
                  const timeStr = new Date(entry.createdAt).toLocaleString("en-US", {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
                  });
                  return (
                    <div key={entry.id} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", borderRadius: 8, background: CARD_BG }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
                        padding: "3px 8px", borderRadius: 4, background: badge.bg, color: badge.color,
                        whiteSpace: "nowrap", flexShrink: 0, marginTop: 2,
                      }}>
                        {badge.label}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: FG, lineHeight: 1.4 }}>{entry.details || "—"}</div>
                        <div style={{ fontSize: 11, color: FG_DIM, marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
                          <span>{timeStr}</span>
                          {entry.driver && <span>{entry.driver.name}</span>}
                          {entry.vehicle && <span>{entry.vehicle.licensePlate}</span>}
                          {entry.spot && <span>Spot {entry.spot.label}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {logTotal > LOG_LIMIT && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
                <button onClick={() => setLogOffset(Math.max(0, logOffset - LOG_LIMIT))} disabled={logOffset === 0} style={paginationBtn(logOffset === 0, mobile)}>← Newer</button>
                <span style={{ fontSize: 11, color: FG_DIM }}>{logOffset + 1}–{Math.min(logOffset + LOG_LIMIT, logTotal)} of {logTotal}</span>
                <button onClick={() => setLogOffset(logOffset + LOG_LIMIT)} disabled={logOffset + LOG_LIMIT >= logTotal} style={paginationBtn(logOffset + LOG_LIMIT >= logTotal, mobile)}>Older →</button>
              </div>
            )}
          </div>
        )}

        {/* ═══ SETTINGS ═══ */}
        {tab === "settings" && settingsForm && (
          <SettingsTab
            mobile={mobile}
            settingsForm={settingsForm}
            setSettingsForm={setSettingsForm}
            settings={settings}
            handleSaveSettings={handleSaveSettings}
            handleSandboxReset={handleSandboxReset}
          />
        )}

      </div>

      {/* ═══ NEW SESSION MODAL ═══ */}
      {nsOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setNsOpen(false); }}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.72)",
            zIndex: 200,
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            padding: "24px 16px 40px",
            overflowY: "auto",
          }}
        >
          <div style={{
            width: "100%", maxWidth: 560,
            background: DARK_BG,
            border: `1px solid ${BORDER}`,
            borderRadius: 16,
            overflow: "hidden",
            flexShrink: 0,
          }}>
            {/* Header */}
            <div style={{ padding: "18px 24px", borderBottom: `1px solid ${BORDER}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <p style={{ fontSize: 12, color: FG_DIM, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 2 }}>Admin</p>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: FG, margin: 0 }}>New Session</h2>
              </div>
              <button onClick={() => setNsOpen(false)} style={{ background: "none", border: "none", color: FG_DIM, fontSize: 22, cursor: "pointer", padding: "2px 6px", lineHeight: 1 }}>×</button>
            </div>

            <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>

              {/* ── Driver ── */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 12 }}>Driver</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div style={{ gridColumn: "1/-1" }}>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>
                      Full Name <span style={{ color: "#EF4444" }}>*</span>
                    </label>
                    <input
                      type="text"
                      value={nsForm.name}
                      onChange={(e) => nsSetField("name", e.target.value)}
                      placeholder="John Doe"
                      style={{ ...inputStyle, ...(nsErrors.name ? { borderColor: "#EF4444" } : {}) }}
                    />
                    {nsErrors.name && <p style={{ fontSize: 11, color: "#EF4444", marginTop: 3 }}>{nsErrors.name}</p>}
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>
                      Phone <span style={{ color: "#EF4444" }}>*</span>
                    </label>
                    <PhoneInput
                      value={nsForm.phone}
                      onChange={(v) => nsSetField("phone", v)}
                      placeholder="(555) 867-5309"
                      style={{ ...inputStyle, ...(nsErrors.phone ? { borderColor: "#EF4444" } : {}) }}
                    />
                    {nsErrors.phone && <p style={{ fontSize: 11, color: "#EF4444", marginTop: 3 }}>{nsErrors.phone}</p>}
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Email</label>
                    <input
                      type="email"
                      value={nsForm.email}
                      onChange={(e) => nsSetField("email", e.target.value)}
                      placeholder="driver@example.com"
                      style={{ ...inputStyle, ...(nsErrors.email ? { borderColor: "#EF4444" } : {}) }}
                    />
                    {nsErrors.email && <p style={{ fontSize: 11, color: "#EF4444", marginTop: 3 }}>{nsErrors.email}</p>}
                  </div>
                </div>
              </div>

              <div style={{ height: 1, background: BORDER }} />

              {/* ── Vehicle ── */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 12 }}>Vehicle</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div style={{ gridColumn: "1/-1" }}>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 6 }}>Type <span style={{ color: "#EF4444" }}>*</span></label>
                    <div style={{ display: "flex", gap: 8 }}>
                      {(["TRUCK_TRAILER", "BOBTAIL"] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => nsSetField("vehicleType", t)}
                          style={{
                            flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
                            border: `1px solid ${nsForm.vehicleType === t ? ACCENT : BORDER}`,
                            background: nsForm.vehicleType === t ? "rgba(45,122,74,0.18)" : "transparent",
                            color: nsForm.vehicleType === t ? ACCENT : FG_DIM,
                          }}
                        >
                          {t === "TRUCK_TRAILER" ? "Truck / Trailer" : "Bobtail"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>License Plate†</label>
                    <input
                      type="text"
                      value={nsForm.licensePlate}
                      onChange={(e) => nsSetField("licensePlate", e.target.value.toUpperCase())}
                      placeholder="ABC-1234"
                      style={{ ...inputStyle, ...(nsErrors.licensePlate ? { borderColor: "#EF4444" } : {}) }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Unit Number†</label>
                    <input
                      type="text"
                      value={nsForm.unitNumber}
                      onChange={(e) => nsSetField("unitNumber", e.target.value)}
                      placeholder="UNIT-001"
                      style={inputStyle}
                    />
                  </div>
                  {nsErrors.licensePlate && (
                    <p style={{ fontSize: 11, color: "#EF4444", gridColumn: "1/-1", marginTop: -6 }}>{nsErrors.licensePlate}</p>
                  )}
                  <div style={{ gridColumn: "1/-1" }}>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Nickname <span style={{ color: FG_DIM, fontWeight: 400 }}>(optional)</span></label>
                    <input
                      type="text"
                      value={nsForm.nickname}
                      onChange={(e) => nsSetField("nickname", e.target.value)}
                      placeholder="e.g. Red Kenworth"
                      style={inputStyle}
                    />
                  </div>
                  <p style={{ fontSize: 10, color: FG_DIM, gridColumn: "1/-1", marginTop: -4 }}>
                    † At least one of license plate or unit number is required.
                  </p>
                </div>
              </div>

              <div style={{ height: 1, background: BORDER }} />

              {/* ── Start ── */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 12 }}>Start</p>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 12 }}>
                  <input
                    type="checkbox"
                    checked={nsForm.startImmediately}
                    onChange={(e) => nsSetField("startImmediately", e.target.checked)}
                    style={{ width: 15, height: 15, accentColor: ACCENT, cursor: "pointer" }}
                  />
                  <span style={{ fontSize: 13, color: FG }}>Start immediately</span>
                </label>
                {!nsForm.startImmediately && (
                  <div style={{ display: "flex", gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Date <span style={{ color: "#EF4444" }}>*</span></label>
                      <input
                        type="date"
                        value={nsForm.startDate}
                        onChange={(e) => nsSetField("startDate", e.target.value)}
                        style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Time <span style={{ color: "#EF4444" }}>*</span></label>
                      <input
                        type="time"
                        value={nsForm.startTime}
                        onChange={(e) => nsSetField("startTime", e.target.value)}
                        style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div style={{ height: 1, background: BORDER }} />

              {/* ── Duration ── */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 12 }}>Duration</p>
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  {(["DAILY", "MONTHLY"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => nsSetField("durationType", t)}
                      style={{
                        flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
                        border: `1px solid ${nsForm.durationType === t ? ACCENT : BORDER}`,
                        background: nsForm.durationType === t ? "rgba(45,122,74,0.18)" : "transparent",
                        color: nsForm.durationType === t ? ACCENT : FG_DIM,
                      }}
                    >
                      {t === "DAILY" ? "Daily (1–30d)" : "Monthly (1–12mo)"}
                    </button>
                  ))}
                </div>
                {nsForm.durationType === "DAILY" ? (
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Days <span style={{ color: "#EF4444" }}>*</span></label>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button type="button" onClick={() => nsSetField("days", Math.max(1, nsForm.days - 1))}
                        style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: FG, fontSize: 18, cursor: "pointer" }}>−</button>
                      <input
                        type="number" min={1} max={30}
                        value={nsForm.days}
                        onChange={(e) => nsSetField("days", Math.min(30, Math.max(1, Number(e.target.value) || 1)))}
                        style={{ ...inputStyle, width: 70, textAlign: "center" }}
                      />
                      <button type="button" onClick={() => nsSetField("days", Math.min(30, nsForm.days + 1))}
                        style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: FG, fontSize: 18, cursor: "pointer" }}>+</button>
                      <span style={{ fontSize: 13, color: FG_DIM }}>days</span>
                    </div>
                    {nsErrors.days && <p style={{ fontSize: 11, color: "#EF4444", marginTop: 4 }}>{nsErrors.days}</p>}
                  </div>
                ) : (
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Months <span style={{ color: "#EF4444" }}>*</span></label>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button type="button" onClick={() => nsSetField("months", Math.max(1, nsForm.months - 1))}
                        style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: FG, fontSize: 18, cursor: "pointer" }}>−</button>
                      <input
                        type="number" min={1} max={12}
                        value={nsForm.months}
                        onChange={(e) => nsSetField("months", Math.min(12, Math.max(1, Number(e.target.value) || 1)))}
                        style={{ ...inputStyle, width: 70, textAlign: "center" }}
                      />
                      <button type="button" onClick={() => nsSetField("months", Math.min(12, nsForm.months + 1))}
                        style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: FG, fontSize: 18, cursor: "pointer" }}>+</button>
                      <span style={{ fontSize: 13, color: FG_DIM }}>months</span>
                    </div>
                    {nsErrors.months && <p style={{ fontSize: 11, color: "#EF4444", marginTop: 4 }}>{nsErrors.months}</p>}
                  </div>
                )}
              </div>

              <div style={{ height: 1, background: BORDER }} />

              {/* ── Spot ── */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 12 }}>Spot Assignment</p>
                <div style={{ display: "flex", gap: 8, marginBottom: nsForm.spotMode === "manual" ? 12 : 0 }}>
                  {(["auto", "manual"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => nsSetField("spotMode", m)}
                      style={{
                        flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
                        border: `1px solid ${nsForm.spotMode === m ? ACCENT : BORDER}`,
                        background: nsForm.spotMode === m ? "rgba(45,122,74,0.18)" : "transparent",
                        color: nsForm.spotMode === m ? ACCENT : FG_DIM,
                      }}
                    >
                      {m === "auto" ? "Auto-assign" : "Select spot"}
                    </button>
                  ))}
                </div>
                {nsForm.spotMode === "manual" && (
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>Available Spot <span style={{ color: "#EF4444" }}>*</span></label>
                    <select
                      value={nsForm.spotId}
                      onChange={(e) => nsSetField("spotId", e.target.value)}
                      style={{ ...inputStyle, width: "100%", cursor: "pointer", ...(nsErrors.spotId ? { borderColor: "#EF4444" } : {}) }}
                    >
                      <option value="">— Select a spot —</option>
                      {availableSpots
                        .filter((s) =>
                          nsForm.vehicleType === "BOBTAIL"
                            ? true // bobtails can overflow to truck spots
                            : s.type === "TRUCK_TRAILER"
                        )
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label} ({s.type === "TRUCK_TRAILER" ? "Truck" : "Bobtail"})
                          </option>
                        ))}
                    </select>
                    {nsErrors.spotId && <p style={{ fontSize: 11, color: "#EF4444", marginTop: 3 }}>{nsErrors.spotId}</p>}
                    {availableSpots.length === 0 && (
                      <p style={{ fontSize: 11, color: "#92400E", marginTop: 4 }}>No available spots — all spots occupied.</p>
                    )}
                  </div>
                )}
              </div>

              <div style={{ height: 1, background: BORDER }} />

              {/* ── Payment Reference ── */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: FG_DIM, letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 12 }}>Payment Reference</p>
                {!nsPaymentRequired && (
                  <p style={{ fontSize: 11, color: "#92400E", marginBottom: 12 }}>
                    Payments are disabled — fields are optional. A free session will be created.
                  </p>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>
                      Stripe ID{nsPaymentRequired && <span style={{ color: "#EF4444" }}> *</span>}
                    </label>
                    <input
                      type="text"
                      value={nsForm.stripeId}
                      onChange={(e) => nsSetField("stripeId", e.target.value.trim())}
                      placeholder="pi_xxx, in_xxx, ch_xxx…"
                      style={{ ...inputStyle, width: "100%", boxSizing: "border-box", ...(nsErrors.stripeId ? { borderColor: "#EF4444" } : {}) }}
                    />
                    {nsErrors.stripeId && (
                      <p style={{ fontSize: 11, color: "#EF4444", marginTop: 2 }}>{nsErrors.stripeId}</p>
                    )}
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: FG_DIM, display: "block", marginBottom: 4 }}>QB Receipt #</label>
                    <input
                      type="text"
                      value={nsForm.qbReceiptId}
                      onChange={(e) => nsSetField("qbReceiptId", e.target.value.trim())}
                      placeholder="e.g. 4521"
                      style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                    />
                  </div>
                </div>
              </div>

              {/* ── Submit ── */}
              {nsErrors._ && (
                <p style={{ fontSize: 13, color: "#EF4444", padding: "10px 14px", background: "rgba(239,68,68,0.1)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.25)" }}>
                  {nsErrors._}
                </p>
              )}

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  onClick={handleNewSession}
                  disabled={nsSubmitting}
                  style={{
                    flex: 1, padding: "14px 20px", background: nsSubmitting ? FG_DIM : ACCENT, color: "#fff",
                    border: "none", borderRadius: 10, fontWeight: 700, fontSize: 15,
                    cursor: nsSubmitting ? "default" : "pointer",
                  }}
                >
                  {nsSubmitting ? "Creating session…" : "Create Session"}
                </button>
                <button
                  type="button"
                  onClick={() => setNsOpen(false)}
                  style={{ padding: "14px 18px", background: "transparent", color: FG_DIM, border: `1px solid ${BORDER}`, borderRadius: 10, fontSize: 14, cursor: "pointer" }}
                >
                  Cancel
                </button>
              </div>

            </div>
          </div>
        </div>
      )}

    {manageSession && (
      <ManageSessionModal
        session={manageSession}
        settings={settings}
        onClose={() => setManageSession(null)}
        onSuccess={() => loadSessions()}
      />
    )}

</>
    </ToastProvider>
  );
}


function DetailCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: FG_DIM, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: 12, marginBottom: 4 }}>
      <span style={{ color: FG_DIM }}>{label}: </span>
      <span style={{ color: FG }}>{value}</span>
    </div>
  );
}
