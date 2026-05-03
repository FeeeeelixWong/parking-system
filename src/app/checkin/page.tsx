"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import defaultState from "@/components/lot/editor/defaultState.json";

import type { AppSettings, ApiVehicle } from "@/types/domain";
import { loadDriver, saveDriver, clearDriver } from "@/lib/driver-store";
import { apiFetch } from "@/lib/fetch";
import PhoneInput from "@/components/PhoneInput";

type Settings = Pick<
  AppSettings,
  | "dailyRateBobtail"
  | "dailyRateTruck"
  | "monthlyRateBobtail"
  | "monthlyRateTruck"
  | "overstayRateBobtail"
  | "overstayRateTruck"
  | "paymentRequired"
  | "bobtailOverflow"
  | "termsVersion"
  | "termsBody"
  | "gracePeriodMinutes"
>;
type Vehicle = ApiVehicle;
type DurationType = "DAILY" | "MONTHLY";

export default function CheckInPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg)" }}>
          <div className="animate-pulse" style={{ color: "var(--fg-muted)", fontFamily: "var(--font-display)" }}>
            <p className="text-2xl font-semibold tracking-wide uppercase">Loading...</p>
            <p className="text-sm mt-1" style={{ color: "var(--fg-subtle)" }}>Cargando...</p>
          </div>
        </div>
      }
    >
      <CheckInContent />
    </Suspense>
  );
}

/* ------------------------------------------------------------------ */
/*  Bilingual label helper                                             */
/* ------------------------------------------------------------------ */
function Label({ en, es, htmlFor }: { en: string; es: string; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block mb-1.5">
      <span className="text-[15px] font-semibold tracking-wide uppercase" style={{ color: "var(--fg)", fontFamily: "var(--font-display)" }}>
        {en}
      </span>
      <span className="ml-2 text-[12px] font-normal" style={{ color: "var(--fg-subtle)" }}>
        {es}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared input styles                                                */
/* ------------------------------------------------------------------ */
const inputClass =
  "w-full px-4 py-3.5 rounded-lg text-[16px] font-medium outline-none transition-all duration-150 border-2 placeholder:font-normal";
const inputStyle = {
  background: "var(--input-bg)",
  color: "var(--fg)",
  borderColor: "var(--border)",
};

/* ------------------------------------------------------------------ */
/*  Pick a random spot from API layout (or default state fallback)    */
/* ------------------------------------------------------------------ */
async function pickDemoSpot(vehicleType: "BOBTAIL" | "TRUCK_TRAILER"): Promise<string | null> {
  try {
    const res = await fetch("/api/spots/layout");
    const data = await res.json();
    const spotsMap = data.spots && Object.keys(data.spots).length > 0
      ? data.spots
      : defaultState.spots;
    const spots = Object.values(spotsMap as Record<string, { id: string; type: string }>)
      .filter((s) => s.type === vehicleType);
    if (!spots.length) return null;
    return spots[Math.floor(Math.random() * spots.length)].id;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Main form                                                          */
/* ------------------------------------------------------------------ */
function CheckInContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const existingDriverId = searchParams.get("driverId");
  const isDemo = searchParams.get("demo") === "1";
  const isLocked = searchParams.get("locked") === "true";
  const isNew = searchParams.get("new") === "true";

  const [name, setName] = useState(() => {
    if (existingDriverId && !isDemo && typeof window !== "undefined") {
      const saved = loadDriver();
      return saved?.name || "";
    }
    return "";
  });
  const [email, setEmail] = useState(isDemo ? "demo@example.com" : "");
  const [phone, setPhone] = useState(() => {
    if (isDemo) return "555-0100";
    if (existingDriverId && typeof window !== "undefined") {
      const saved = loadDriver();
      return saved?.phone || "";
    }
    return searchParams.get("prefillPhone") ?? "";
  });
  const [days, setDays] = useState(1);
  const [months, setMonths] = useState(1);
  const [_durationType, setDurationType] = useState<DurationType>("DAILY");
  const [settings, setSettings] = useState<Settings | null>(
    isDemo
      ? {
          dailyRateBobtail: 30,
          dailyRateTruck: 30,
          monthlyRateBobtail: 250,
          monthlyRateTruck: 400,
          overstayRateBobtail: 20,
          overstayRateTruck: 25,
          paymentRequired: false,
          bobtailOverflow: true,
          termsVersion: "demo",
          termsBody: "Demo mode — no terms acceptance required.",
          gracePeriodMinutes: 15,
        }
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Spot availability — checked on mount to warn if lot is full
  const [availableBobtail, setAvailableBobtail] = useState<number | null>(null);
  const [availableTruck, setAvailableTruck] = useState<number | null>(null);

  // Clickwrap consent state
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [overstayAuthorized, setOverstayAuthorized] = useState(false);

  // Locked mode (recognized/confirmed driver)
  const [fieldsLocked, setFieldsLocked] = useState(isLocked);
  const [showEditWarning, setShowEditWarning] = useState(false);
  // True while we're waiting for API verification in locked mode
  const [verifying, setVerifying] = useState(isLocked);

  // Vehicle state
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const [addingVehicle, setAddingVehicle] = useState(false);
  const [newUnitNumber, setNewUnitNumber] = useState("");
  const [newPlate, setNewPlate] = useState("");
  const [newVehicleType, setNewVehicleType] = useState<"BOBTAIL" | "TRUCK_TRAILER">("TRUCK_TRAILER");
  const [newNickname, setNewNickname] = useState("");

  // Prefill driver info — locked mode waits for API before populating anything
  useEffect(() => {
    if (existingDriverId || isDemo) return;

    if (isLocked) {
      // Read phone from localStorage only to make the API call — do NOT set any fields yet
      const saved = loadDriver();
      if (!saved) { router.replace("/entry"); return; }

      const savedPhone = saved.phone.replace(/\D/g, "");
      const savedId = saved.id;
      if (!savedPhone || !savedId) { router.replace("/entry"); return; }

      // Verify against API — only populate fields on confirmed match; also grab availability
      apiFetch<{ driver: { id: string; name: string; email: string | null; phone: string } | null; availability: { bobtailFree: number; truckFree: number } }>(
        `/api/driver/state?phone=${savedPhone}`
      )
        .then((data) => {
          if (data.driver?.id === savedId) {
            setName(data.driver.name || "");
            setEmail(data.driver.email || "");
            setPhone(data.driver.phone || "");
            setAvailableBobtail(data.availability.bobtailFree);
            setAvailableTruck(data.availability.truckFree);
          } else {
            clearDriver();
            router.replace("/entry");
          }
        })
        .catch(() => {
          router.replace("/entry");
        })
        .finally(() => setVerifying(false));
      return;
    }

    // No localStorage prefill for unverified state
    // prefillPhone is handled by the useState initializer above
  }, [existingDriverId, isDemo, isLocked, router, searchParams]);

  useEffect(() => {
    // Legacy sessionStorage key from the QB hosted-checkout flow —
    // cleared on every /checkin mount so stale data can't leak across
    // retries. No longer written in the new Stripe flow.
    try {
      sessionStorage.removeItem("pending_session");
    } catch {}

    if (!isDemo) {
      apiFetch<{ settings: Settings }>("/api/settings")
        .then((d) => setSettings(d.settings))
        .catch(() => setError("Could not load rates. Please refresh the page."));
    }
    // Demo settings are initialized in useState above

    // Check spot availability — skip when existingDriverId is set (that block fetches availability
    // alongside vehicles). Use driver state when we have a phone; fall back to GET /api/spots for
    // brand-new drivers who haven't entered a phone yet.
    if (!isDemo && !existingDriverId) {
      const savedPhone = loadDriver()?.phone?.replace(/\D/g, "");
      if (savedPhone) {
        apiFetch<{ availability: { bobtailFree: number; truckFree: number } }>(
          `/api/driver/state?phone=${savedPhone}`
        )
          .then((d) => {
            setAvailableBobtail(d.availability.bobtailFree);
            setAvailableTruck(d.availability.truckFree);
          })
          .catch(() => {});
      } else {
        apiFetch<{ spots: { type: string; sessions: unknown[] }[] }>("/api/spots")
          .then((d) => {
            const isFree = (s: { sessions: unknown[] }) => s.sessions.length === 0;
            setAvailableBobtail(d.spots.filter((s) => s.type === "BOBTAIL" && isFree(s)).length);
            setAvailableTruck(d.spots.filter((s) => s.type === "TRUCK_TRAILER" && isFree(s)).length);
          })
          .catch(() => {});
      }
    }

    // Locked mode: wait until phone is populated by the verified API response,
    // then fetch vehicles using the API-confirmed driver id (not raw localStorage)
    if (isLocked && !isDemo) {
      if (!phone) return; // still verifying — first useEffect will set phone once confirmed
      apiFetch<{ driver: { id: string } | null }>(`/api/drivers?phone=${phone.replace(/\D/g, "")}`)
        .then((data) => {
          if (!data.driver?.id) { setAddingVehicle(true); return; }
          return apiFetch<{ vehicles: Vehicle[] }>(`/api/vehicles?driverId=${data.driver.id}`);
        })
        .then((vd) => {
          if (vd?.vehicles?.length) {
            setVehicles(vd.vehicles);
            if (vd.vehicles.length === 1) setSelectedVehicleId(vd.vehicles[0].id);
          } else {
            setAddingVehicle(true);
          }
        })
        .catch(() => setAddingVehicle(true));
      return;
    }

    if (existingDriverId) {
      // name and phone are initialized from localStorage in useState initializers above

      if (!isDemo) {
        // Fetch vehicles and availability in parallel
        const savedPhone = loadDriver()?.phone?.replace(/\D/g, "");
        const fetchVehicles = apiFetch<{ vehicles: Vehicle[] }>(`/api/vehicles?driverId=${existingDriverId}`)
          .then((d) => {
            if (d.vehicles?.length) {
              setVehicles(d.vehicles);
              if (d.vehicles.length === 1) setSelectedVehicleId(d.vehicles[0].id);
            } else {
              setAddingVehicle(true);
            }
          })
          .catch(() => setAddingVehicle(true));

        if (savedPhone) {
          Promise.all([
            fetchVehicles,
            apiFetch<{ availability: { bobtailFree: number; truckFree: number } }>(
              `/api/driver/state?phone=${savedPhone}`
            ).then((d) => {
              setAvailableBobtail(d.availability.bobtailFree);
              setAvailableTruck(d.availability.truckFree);
            }).catch(() => {}),
          ]);
        }
      } else {
        Promise.resolve().then(() => setAddingVehicle(true));
      }
    } else {
      Promise.resolve().then(() => setAddingVehicle(true));
    }
  }, [existingDriverId, isDemo, isLocked, phone]);

  const selectedVehicle = vehicles.find((v) => v.id === selectedVehicleId);
  const vehicleType = selectedVehicle?.type || newVehicleType;

  // Monthly is truck/trailer only — compute durationType so bobtail always falls back to DAILY
  const durationType: DurationType = _durationType === "MONTHLY" && vehicleType === "BOBTAIL" ? "DAILY" : _durationType;

  // Effective spot availability for the selected vehicle type
  // Bobtails can use truck spots if overflow is enabled
  const overflowEnabled = settings?.bobtailOverflow ?? true;
  const effectiveBobtailAvailability =
    availableBobtail === null || availableTruck === null
      ? null
      : availableBobtail + (overflowEnabled ? availableTruck : 0);
  const effectiveTruckAvailability = availableTruck;
  const spotsAvailableForSelectedType =
    vehicleType === "BOBTAIL" ? effectiveBobtailAvailability : effectiveTruckAvailability;
  const lotFullForSelected = spotsAvailableForSelectedType === 0;
  const lotCompletelyFull =
    availableBobtail === 0 && availableTruck === 0;

  const dailyRate = settings
    ? vehicleType === "BOBTAIL"
      ? settings.dailyRateBobtail
      : settings.dailyRateTruck
    : 0;

  const monthlyRate = settings
    ? vehicleType === "BOBTAIL"
      ? settings.monthlyRateBobtail
      : settings.monthlyRateTruck
    : 0;

  const totalAmount =
    durationType === "MONTHLY" ? monthlyRate * months : dailyRate * days;

  /* ---------------------------------------------------------------- */
  /*  Demo submit — no API calls, pick spot from localStorage         */
  /* ---------------------------------------------------------------- */
  async function handleDemoSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError("Name is required / Se requiere nombre");
      return;
    }
    if (addingVehicle && !newUnitNumber && !newPlate) {
      setError("Truck # or license plate required / Se requiere # de camión o placa");
      return;
    }

    setLoading(true);

    // Simulate spot search
    await new Promise((r) => setTimeout(r, 1400));

    const spotId = await pickDemoSpot(vehicleType);
    if (!spotId) {
      setError("No spots available. Make sure the lot has spots in the editor.");
      setLoading(false);
      return;
    }

    const vehicleLabel = newUnitNumber
      ? `#${newUnitNumber}`
      : newPlate || "Unknown";

    const params = new URLSearchParams({
      spotId,
      name: name.trim(),
      vehicle: vehicleLabel,
      type: vehicleType,
      days: String(days),
    });

    router.push(`/spot-assigned?${params.toString()}`);
  }

  /* ---------------------------------------------------------------- */
  /*  Real submit                                                      */
  /* ---------------------------------------------------------------- */
  async function handleRealSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) {
      setError("Rates not loaded. Please refresh the page.");
      return;
    }
    if (!termsAccepted || !overstayAuthorized) {
      setError("Please read and accept the parking terms and overstay authorization.");
      return;
    }
    if (lotFullForSelected) {
      setError(
        vehicleType === "BOBTAIL"
          ? "No bobtail spots available. The lot is full."
          : "No truck/trailer spots available. The lot is full.",
      );
      return;
    }
    setLoading(true);
    setError("");

    try {
      const driverRes = await fetch("/api/drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone }),
      });
      const driverJson = await driverRes.json();
      const driver = driverJson.driver;

      if (!driver) {
        setError(driverJson.error || "Failed to register driver / No se pudo registrar");
        setLoading(false);
        return;
      }

      saveDriver({ id: driver.id, name, phone });

      let vehicleId = selectedVehicleId;

      if (addingVehicle || !vehicleId) {
        if (!newUnitNumber && !newPlate) {
          setError("Truck # or license plate is required / Se requiere # de camión o placa");
          setLoading(false);
          return;
        }
        const vehRes = await fetch("/api/vehicles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            driverId: driver.id,
            unitNumber: newUnitNumber || undefined,
            licensePlate: newPlate || undefined,
            type: newVehicleType,
            nickname: newNickname || undefined,
          }),
        });
        const { vehicle } = await vehRes.json();
        if (!vehicle) {
          setError("Failed to register vehicle / No se pudo registrar el vehículo");
          setLoading(false);
          return;
        }
        vehicleId = vehicle.id;
      }

      if (settings.paymentRequired) {
        // Redirect to Stripe Checkout. The webhook (handleCheckoutSessionCompleted)
        // creates the Session + Payment atomically before the driver's browser
        // lands on /payment-complete, so no sessionStorage handoff is needed —
        // /payment-complete reads the server-side Payment row by the
        // checkout_session_id in the URL.
        const checkoutRes = await fetch("/api/payments/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            driverId: driver.id,
            vehicleId,
            sessionPurpose: durationType === "MONTHLY" ? "MONTHLY_CHECKIN" : "CHECKIN",
            days: durationType === "DAILY" ? days : undefined,
            months: durationType === "MONTHLY" ? months : undefined,
            termsVersion: settings.termsVersion,
          }),
        });
        const checkoutData = await checkoutRes.json();

        if (!checkoutRes.ok || !checkoutData.checkoutUrl) {
          setError(checkoutData.error || "Could not create payment. Please try again.");
          setLoading(false);
          return;
        }

        window.location.href = checkoutData.checkoutUrl;
        return;
      }

      // No payment required — create session directly
      const sessionRes = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driverId: driver.id,
          vehicleId,
          durationType,
          ...(durationType === "DAILY" ? { days } : { months }),
          termsVersion: settings.termsVersion,
          overstayAuthorized: true,
        }),
      });
      const sessionData = await sessionRes.json();

      if (!sessionRes.ok) {
        setError(sessionData.error || "Failed to create session");
        setLoading(false);
        return;
      }

      router.push(`/confirmation`);
    } catch {
      setError("Something went wrong. Please try again. / Algo salió mal.");
      setLoading(false);
    }
  }

  const handleSubmit = isDemo ? handleDemoSubmit : handleRealSubmit;

  // Don't render the form until API verification completes
  if (verifying) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg)" }}>
        <div style={{ color: "var(--fg-muted)", fontFamily: "var(--font-display)", textAlign: "center" }}>
          <svg className="animate-spin h-6 w-6 mx-auto mb-3" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeDasharray="31.4" strokeLinecap="round" opacity="0.25"/>
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
          <p className="text-sm tracking-wide uppercase" style={{ color: "var(--fg-subtle)" }}>Verifying…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      {/* Header bar */}
      <div
        className="sticky top-0 z-10 px-5 py-4 border-b"
        style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-3">
          <h1
            className="text-2xl font-extrabold tracking-wider uppercase"
            style={{ fontFamily: "var(--font-display)", color: "var(--fg)" }}
          >
            Check In
          </h1>
          {isDemo && (
            <span
              className="px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-widest uppercase"
              style={{ background: "#0A84FF22", color: "#0A84FF", border: "1px solid #0A84FF44" }}
            >
              Demo
            </span>
          )}
        </div>
        <p className="text-xs mt-0.5" style={{ color: "var(--fg-subtle)" }}>
          {isDemo
            ? "Demo mode — no payment required · Modo demo"
            : isLocked
            ? `Welcome back${name ? `, ${name.split(" ")[0]}` : ""}. Your info is pre-filled.`
            : "Registro de entrada"}
        </p>
      </div>

      <form onSubmit={handleSubmit} autoComplete="off" className="max-w-lg mx-auto px-5 py-6 space-y-5">

        {/* ---- LOT AVAILABILITY WARNING ---- */}
        {!isDemo && lotCompletelyFull && (
          <div
            className="rounded-xl p-4 border-2"
            style={{
              background: "#FEF2F2",
              borderColor: "var(--error)",
              color: "var(--error)",
            }}
          >
            <div className="font-bold text-sm mb-1" style={{ fontFamily: "var(--font-display)", letterSpacing: "0.02em", textTransform: "uppercase" }}>
              Lot is full
            </div>
            <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
              All parking spots are currently occupied. Please come back later or contact the manager.
            </div>
          </div>
        )}
        {!isDemo && !lotCompletelyFull && lotFullForSelected && (
          <div
            className="rounded-xl p-4 border-2"
            style={{
              background: "#FFF7E6",
              borderColor: "#F59E0B",
              color: "#92400E",
            }}
          >
            <div className="font-bold text-sm mb-1" style={{ fontFamily: "var(--font-display)", letterSpacing: "0.02em", textTransform: "uppercase" }}>
              {vehicleType === "BOBTAIL" ? "No bobtail spots" : "No truck/trailer spots"}
            </div>
            <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
              {vehicleType === "BOBTAIL"
                ? "No bobtail spots are available. Try selecting a different vehicle type."
                : "No truck/trailer spots are available. Try selecting a different vehicle type."}
            </div>
          </div>
        )}

        {/* ---- DRIVER INFO ---- */}
        <section
          className="rounded-xl p-5 space-y-4 border"
          style={{ background: "var(--bg-card)", borderColor: fieldsLocked ? "var(--border)" : "var(--border)" }}
        >
          <div className="flex items-center gap-2 mb-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold text-white"
              style={{ background: "var(--accent)", fontFamily: "var(--font-display)" }}
            >
              1
            </div>
            <h2
              className="text-lg font-bold tracking-wide uppercase"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Driver Info
            </h2>
            <span className="text-xs" style={{ color: "var(--fg-subtle)" }}>
              Información del conductor
            </span>
            {fieldsLocked && !isDemo && (
              <span
                className="ml-auto text-[10px] px-2 py-0.5 rounded-full font-semibold tracking-widest uppercase"
                style={{ background: "rgba(48,209,88,0.12)", color: "#30D158", border: "1px solid rgba(48,209,88,0.25)" }}
              >
                Saved
              </span>
            )}
          </div>

          {/* New user convenience note */}
          {isNew && !isDemo && (
            <div
              className="rounded-lg px-4 py-3 text-xs leading-relaxed"
              style={{ background: "rgba(10,132,255,0.08)", border: "1px solid rgba(10,132,255,0.2)", color: "var(--fg-muted)", fontFamily: "var(--font-body, sans-serif)" }}
            >
              Your info will be saved on this device for faster check-ins next time.
            </div>
          )}

          <div>
            <Label en="Full Name" es="Nombre completo" htmlFor="name" />
            <input
              id="name"
              type="text"
              className={inputClass}
              style={{
                ...inputStyle,
                opacity: fieldsLocked ? 0.5 : 1,
                pointerEvents: fieldsLocked ? "none" : "auto",
                background: fieldsLocked ? "rgba(255,255,255,0.02)" : inputStyle.background,
              }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Smith"
              required
              autoComplete="name"
              readOnly={fieldsLocked}
              onFocus={(e) => !fieldsLocked && (e.target.style.borderColor = "var(--border-focus)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
            />
          </div>

          {!isDemo && (
            <>
              <div>
                <Label en="Email" es="Correo electrónico" htmlFor="email" />
                <input
                  id="email"
                  type="email"
                  className={inputClass}
                  style={{
                    ...inputStyle,
                    opacity: fieldsLocked ? 0.5 : 1,
                    pointerEvents: fieldsLocked ? "none" : "auto",
                    background: fieldsLocked ? "rgba(255,255,255,0.02)" : inputStyle.background,
                  }}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="driver@email.com"
                  required
                  autoComplete="email"
                  readOnly={fieldsLocked}
                  onFocus={(e) => !fieldsLocked && (e.target.style.borderColor = "var(--border-focus)")}
                  onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
                />
              </div>

              <div>
                <Label en="Phone" es="Teléfono" htmlFor="phone" />
                <PhoneInput
                  id="phone"
                  className={inputClass}
                  style={{
                    ...inputStyle,
                    opacity: fieldsLocked ? 0.5 : 1,
                    pointerEvents: fieldsLocked ? "none" : "auto",
                    background: fieldsLocked ? "rgba(255,255,255,0.02)" : inputStyle.background,
                  }}
                  value={phone}
                  onChange={setPhone}
                  placeholder="(555) 123-4567"
                  required
                  autoComplete="tel"
                  readOnly={fieldsLocked}
                  onFocus={(e) => !fieldsLocked && (e.target.style.borderColor = "var(--border-focus)")}
                  onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
                />
              </div>

              {/* Edit / Warning UI */}
              {fieldsLocked && !showEditWarning && (
                <button
                  type="button"
                  onClick={() => setShowEditWarning(true)}
                  className="text-xs font-semibold"
                  style={{ color: "var(--fg-subtle)", background: "none", border: "none", cursor: "pointer", letterSpacing: "0.05em" }}
                >
                  Edit info
                </button>
              )}

              {showEditWarning && (
                <div
                  className="rounded-lg px-4 py-3 space-y-3"
                  style={{ background: "rgba(255,159,10,0.08)", border: "1px solid rgba(255,159,10,0.25)" }}
                >
                  <p className="text-xs leading-relaxed" style={{ color: "rgba(255,200,100,0.85)" }}>
                    Editing will update your info for all future visits on this device.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setFieldsLocked(false); setShowEditWarning(false); }}
                      className="flex-1 py-2 rounded-md text-xs font-bold tracking-wider uppercase"
                      style={{ background: "rgba(255,159,10,0.2)", color: "#FF9F0A", border: "1px solid rgba(255,159,10,0.3)", cursor: "pointer" }}
                    >
                      Edit anyway
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowEditWarning(false)}
                      className="flex-1 py-2 rounded-md text-xs font-bold tracking-wider uppercase"
                      style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer" }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {/* ---- VEHICLE ---- */}
        <section
          className="rounded-xl p-5 space-y-4 border"
          style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-2 mb-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold text-white"
              style={{ background: "var(--accent)", fontFamily: "var(--font-display)" }}
            >
              2
            </div>
            <h2
              className="text-lg font-bold tracking-wide uppercase"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Vehicle
            </h2>
            <span className="text-xs" style={{ color: "var(--fg-subtle)" }}>
              Vehículo
            </span>
          </div>

          {/* Returning driver — vehicle picker */}
          {vehicles.length > 0 && !addingVehicle && (
            <div className="space-y-3">
              {vehicles.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setSelectedVehicleId(v.id)}
                  className="w-full text-left px-4 py-3.5 rounded-lg border-2 transition-all duration-150 flex items-center justify-between"
                  style={{
                    background: selectedVehicleId === v.id ? "var(--accent-light)" : "var(--input-bg)",
                    borderColor: selectedVehicleId === v.id ? "var(--accent)" : "var(--border)",
                  }}
                >
                  <div>
                    <span className="text-[15px] font-bold tracking-wider uppercase" style={{ fontFamily: "var(--font-display)" }}>
                      {v.unitNumber ? `#${v.unitNumber}` : v.licensePlate}
                    </span>
                    {v.unitNumber && v.licensePlate && (
                      <span className="ml-2 text-[13px]" style={{ color: "var(--fg-muted)" }}>
                        {v.licensePlate}
                      </span>
                    )}
                    <span className="ml-2 text-[13px]" style={{ color: "var(--fg-muted)" }}>
                      {v.type === "BOBTAIL" ? "Bobtail" : "Truck / Trailer"}
                    </span>
                    {v.nickname && (
                      <span className="ml-2 text-[12px] italic" style={{ color: "var(--fg-subtle)" }}>
                        {v.nickname}
                      </span>
                    )}
                  </div>
                  {selectedVehicleId === v.id && (
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                      <circle cx="10" cy="10" r="10" fill="var(--accent)" />
                      <path d="M6 10l3 3 5-6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setAddingVehicle(true)}
                className="w-full text-center py-3 rounded-lg border-2 border-dashed text-sm font-semibold transition-colors duration-150"
                style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
              >
                + Add New Vehicle / Agregar vehículo nuevo
              </button>
            </div>
          )}

          {/* New vehicle form */}
          {addingVehicle && (
            <div className="space-y-4">
              {vehicles.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAddingVehicle(false)}
                  className="text-sm font-semibold underline"
                  style={{ color: "var(--accent)" }}
                >
                  ← Use saved vehicle / Usar vehículo guardado
                </button>
              )}

              {/* Vehicle type */}
              <div>
                <Label en="Vehicle Type" es="Tipo de vehículo" />
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setNewVehicleType("TRUCK_TRAILER")}
                    className="rounded-lg border-2 p-4 text-center transition-all duration-150"
                    style={{
                      background: newVehicleType === "TRUCK_TRAILER" ? "var(--accent-light)" : "var(--input-bg)",
                      borderColor: newVehicleType === "TRUCK_TRAILER" ? "var(--accent)" : "var(--border)",
                    }}
                  >
                    <div className="text-3xl mb-1">🚛</div>
                    <div className="text-[14px] font-bold tracking-wide uppercase" style={{ fontFamily: "var(--font-display)" }}>
                      Truck & Trailer
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: "var(--fg-subtle)" }}>
                      Camión con remolque
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewVehicleType("BOBTAIL")}
                    className="rounded-lg border-2 p-4 text-center transition-all duration-150"
                    style={{
                      background: newVehicleType === "BOBTAIL" ? "var(--accent-light)" : "var(--input-bg)",
                      borderColor: newVehicleType === "BOBTAIL" ? "var(--accent)" : "var(--border)",
                    }}
                  >
                    <div className="text-3xl mb-1">🚚</div>
                    <div className="text-[14px] font-bold tracking-wide uppercase" style={{ fontFamily: "var(--font-display)" }}>
                      Bobtail
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: "var(--fg-subtle)" }}>
                      Solo cabina
                    </div>
                  </button>
                </div>
              </div>

              {/* Truck # */}
              <div>
                <Label en="Truck #" es="Número de camión" htmlFor="unitNumber" />
                <input
                  id="unitNumber"
                  type="text"
                  className={`${inputClass} uppercase tracking-widest`}
                  style={{ ...inputStyle, fontFamily: "var(--font-display)", fontSize: "18px", letterSpacing: "0.15em" }}
                  value={newUnitNumber}
                  onChange={(e) => setNewUnitNumber(e.target.value.toUpperCase())}
                  placeholder="4821"
                  autoCapitalize="characters"
                  onFocus={(e) => (e.target.style.borderColor = "var(--border-focus)")}
                  onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
                />
              </div>

              {/* License Plate */}
              <div>
                <Label en="License Plate" es="Placa" htmlFor="plate" />
                <input
                  id="plate"
                  type="text"
                  className={`${inputClass} uppercase tracking-widest`}
                  style={{ ...inputStyle, fontFamily: "var(--font-display)", fontSize: "18px", letterSpacing: "0.15em" }}
                  value={newPlate}
                  onChange={(e) => setNewPlate(e.target.value.toUpperCase())}
                  placeholder="ABC 1234"
                  autoCapitalize="characters"
                  onFocus={(e) => (e.target.style.borderColor = "var(--border-focus)")}
                  onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
                />
              </div>

              <p className="text-[12px] -mt-2" style={{ color: "var(--fg-subtle)" }}>
                At least one required / Se requiere al menos uno
              </p>

              {!isDemo && (
                <div>
                  <Label en="Nickname" es="Apodo (opcional)" htmlFor="nickname" />
                  <input
                    id="nickname"
                    type="text"
                    className={inputClass}
                    style={inputStyle}
                    value={newNickname}
                    onChange={(e) => setNewNickname(e.target.value)}
                    placeholder="e.g. Blue Kenworth"
                    onFocus={(e) => (e.target.style.borderColor = "var(--border-focus)")}
                    onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
                  />
                </div>
              )}
            </div>
          )}
        </section>

        {/* ---- PARKING DURATION ---- */}
        <section
          className="rounded-xl p-5 space-y-4 border"
          style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-2 mb-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold text-white"
              style={{ background: "var(--accent)", fontFamily: "var(--font-display)" }}
            >
              3
            </div>
            <h2
              className="text-lg font-bold tracking-wide uppercase"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Duration
            </h2>
            <span className="text-xs" style={{ color: "var(--fg-subtle)" }}>
              Duración
            </span>
          </div>

          {/* Duration type toggle: Daily / Monthly (monthly not available for bobtails) */}
          <div className="flex gap-2 mb-4">
            {(["DAILY", "MONTHLY"] as DurationType[]).map((dt) => {
              if (dt === "MONTHLY" && vehicleType === "BOBTAIL") return null;
              const active = durationType === dt;
              return (
                <button
                  key={dt}
                  type="button"
                  onClick={() => setDurationType(dt)}
                  className="flex-1 py-3 rounded-lg border-2 text-sm font-bold uppercase tracking-wider transition-all duration-150"
                  style={{
                    borderColor: active ? "var(--accent)" : "var(--border)",
                    background: active ? "var(--accent-light)" : "transparent",
                    color: active ? "var(--accent)" : "var(--fg-muted)",
                    fontFamily: "var(--font-display)",
                  }}
                >
                  {dt === "DAILY" ? "Daily" : "Monthly"}
                </button>
              );
            })}
          </div>

          {durationType === "DAILY" ? (
            <div>
              <Label en="Days" es="Días" />
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setDays(Math.max(1, days - 1))}
                  className="w-14 h-14 rounded-lg border-2 flex items-center justify-center text-2xl font-bold transition-colors duration-150 select-none"
                  style={{
                    borderColor: "var(--border)",
                    color: days <= 1 ? "var(--fg-subtle)" : "var(--fg)",
                    background: "var(--input-bg)",
                    fontFamily: "var(--font-display)",
                  }}
                >
                  −
                </button>
                <div className="flex-1 text-center">
                  <span className="text-5xl font-extrabold" style={{ fontFamily: "var(--font-display)", color: "var(--fg)" }}>
                    {days}
                  </span>
                  <span className="text-lg ml-1 font-semibold" style={{ color: "var(--fg-muted)", fontFamily: "var(--font-display)" }}>
                    day{days !== 1 ? "s" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setDays(Math.min(30, days + 1))}
                  className="w-14 h-14 rounded-lg border-2 flex items-center justify-center text-2xl font-bold transition-colors duration-150 select-none"
                  style={{
                    borderColor: "var(--border)",
                    color: days >= 30 ? "var(--fg-subtle)" : "var(--fg)",
                    background: "var(--input-bg)",
                    fontFamily: "var(--font-display)",
                  }}
                >
                  +
                </button>
              </div>
              <div className="flex gap-2 mt-3">
                {[1, 3, 7, 14, 30].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDays(d)}
                    className="flex-1 py-2 rounded-md border text-sm font-semibold transition-all duration-150"
                    style={{
                      borderColor: days === d ? "var(--accent)" : "var(--border)",
                      background: days === d ? "var(--accent-light)" : "transparent",
                      color: days === d ? "var(--accent)" : "var(--fg-muted)",
                      fontFamily: "var(--font-display)",
                    }}
                  >
                    {d}d
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <Label en="Months" es="Meses" />
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setMonths(Math.max(1, months - 1))}
                  className="w-14 h-14 rounded-lg border-2 flex items-center justify-center text-2xl font-bold transition-colors duration-150 select-none"
                  style={{
                    borderColor: "var(--border)",
                    color: months <= 1 ? "var(--fg-subtle)" : "var(--fg)",
                    background: "var(--input-bg)",
                    fontFamily: "var(--font-display)",
                  }}
                >
                  −
                </button>
                <div className="flex-1 text-center">
                  <span className="text-5xl font-extrabold" style={{ fontFamily: "var(--font-display)", color: "var(--fg)" }}>
                    {months}
                  </span>
                  <span className="text-lg ml-1 font-semibold" style={{ color: "var(--fg-muted)", fontFamily: "var(--font-display)" }}>
                    mo{months !== 1 ? "s" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setMonths(Math.min(12, months + 1))}
                  className="w-14 h-14 rounded-lg border-2 flex items-center justify-center text-2xl font-bold transition-colors duration-150 select-none"
                  style={{
                    borderColor: "var(--border)",
                    color: months >= 12 ? "var(--fg-subtle)" : "var(--fg)",
                    background: "var(--input-bg)",
                    fontFamily: "var(--font-display)",
                  }}
                >
                  +
                </button>
              </div>
              <div className="flex gap-2 mt-3">
                {[1, 3, 6, 12].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMonths(m)}
                    className="flex-1 py-2 rounded-md border text-sm font-semibold transition-all duration-150"
                    style={{
                      borderColor: months === m ? "var(--accent)" : "var(--border)",
                      background: months === m ? "var(--accent-light)" : "transparent",
                      color: months === m ? "var(--accent)" : "var(--fg-muted)",
                      fontFamily: "var(--font-display)",
                    }}
                  >
                    {m} mo
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ---- PRICE SUMMARY + SUBMIT ---- */}
        <section
          className="rounded-xl p-5 border"
          style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
        >
          <div className="flex justify-between items-baseline mb-1">
            <span className="text-sm font-medium" style={{ color: "var(--fg-muted)" }}>
              Rate / Tarifa
            </span>
            <span className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
              {durationType === "MONTHLY"
                ? `$${monthlyRate.toFixed(2)}/mo`
                : `$${dailyRate.toFixed(2)}/day`}
            </span>
          </div>
          <div className="flex justify-between items-baseline mb-1">
            <span className="text-sm font-medium" style={{ color: "var(--fg-muted)" }}>
              Duration / Duración
            </span>
            <span className="text-sm font-semibold" style={{ fontFamily: "var(--font-display)" }}>
              {durationType === "MONTHLY"
                ? `${months} mo${months !== 1 ? "s" : ""}`
                : `${days} day${days !== 1 ? "s" : ""}`}
            </span>
          </div>
          <div
            className="border-t pt-3 mt-3 flex justify-between items-baseline"
            style={{ borderColor: "var(--border)" }}
          >
            <span className="text-base font-bold" style={{ fontFamily: "var(--font-display)" }}>
              Total
            </span>
            {isDemo ? (
              <span
                className="text-xl font-bold"
                style={{ fontFamily: "var(--font-display)", color: "#0A84FF" }}
              >
                Demo — no charge
              </span>
            ) : (
              <span className="text-3xl font-extrabold" style={{ fontFamily: "var(--font-display)", color: "var(--fg)" }}>
                ${durationType === "MONTHLY" ? monthlyRate.toFixed(2) : totalAmount.toFixed(2)}
                {durationType === "MONTHLY" && <span className="text-base font-normal" style={{ color: "var(--fg-dim)" }}>/mo</span>}
              </span>
            )}
          </div>
        </section>

        {/* ---- TERMS & CONSENT ---- */}
        {!isDemo && settings && (
          <section
            className="rounded-xl p-5 space-y-4 border"
            style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
          >
            <div className="flex items-center gap-2 mb-1">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold text-white"
                style={{ background: "var(--accent)", fontFamily: "var(--font-display)" }}
              >
                4
              </div>
              <h2 className="text-lg font-bold tracking-wide uppercase" style={{ fontFamily: "var(--font-display)" }}>
                Terms & Authorization
              </h2>
            </div>

            {/* Scrollable terms box */}
            <div
              className="rounded-lg p-4 text-xs leading-relaxed whitespace-pre-wrap"
              style={{
                background: "var(--input-bg)",
                border: "1px solid var(--border)",
                color: "var(--fg-muted)",
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {settings.termsBody || "Terms not configured. Please contact the manager."}
            </div>
            <div className="text-[10px] font-semibold" style={{ color: "var(--fg-subtle)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Version {settings.termsVersion}
            </div>

            {/* Consent checkboxes */}
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="mt-1 flex-shrink-0"
                style={{ width: 18, height: 18, accentColor: "var(--accent)" }}
              />
              <span className="text-sm" style={{ color: "var(--fg)" }}>
                I have read and agree to the parking terms above.
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={overstayAuthorized}
                onChange={(e) => setOverstayAuthorized(e.target.checked)}
                className="mt-1 flex-shrink-0"
                style={{ width: 18, height: 18, accentColor: "var(--accent)" }}
              />
              <span className="text-sm" style={{ color: "var(--fg)" }}>
                I authorize automatic charging of my payment method for overstay fees at the posted rate (
                <strong>
                  ${vehicleType === "BOBTAIL" ? settings.overstayRateBobtail : settings.overstayRateTruck}/day
                </strong>
                {" "}after a {settings.gracePeriodMinutes}-minute grace period), billed per day or portion thereof.
              </span>
            </label>
          </section>
        )}

        {/* Error */}
        {error && (
          <div
            className="rounded-lg px-4 py-3 text-sm font-medium border"
            style={{ background: "#FEF2F2", borderColor: "#FECACA", color: "var(--error)" }}
          >
            {error}
          </div>
        )}

        {/* Submit button */}
        {(() => {
          const consentMissing = !isDemo && (!termsAccepted || !overstayAuthorized);
          const disabled = loading || (!isDemo && lotFullForSelected) || consentMissing;
          return (
            <button
              type="submit"
              disabled={disabled}
              className="w-full py-4 rounded-xl text-lg font-bold tracking-wider uppercase text-white transition-all duration-150 active:scale-[0.98]"
              style={{
                background: disabled
                  ? "var(--fg-subtle)"
                  : isDemo
                  ? "#0A84FF"
                  : "var(--accent)",
                fontFamily: "var(--font-display)",
                boxShadow: disabled
                  ? "none"
                  : isDemo
                  ? "0 4px 12px rgba(10, 132, 255, 0.35)"
                  : "0 4px 12px rgba(45, 122, 74, 0.3)",
                cursor: disabled ? "not-allowed" : undefined,
              }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeLinecap="round" />
                  </svg>
                  {isDemo ? "Finding your spot..." : "Processing..."}
                </span>
              ) : !isDemo && lotFullForSelected ? (
                "Lot Full — No Spots Available"
              ) : consentMissing ? (
                "Accept Terms to Continue"
              ) : isDemo ? (
                "Find My Spot →"
              ) : durationType === "MONTHLY" ? (
                <>Subscribe ${monthlyRate.toFixed(2)}/mo &amp; Check In</>
              ) : (
                <>Pay ${totalAmount.toFixed(2)} &amp; Check In</>
              )}
            </button>
          );
        })()}

        <p className="text-center text-xs pb-6" style={{ color: "var(--fg-subtle)" }}>
          {isDemo
            ? "A spot will be assigned on the lot map / Se asignará un lugar en el mapa"
            : durationType === "MONTHLY"
              ? `Suscribirse $${monthlyRate.toFixed(2)}/mes · renueva automáticamente`
              : `Pagar $${totalAmount.toFixed(2)} y registrar entrada`}
        </p>
      </form>
    </div>
  );
}
