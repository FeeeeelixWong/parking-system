@AGENTS.md

# ParkLogic — QR-Based Truck Parking Management System

## Overview

A full-stack Next.js 16 parking management system for a single truck parking lot in Texas.
Drivers scan a QR code at the gate, check in via their phone (no app download), pay, and
get assigned a spot. The admin (lot owner) manages everything from a mobile-friendly dashboard.

**Stack**: Next.js 16 App Router, Prisma 7.5 + Neon PostgreSQL, Stripe (PaymentIntents for
one-time, Subscriptions for monthly), QuickBooks (write-only accounting mirror via Sales Receipts),
Tailwind v4, Vercel hosting.

**Branches**:
- `main` — production. Stripe payments live. QB is accounting output.
- `data-model-cleanup` — schema/type cleanup, domain service extraction (in progress)
- `cleanup/architecture` — broader architecture cleanup (in progress)
- `quickbooks-payments` — old abandoned QB Payments branch (superseded by Stripe)
- `square-payments` — abandoned. Do not use.

---

## Driver Flow

```
                        ┌──────────┐
                        │  / (hub) │
                        └────┬─────┘
                             │
               ┌─────────────┼──────────────┐
               ▼             ▼              ▼
          /entry         /checkin?demo=1    /checkin
          (identity)     (demo mode)       (→ redirect to /entry)
               │              │
    ┌──────────┴────┐         │
    ▼               ▼         ▼
 /checkin         /checkin   /spot-assigned
 ?locked=true     ?new=true      │
    │               │            ├→ /lot (view map)
    └───────┬───────┘            └→ /entry (done)
            ▼
     /confirmation
            │
            ▼
     /welcome?driverId=X
        │          │
   ┌────┴────┐     └─────────┐
   ▼         ▼               ▼
 /exit    /extend          /checkin (new session)
   │         │
 exited   /confirmation → /welcome

Gate QR codes (two physical laminated QR codes):
  Entry gate → /entry (auto-opens gate if active session)
  Exit gate  → /exit  (auto-opens gate, shows session info)
```

**Entry page flow** (`/entry`):
1. Mount: check `parking_driver` in localStorage
2. If saved: verify against `GET /api/drivers?phone=X` (ID must match)
3. Check allow list first (`GET /api/allowlist?phone=X`) — if on list, gate opens, no session needed
4. If driver verified: check `activeSessions` in the API response
   - ACTIVE session → auto-fire `POST /api/gate` (direction=ENTRANCE), show session info
   - OVERSTAY → show fee screen, link to `/exit` for settlement
   - No session → "Welcome back, check in" screen
5. If not saved: show "New driver / Returning driver" menu
6. Phone lookup → if has active session, gate opens immediately
7. Gate only auto-fires on fresh external navigation (not refresh, not internal link)

**Exit page flow** (`/exit`):
1. Same identity flow as entry
2. ACTIVE session → auto-fire `POST /api/gate` (direction=EXIT), show "Gate opening, spot still reserved"
3. OVERSTAY → show fee + "Settle overstay & open gate" button (calls `POST /api/sessions/exit`)
4. No session → "No active session" message

---

## Session Model

Sessions are **time-based reservations** (hotel model), NOT gate passes.

- **Session = reservation.** Driver pays for X days or X months, spot is theirs until `expectedEnd`.
- **Gate is decoupled from session.** Both entry and exit scans call `POST /api/gate`
  which opens the gate and logs the direction. Neither ends the session.
- **Sessions expire by time.** When `expectedEnd` passes → grace period → cron flips
  to OVERSTAY → manager walks lot and overrides false positives.
- **No explicit checkout.** Scan, gate opens, drive through. No prompts.
- **Overstay settlement** uses `POST /api/sessions/exit` — only called when a driver
  is overstayed and pays the fee. This + manager override are the only paths that
  complete a session programmatically.
- **Pricing tiers**: Daily (1-30 days) and Monthly (1-12 months). Selected at check-in.
  Monthly sessions just set `expectedEnd` further out — same gate/overstay logic.

---

## Admin Dashboard (`/admin`)

Six tabs:

| Tab | Purpose |
|-----|---------|
| **Overview** | Live lot map (LotMapViewer) with spot status colors. Click a spot for detail panel. |
| **Sessions** | Filterable session list (All/Active/Overstay/Completed). Expandable rows with driver/vehicle/timing/payments. Admin actions: Extend Time, Close & Backdate, Cancel Session. |
| **Payments** | Revenue chart (30-day bar graph), summary cards, payment list with Stripe links (Charge ↗, Customer ↗), pending subscriptions, Stripe reconcile, QB receipt sync. |
| **Drivers** | Searchable driver list with edit (name/email/phone), vehicle info, active session status. |
| **Log** | Audit event feed with filter chips (Entry, Exit, Extension, Overstay, Gate, Admin, Notification, Security). All gate opens, denials, suspicious entries logged. |
| **Settings** | Rates (daily, monthly, overstay), notifications, spot config, payment toggle, bobtail overflow, parking terms (clickwrap), QB connection, allow list management. |

**Auth**: JWT cookie via `src/proxy.ts` (Next.js 16 convention, not `middleware.ts`). Admin password in env var. 8-hour token expiry.

---

## Gate Security

**Layer 1 (DONE):** `POST /api/gate` requires a valid `sessionId` OR `allowListPhone`.
Validates session exists, is ACTIVE or OVERSTAY, driver matches. OVERSTAY sessions can
exit but not enter. Rejects with 403 + logs `GATE_DENIED` with full details.

**Allow list path**: `POST /api/gate` with `allowListPhone` — checks AllowList table,
opens gate if active, logs `ALLOWLIST_ENTRY`. No session needed.

**Refresh protection**: Entry page auto-gate only fires on fresh external navigation
(PerformanceNavigationTiming + document.referrer check). Refresh, back button, internal
links, and shared URLs do NOT trigger the gate — shows "Please re-scan QR" instead.

**Device tracking**: `parking_device_id` in localStorage (survives driver resets).
Sent with every gate call. Two consecutive ENTRANCEs from different devices on the
same session → `SUSPICIOUS_ENTRY` logged.

**Layer 2 (TODO):** Dynamic QR codes with short-lived tokens.
**Layer 3 (TODO):** Hardware-level auth (Shelly WiFi relay on private network).

---

## Key File Map

### Lib (shared modules)
| File | Purpose |
|------|---------|
| `src/lib/driver-store.ts` | localStorage: `loadDriver()`, `saveDriver()`, `clearDriver()`, `getDeviceId()` |
| `src/lib/fetch.ts` | `apiFetch<T>()`, `apiPost<T>()` — typed fetch with automatic `res.ok` check |
| `src/lib/rates.ts` | `dailyRate()`, `monthlyRate()`, `overstayRate()`, `addDays()`, `addMonths()`, `ceilDays()` |
| `src/lib/time.ts` | `timeRemaining()`, `timeOverdue()`, `vehicleLabel()` — shared display helpers |
| `src/lib/spots.ts` | `assignSpot()` (with bobtail overflow), `freeSpot()` |
| `src/lib/stripe.ts` | Stripe SDK client: `getStripe()`, `stripeConfigured()`, `listRecentCharges()` |
| `src/lib/quickbooks.ts` | QB accounting output only — writes Sales Receipts, not payment processing |
| `src/lib/audit.ts` | `log()` — writes to AuditLog table |
| `src/lib/gate.ts` | `triggerGateOpen()` — **STUB**, replace with Shelly HTTP call for production |
| `src/lib/hooks.ts` | `useIsMobile()` — viewport < 640px detection |
| `src/lib/auth.ts` | JWT sign/verify, cookie management, `requireAdmin()`, `checkAdminPassword()` |
| `src/lib/settings.ts` | `getSettings()` — reads/creates default Settings row |
| `src/lib/env.ts` | Zod validation of environment variables at boot |
| `src/lib/schemas.ts` | All Zod schemas for API request validation |

### API Routes
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/gate` | POST | Open gate (requires sessionId or allowListPhone) |
| `/api/drivers` | GET, POST | Driver lookup (phone/email), upsert |
| `/api/vehicles` | GET, POST | Vehicle CRUD by driver |
| `/api/sessions` | GET, POST | List active sessions, create new session |
| `/api/sessions/exit` | POST | Overstay fee settlement |
| `/api/sessions/extend` | POST | Extend session days |
| `/api/sessions/history` | GET | Paginated session history with filters |
| `/api/spots` | GET | All spots with active sessions (for lot map) |
| `/api/spots/layout` | GET, PUT | Lot editor state (spots + groups) — admin only for PUT |
| `/api/settings` | GET, PUT | App settings (strips sensitive tokens from GET response) |
| `/api/audit` | GET | Audit log entries with action/pagination filters |
| `/api/allowlist` | GET | Check phone against allow list (public) |
| `/api/payments/checkout` | POST | Create Stripe Checkout session; return URL for redirect |
| `/api/payments/lookup` | GET | Poll for Payment row after Stripe Checkout redirect |
| `/api/stripe/webhook` | POST | Stripe webhook: creates sessions/payments, writes QB receipts |
| `/api/admin/drivers` | GET, PUT | Admin driver search + edit |
| `/api/admin/sessions` | PUT | Admin session actions (extend/cancel/close with backdate) |
| `/api/admin/payments` | GET | Payment list with summary + daily revenue chart data |
| `/api/admin/payments/pending` | GET | Past-due subscriptions |
| `/api/admin/payments/sync-batch` | POST | Batch sync QB receipts |
| `/api/admin/spots/override` | POST | Manager override to free a spot |
| `/api/admin/allowlist` | GET, POST, PUT, DELETE | Allow list CRUD |
| `/api/admin/reconcile` | GET | Session/payment chain health checks |
| `/api/admin/reconcile/stripe-db` | POST | Stripe-vs-DB divergence check |
| `/api/admin/reconcile/charges-receipts` | GET | Charges vs QB receipts reconciliation |
| `/api/cron/check-sessions` | GET | Expiry reminders, OVERSTAY detection, manager alerts |
| `/api/dev/seed` | POST | Seed test data (dev only) |
| `/api/auth/login` | POST | Admin login |
| `/api/auth/logout` | POST | Clear auth cookie |
| `/api/auth/me` | GET | Current auth status |

### Components
| File | Purpose |
|------|---------|
| `src/components/lot/LotMapViewer.tsx` | Read-only SVG lot map with status colors, click-to-select |
| `src/components/lot/LotMap.tsx` | Full lot map component (used by lot-preview) |
| `src/components/lot/LotMapEditor.tsx` | Interactive lot layout editor |
| `src/components/lot/editor/*` | Editor state management (useEditorReducer, types, geometry, validation) |
| `src/components/PhoneInput.tsx` | Digits-only phone input with auto-format `(555) 867-5309` |
| `src/app/lot/SpotDetailPanel.tsx` | Slide-out panel showing spot/session detail (bottom sheet on mobile) |

### Types
- `src/types/domain.ts` — ALL shared types. Never define inline types in pages.
  Includes: `ApiDriver`, `ApiVehicle`, `ApiSession`, `ApiSpot`, `ApiPayment`,
  `AppSettings`, `SavedDriver`, `DriverActiveSession`, `OverstayInfo`,
  `SpotLayout`, `LotSpotStatus`, `LotSpotDetail`, `LOT_STATUS_COLORS`.

---

## Data Model (Prisma)

**Enums**: `VehicleType` (BOBTAIL, TRUCK_TRAILER), `SpotStatus` (AVAILABLE, OCCUPIED),
`SessionStatus` (ACTIVE, COMPLETED, OVERSTAY, CANCELLED), `PaymentType` (CHECKIN,
MONTHLY_CHECKIN, MONTHLY_RENEWAL, EXTENSION, OVERSTAY), `AuditAction` (12 values
including GATE_DENIED, SUSPICIOUS_ENTRY, ALLOWLIST_ENTRY).

**Key models**:
- `Driver` — phone (unique), name, email, stripeCustomerId, stripePaymentMethodId
- `Vehicle` — driverId FK, unitNumber, licensePlate, type, nickname
- `Spot` — label (unique), type, status, cx/cy/w/h/rot (SVG layout)
- `Session` — driverId, vehicleId, spotId, startedAt, expectedEnd, status,
  billingStatus (CURRENT | PAYMENT_FAILED), termsVersion, overstayAuthorized
- `Payment` — sessionId, type, stripeCheckoutSessionId, stripePaymentIntentId,
  stripeChargeId, stripeSubscriptionId, stripeInvoiceId, qbSalesReceiptId,
  legacyQbReference, days, amount, status (COMPLETED/REFUNDED/VOIDED/DISPUTED),
  refundedAmount
- `PaymentRefund` — paymentId, stripeRefundId, qbRefundReceiptId, amount
- `StripeEvent` — deduplicate webhook events
- `AuditLog` — action, sessionId?, driverId?, vehicleId?, spotId?, details
- `Settings` — all config in one row (dailyRateBobtail, dailyRateTruck, rates, terms,
  QB tokens, lotGroups JSON, stripeReconcileFlaggedIds, lastStripeWebhookAt,
  lastStripeReconcileAt)
- `AllowList` — phone (unique), name, label (Employee/Family/Vendor/Contractor), active

---

## Key Conventions

- **localStorage**: single key `parking_driver` via `src/lib/driver-store.ts` — never use raw localStorage
- **Device ID**: `parking_device_id` via `getDeviceId()` — persists across driver resets
- **Fetch**: always use `apiFetch` / `apiPost` from `src/lib/fetch.ts` — throws on non-2xx
- **Identity**: localStorage is never trusted — always verify against `/api/drivers?phone=X` before prefilling
- **Session status lifecycle**: ACTIVE → OVERSTAY (cron) → COMPLETED (exit/override)
- **Shared types**: `src/types/domain.ts` — never define inline Driver/Vehicle/Session types in pages
- **Phone numbers**: always use `<PhoneInput>` component, store digits-only in DB
- **Stripe identifiers**: stored as `stripeChargeId`, `stripePaymentIntentId`, `stripeSubscriptionId`,
  `stripeInvoiceId` on Payment rows. QB: `qbSalesReceiptId` is the accounting mirror reference.
- **QB is write-only accounting output.** Never route payment processing through QB.
- **Pricing**: daily (1-30 days) and monthly (1-12 months) — never hourly
- **Admin auth**: proxy.ts (Next.js 16 convention), JWT in httpOnly cookie
- **Lot layout**: stored in DB (Spot.cx/cy/w/h/rot + Settings.lotGroups JSON), NOT localStorage
- **Color theme**: forest green `#2D7A4A` primary accent, dark theme `#1C1C1E` on admin/entry/exit
- **Mobile**: `useIsMobile()` hook at 640px breakpoint, admin dashboard fully responsive

---

## Pending / TODO

### Before launch (critical path)
1. **Shelly gate controller** — replace `triggerGateOpen()` stub in `src/lib/gate.ts`
   with HTTP call to WiFi relay
2. **Cron scheduling** — Vercel Hobby allows daily cron only. Need external cron
   (cron-job.org) or Railway for 5-minute intervals (overstay detection)
3. **Environment variables on Vercel** — AUTH_SECRET (random 32+ chars),
   NEXT_PUBLIC_BASE_URL (actual domain), Stripe keys, QB credentials
4. **Terms text** — have a Texas attorney review the placeholder terms in Settings
5. **Seed production lot** — run seed script with actual lot layout positions

### Post-launch
- SMS notifications (Twilio) — stubs ready in `src/lib/notifications.ts`
- Dynamic QR codes (Layer 2 gate security)
- Hardware auth (Layer 3 — Shelly on private network)
- Driver discount system (discount field on Driver model)
- Reserved monthly spots (tie specific spots to monthly drivers)
- Subscription renewal monitoring
- Railway migration (if Vercel cron limits are insufficient)
