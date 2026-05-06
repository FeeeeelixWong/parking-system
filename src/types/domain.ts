/**
 * Shared domain types for API responses and localStorage.
 *
 * These represent JSON-serialized shapes returned by Next.js API routes
 * (dates are ISO strings, not Date objects). Prisma model types live in
 * src/generated/prisma — these are for the client/page layer.
 */

import type {
  VehicleType,
  SessionStatus,
  BillingStatus,
  PaymentType,
  PaymentStatus,
  AllowListLabel,
  AuditAction,
} from "@/generated/prisma/enums";

// Re-export so pages can import enums from a single module
export type { VehicleType, SessionStatus, BillingStatus, PaymentType, PaymentStatus, AllowListLabel, AuditAction };

// ---------------------------------------------------------------------------
// Core entities (JSON-serialized API response shapes)
// ---------------------------------------------------------------------------

export type ApiDriver = {
  id: string;
  name: string;
  email: string | null;
  phone: string;
};

export type ApiVehicle = {
  id: string;
  unitNumber: string | null;
  licensePlate: string | null;
  type: VehicleType;
  nickname: string | null;
};

export type ApiPaymentRefund = {
  id: string;
  amount: number;
  stripeRefundId: string;
  qbRefundReceiptId: string | null;
  createdAt: string;
};

export type ApiPayment = {
  id: string;
  type: PaymentType;
  amount: number;
  days: number | null;
  // Stripe identifiers — populated per event; most are null on any given row
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  stripeSubscriptionId: string | null;
  stripeInvoiceId: string | null;
  // QuickBooks accounting mirror — populated after webhook writes the receipt
  qbSalesReceiptId: string | null;
  // Pre-Stripe reference, or "free_*" synthetic marker for payments-disabled rows
  legacyQbReference: string | null;
  status: PaymentStatus;
  refundedAmount: number;
  refundedAt: string | null;
  refunds: ApiPaymentRefund[];
  createdAt: string;
};

/** Payment with full session/driver/vehicle/spot context (admin Payments tab). */
export type ApiPaymentWithSession = ApiPayment & {
  session: {
    id: string;
    status: "ACTIVE" | "OVERSTAY" | "COMPLETED" | "CANCELLED";
    driver: {
      name: string;
      phone: string;
      qbCustomerId: string | null;
      stripeCustomerId: string | null;
    } | null;
    vehicle: { licensePlate: string | null; type: VehicleType } | null;
    spot: { label: string } | null;
  } | null;
};

export type ApiSpot = {
  id: string;
  label: string;
  type: VehicleType;
};

export type ApiSession = {
  id: string;
  status: SessionStatus;
  billingStatus: BillingStatus;
  startedAt: string;
  expectedEnd: string;
  endedAt: string | null;
  reminderSent: boolean;
  termsVersion: string;
  overstayAuthorized: boolean;
};

/** Session with all included relations (from most GET endpoints) */
export type ApiSessionWithRelations = ApiSession & {
  driver: ApiDriver;
  vehicle: ApiVehicle;
  spot: ApiSpot;
  payments: ApiPayment[];
};

/**
 * Narrower session shape returned under GET /api/spots — only the fields
 * the lot map consumers read (no redundant `spot` back-reference, no
 * `payments[]`). If you add a consumer that needs more, widen either the
 * API include or this type — do not use `ApiSessionWithRelations` here.
 */
export type ApiSpotNestedSession = ApiSession & {
  driver: ApiDriver;
  vehicle: ApiVehicle;
};

/** Spot with nested active sessions (from GET /api/spots) */
export type ApiSpotWithSessions = ApiSpot & {
  sessions: ApiSpotNestedSession[];
};

/** Lightweight session with spot + vehicle (from GET /api/drivers activeSessions). */
export type DriverActiveSession = {
  id: string;
  status: Extract<SessionStatus, "ACTIVE" | "OVERSTAY">;
  expectedEnd: string;
  startedAt: string;
  spot: { label: string; type: VehicleType };
  vehicle: {
    licensePlate: string | null;
    unitNumber: string | null;
    type: VehicleType;
    nickname: string | null;
  };
};

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type ApiAuditEntry = {
  id: string;
  action: AuditAction;
  details: string | null;
  createdAt: string;
  driver: { name: string; phone: string } | null;
  vehicle: { licensePlate: string | null; type: VehicleType } | null;
  spot: { label: string } | null;
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type AppSettings = {
  dailyRateBobtail: number;
  dailyRateTruck: number;
  monthlyRateBobtail: number;
  monthlyRateTruck: number;
  overstayRateBobtail: number;
  overstayRateTruck: number;
  gracePeriodMinutes: number;
  reminderMinutesBefore: number;
  totalSpotsBobtail: number;
  totalSpotsTruck: number;
  managerEmail: string;
  managerPhone: string;
  bobtailOverflow: boolean;
  paymentRequired: boolean;
  termsVersion: string;
  termsBody: string;
  // QuickBooks connection state (computed by /api/settings — QB token fields stripped)
  qbRealmId: string;
  qbConnected: boolean;
  /** ISO string or null. Present so UI can display an expiry warning. */
  qbTokenExpiresAt: string | null;
  /** True when the QB access token expires within 14 days. */
  qbTokenExpiringSoon: boolean;
  // ─── Stripe operational status ────────────────────────────────────────
  /** Derived on the server from STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET. */
  stripeConfigured: boolean;
  /** True when STRIPE_SECRET_KEY starts with "sk_test_" — drives test vs. live dashboard URLs. */
  stripeTestMode: boolean;
  /** ISO string or null — set by the webhook on every incoming event. */
  lastStripeWebhookAt: string | null;
  /** ISO string or null — set by the admin reconcile endpoint. */
  lastStripeReconcileAt: string | null;
  /** Stripe charge IDs that failed the last reconcile diff. */
  stripeReconcileFlaggedIds: string[];
};

// ---------------------------------------------------------------------------
// Overstay (used by exit page and overstay-checkout command endpoint)
// ---------------------------------------------------------------------------

export type OverstayInfo = {
  requiresPayment: true;
  overstayDays: number;
  overstayAmount: number;
  overstayRate: number;
  sessionId: string;
};

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

export type SavedDriver = {
  id: string;
  name: string;
  phone: string;
};

// ---------------------------------------------------------------------------
// Lot layout (SVG spot positioning — used by LotMap components)
// ---------------------------------------------------------------------------

export type SpotLayout = {
  id: string;
  label: string;
  type: VehicleType;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
};

// ---------------------------------------------------------------------------
// Lot map display types (view layer — NOT the Prisma SpotStatus enum)
// ---------------------------------------------------------------------------

/** Visual status for a spot on the lot map SVG. */
export type LotSpotStatus = "VACANT" | "RESERVED" | "OVERDUE";

/** Session info attached to a lot spot, with Date objects (not ISO strings). */
export type LotSpotSession = {
  id: string;
  driver: { name: string; email: string | null; phone: string };
  vehicle: {
    unitNumber: string | null;
    licensePlate: string | null;
    type: VehicleType;
    nickname: string | null;
  };
  startedAt: Date;
  expectedEnd: Date;
  endedAt: Date | null;
  sessionStatus: SessionStatus;
  reminderSent: boolean;
  payments: { id: string; type: PaymentType; amount: number; days: number | null; createdAt: Date }[];
};

/** Full spot detail for the SpotDetailPanel (map click → slide-out). */
export type LotSpotDetail = {
  spotId: string;
  spotLabel: string;
  status: LotSpotStatus;
  session: LotSpotSession | null;
};

/** Lot map spot color palette per status. */
export type LotSpotColors = {
  fill: string;
  fillHover: string;
  stroke: string;
  label: string;
};

export const LOT_STATUS_COLORS: Record<LotSpotStatus, LotSpotColors> = {
  VACANT:   { fill: "#12261C", fillHover: "#1A3324", stroke: "#2D7A4A", label: "rgba(255,255,255,0.5)" },
  RESERVED: { fill: "#1A1A2E", fillHover: "#24244A", stroke: "#6366F1", label: "rgba(99,102,241,0.7)" },
  OVERDUE:  { fill: "#2C1810", fillHover: "#3D2218", stroke: "#DC2626", label: "rgba(220,38,38,0.7)" },
};

// ---------------------------------------------------------------------------
// Action/denial types (re-exported from actions.ts for single-import convenience)
// ---------------------------------------------------------------------------
export type {
  ActionCode,
  ActionState,
  TypedDenial,
  DenialCodeType,
  AdminMutationResult,
} from "./actions";
export { DenialCode } from "./actions";

// ---------------------------------------------------------------------------
// Reconcile / Needs Review types (re-exported for single-import convenience)
// ---------------------------------------------------------------------------
export type { NeedsReviewSeverity, NeedsReviewCode, NeedsReviewItem, NeedsReviewResponse } from "./reconcile";
