## ParkLogic Data Model

Single source of truth for the Prisma schema and the API/view-layer types derived from it. Update this file whenever `prisma/schema.prisma` or `src/types/domain.ts` changes.

---

### Enums

| Enum | Values |
|---|---|
| `VehicleType` | `BOBTAIL`, `TRUCK_TRAILER` |
| `SessionStatus` | `ACTIVE`, `COMPLETED`, `OVERSTAY`, `CANCELLED` |
| `BillingStatus` | `CURRENT`, `PAYMENT_FAILED`, `DELINQUENT` |
| `PaymentType` | `CHECKIN`, `MONTHLY_CHECKIN`, `MONTHLY_RENEWAL`, `EXTENSION`, `OVERSTAY` |
| `PaymentStatus` | `PENDING`, `COMPLETED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `VOIDED`, `DISPUTED` |
| `AllowListLabel` | `EMPLOYEE`, `FAMILY`, `VENDOR`, `CONTRACTOR` |
| `AuditAction` | `CHECKIN`, `CHECKOUT`, `EXTEND`, `OVERSTAY_START`, `OVERSTAY_PAYMENT`, `GATE_OPEN`, `SPOT_FREED`, `REMINDER_SENT`, `OVERSTAY_ALERT`, `SUSPICIOUS_ENTRY`, `GATE_DENIED`, `ALLOWLIST_ENTRY`, `STRIPE_WEBHOOK_RECEIVED`, `STRIPE_WEBHOOK_REPLAYED`, `SALES_RECEIPT_WRITTEN`, `SALES_RECEIPT_FAILED`, `REFUND_ISSUED`, `PAYMENT_DISPUTED`, `SUBSCRIPTION_CREATED`, `SUBSCRIPTION_CANCELED`, `RECURRING_CHARGE_FAILED` |

---

### Models

#### `AllowList`
Phone-based bypass list (employees, vendors, family). No session required to open the gate.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | PK, uuid |
| `phone` | `String` | **unique** |
| `name` | `String` | |
| `label` | `String` | default `"Employee"` — freeform (Employee/Family/Vendor/Contractor) |
| `active` | `Boolean` | default `true` |
| `createdAt` | `DateTime` | default `now()` |

#### `Driver`
Real person. Phone is the identity key.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | PK, uuid |
| `name` | `String` | |
| `email` | `String?` | optional |
| `phone` | `String` | **unique** — primary lookup key |
| `qbCustomerId` | `String?` | QuickBooks customer link — cached for Sales Receipt / Refund Receipt writes |
| `stripeCustomerId` | `String?` | **unique** — Stripe customer anchor; populated on first checkout |
| `stripePaymentMethodId` | `String?` | driver's saved default card |
| `createdAt` / `updatedAt` | `DateTime` | |

Relations: `vehicles[]`, `sessions[]`, `auditLogs[]`.

#### `Vehicle`
Belongs to a Driver. A driver may have many.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | PK, uuid |
| `driverId` | `String` | FK → Driver |
| `unitNumber` | `String?` | |
| `licensePlate` | `String?` | |
| `type` | `VehicleType` | |
| `nickname` | `String?` | |
| `createdAt` / `updatedAt` | `DateTime` | |

Composite unique: `(driverId, unitNumber)`, `(driverId, licensePlate)`.
Relations: `sessions[]`, `auditLogs[]`.

#### `Spot`
Physical parking spot. Layout coords (cx/cy/w/h/rot) live here.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | PK, uuid |
| `label` | `String` | **unique** (e.g. `"A12"`) |
| `type` | `VehicleType` | |
| `cx` / `cy` / `w` / `h` / `rot` | `Float` | SVG layout, all default `0` |

Relations: `sessions[]`, `auditLogs[]`.

A spot is "free" iff no Session with status `ACTIVE` or `OVERSTAY` references it. There is no `status` column — occupancy is always derived from the Session table. See `src/lib/spots.ts::assignSpot()`.

#### `Session`
Time-based reservation. The hotel-room model — driver owns the spot until `expectedEnd` + grace.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | PK, uuid |
| `spotId` | `String` | FK → Spot |
| `driverId` | `String` | FK → Driver |
| `vehicleId` | `String` | FK → Vehicle |
| `startedAt` | `DateTime` | default `now()` |
| `expectedEnd` | `DateTime` | when spot frees (before grace) |
| `endedAt` | `DateTime?` | set on COMPLETED |
| `status` | `SessionStatus` | default `ACTIVE`; cron flips to `OVERSTAY`; `CANCELLED` set by admin |
| `billingStatus` | `BillingStatus` | default `CURRENT`; subscription dunning state |
| `reminderSent` | `Boolean` | default `false` — prevents duplicate reminder emails |
| `overstayAlertSent` | `Boolean` | default `false` — prevents duplicate manager alerts |
| `termsVersion` | `String` | default `"legacy"` — clickwrap consent snapshot |
| `overstayAuthorized` | `Boolean` | default `false` — manager flag |
| `createdAt` / `updatedAt` | `DateTime` | |

Indexes: `(status, expectedEnd)` for cron hot path; `(driverId, status)` for history.
Relations: `payments[]`, `auditLogs[]`.

#### `Payment`
Stripe charge record attached to a session. QB fields are a write-only accounting mirror.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | PK, uuid |
| `sessionId` | `String` | FK → Session |
| `type` | `PaymentType` | CHECKIN / MONTHLY_CHECKIN / MONTHLY_RENEWAL / EXTENSION / OVERSTAY |
| `amount` | `Float` | gross charge |
| `days` | `Float?` | days purchased (null for monthly subscriptions) |
| `status` | `PaymentStatus` | default `COMPLETED` |
| `stripeCheckoutSessionId` | `String?` | `cs_...` — resolves redirect after Checkout |
| `stripePaymentIntentId` | `String?` | **unique** — `pi_...` canonical one-time ID |
| `stripeChargeId` | `String?` | `ch_...` — the actual charge record |
| `stripeSubscriptionId` | `String?` | `sub_...` — only for MONTHLY_RENEWAL rows |
| `stripeInvoiceId` | `String?` | `in_...` — subscription invoice that produced this charge |
| `qbSalesReceiptId` | `String?` | QB Sales Receipt id — written after `payment_intent.succeeded` webhook |
| `qbSalesReceiptAmount` | `Float?` | amount written to QB; compared to Stripe charge in reconcile |
| `refundedAmount` | `Float` | default `0` |
| `refundedAt` | `DateTime?` | |
| `legacyQbReference` | `String?` | pre-Stripe QB invoice/charge id — never written by new code; kept for history display only |
| `createdAt` | `DateTime` | default `now()` |

Indexes: `stripeCheckoutSessionId`, `stripeChargeId`, `stripeSubscriptionId`, `createdAt`.
Relations: `refunds[]` (PaymentRefund).

#### `PaymentRefund`
One row per Stripe refund. A Payment may have multiple partial refunds.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | PK, uuid |
| `paymentId` | `String` | FK → Payment |
| `amount` | `Float` | refund amount |
| `stripeRefundId` | `String` | **unique** — `re_...` |
| `qbRefundReceiptId` | `String?` | QB Refund Receipt id (accounting mirror) |
| `qbRefundReceiptAmount` | `Float?` | amount written to QB; compared to Stripe refund in reconcile |
| `createdAt` | `DateTime` | default `now()` |

Index: `paymentId`.

#### `AuditLog`
Append-only event log. All relation FKs are optional — one row may be about a driver with no session.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | PK, uuid |
| `action` | `AuditAction` | |
| `sessionId` | `String?` | FK → Session |
| `driverId` | `String?` | FK → Driver |
| `vehicleId` | `String?` | FK → Vehicle |
| `spotId` | `String?` | FK → Spot |
| `details` | `String?` | freeform JSON/text |
| `createdAt` | `DateTime` | default `now()` |

#### `Settings`
Singleton. Exactly one row with `id = "default"`.

| Field | Type | Default |
|---|---|---|
| `dailyRateBobtail` / `dailyRateTruck` | `Float` | `30.0` / `30.0` |
| `monthlyRateBobtail` / `monthlyRateTruck` | `Float` | `250.0` / `400.0` |
| `overstayRateBobtail` / `overstayRateTruck` | `Float` | `20.0` / `25.0` |
| `gracePeriodMinutes` | `Int` | `15` |
| `reminderMinutesBefore` | `Int` | `60` |
| `totalSpotsBobtail` / `totalSpotsTruck` | `Int` | `45` / `100` |
| `managerEmail` / `managerPhone` | `String` | `""` |
| `bobtailOverflow` | `Boolean` | `true` |
| `paymentRequired` | `Boolean` | `true` |
| `lotGroups` | `Json` | `"[]"` |
| `termsVersion` / `termsBody` | `String` | `"1.0"` / `""` |
| `qbAccessToken` / `qbRefreshToken` / `qbRealmId` | `String?` | null when not connected |
| `qbTokenExpiresAt` | `DateTime?` | |
| `lastStripeWebhookAt` | `DateTime?` | stamped by webhook on every incoming event |
| `lastStripeReconcileAt` | `DateTime?` | stamped after a successful reconcile run |
| `stripeReconcileFlaggedIds` | `String[]` | charge IDs flagged by last reconcile; `[]` = no divergence |

#### `StripeEvent`
Webhook idempotency table. Every incoming Stripe event is recorded here before side effects run. Duplicate `event.id` deliveries short-circuit the handler with `STRIPE_WEBHOOK_REPLAYED`. The full payload is retained for replay/debugging.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | PK — Stripe `event.id` (`evt_...`) |
| `type` | `String` | e.g. `"payment_intent.succeeded"` |
| `processedAt` | `DateTime` | default `now()` |
| `payload` | `Json` | full Stripe event body |

Index: `(type, processedAt)`.

---

### Relationship Map

```
AllowList  (standalone — phone only)

StripeEvent  (standalone — idempotency log)

Driver ──┬── Vehicle ──┐
         │             │
         └────────────┐│
                      ▼▼
                   Session ── Payment ── PaymentRefund
                      │
                      ▼
                    Spot

AuditLog ── (optional FKs) → Session, Driver, Vehicle, Spot

Settings  (singleton)
```

---

### API / View Types (`src/types/domain.ts`)

JSON-serialized shapes returned by API routes. Dates are ISO strings (not `Date`). Pages and components use these, not Prisma types.

- **`ApiDriver`** — `{ id, name, email, phone }` (no Stripe/QB ids, no timestamps)
- **`ApiVehicle`** — `{ id, unitNumber, licensePlate, type, nickname }` (no `driverId`, no timestamps)
- **`ApiSpot`** — `{ id, label, type }` (no layout coords; occupancy derived from nested `sessions`)
- **`ApiSession`** — `{ id, status, billingStatus, startedAt, expectedEnd, endedAt, reminderSent, termsVersion, overstayAuthorized }`
- **`ApiSessionWithRelations`** — `ApiSession & { driver, vehicle, spot, payments }`
- **`ApiSpotNestedSession`** — narrower session shape returned under `/api/spots`: `ApiSession & { driver, vehicle }`. No `spot` back-ref, no `payments[]` — consumers on the lot map only read those via the parent spot.
- **`ApiSpotWithSessions`** — `ApiSpot & { sessions: ApiSpotNestedSession[] }`
- **`ApiPayment`** — `{ id, type, amount, days, stripeCheckoutSessionId, stripePaymentIntentId, stripeChargeId, stripeSubscriptionId, stripeInvoiceId, qbSalesReceiptId, legacyQbReference, status, refundedAmount, refundedAt, refunds: ApiPaymentRefund[], createdAt }`
- **`ApiPaymentRefund`** — `{ id, amount, stripeRefundId, qbRefundReceiptId, createdAt }`
- **`ApiPaymentWithSession`** — `ApiPayment & { session: { id, status, driver, vehicle, spot } | null }` — used by admin Payments tab
- **`ApiAuditEntry`** — flat `{ id, action, details, createdAt, driver?, vehicle?, spot? }`
- **`AppSettings`** — same shape as Prisma Settings **minus** QB token fields, **plus** computed fields: `qbConnected`, `qbTokenExpiringSoon`, `stripeConfigured`, `stripeTestMode`
- **`SavedDriver`** — `{ id, name, phone }` — localStorage only
- **`DriverActiveSession`** — lightweight session shape for `/api/drivers` response
- **`OverstayInfo`** — `{ requiresPayment, overstayDays, overstayAmount, overstayRate, sessionId }`
- **`SpotLayout`** — layout coords only, for lot editor
- **`LotSpotStatus`** — `"VACANT" | "RESERVED" | "OVERDUE"` (view-layer palette, **not** DB `SpotStatus`)
- **`LotSpotDetail`** / **`LotSpotSession`** — map click panel (uses real `Date` objects, not ISO strings)

---

### Invariants

1. **Phone is the driver identity key.** Unique index enforces it.
2. **Settings is a singleton** — `id = "default"` is the only row.
3. **Session lifecycle**: `ACTIVE` → `OVERSTAY` (cron) → `COMPLETED` (exit settlement or manager override). `CANCELLED` is set by admin action. `endedAt` is `null` until `COMPLETED`.
4. **Spot occupancy has no dedicated column.** A spot is free iff no Session with `status IN (ACTIVE, OVERSTAY)` references it. This is the *only* source of truth — anything else (lot map colors, available counts, assignment logic) derives from here.
5. **Stripe is the authoritative payment source of truth.** The webhook (`/api/stripe/webhook`) is the only writer of payment state — it creates/updates `Payment` and `PaymentRefund` rows and logs `SALES_RECEIPT_WRITTEN` / `SALES_RECEIPT_FAILED` as it mirrors transactions to QB. The reconcile endpoint (`/api/admin/stripe-reconcile`) is read-only: it diffs Stripe charges against our `Payment` table and writes divergences into `Settings.stripeReconcileFlaggedIds` for admin review. QB is a write-only accounting mirror; payment state is never read back from QB.
6. **AllowList bypasses sessions entirely** — no Session/Payment/Spot row is created for allow-list entries.
7. **Payment idempotency is DB-enforced** — `@@unique([stripePaymentIntentId])` guarantees that the same Stripe PaymentIntent cannot produce two Payment rows. `StripeEvent.id` (the Stripe `event.id`) provides a second idempotency layer: duplicate webhook deliveries short-circuit before any side effects run and are logged as `STRIPE_WEBHOOK_REPLAYED`.
8. **Vehicle ownership is enforced at session creation** — `/api/sessions` 404s if the supplied `vehicleId` does not belong to `driverId` (no cross-driver vehicle reuse).
9. **`refundedAmount` ≤ `amount`** is a model invariant but not DB-enforced; the refund path enforces it in code. The sum of all `PaymentRefund.amount` rows for a given Payment should equal `Payment.refundedAmount`.
