import type { APIRequestContext } from "@playwright/test";
import type { NeedsReviewCode, NeedsReviewResponse } from "../../../src/types/reconcile";

// ---------------------------------------------------------------------------
// Types mirroring app API responses (minimal — only fields tests need)
// ---------------------------------------------------------------------------

type DriverStateResponse = {
  driver: { id: string; name: string; phone: string; email: string | null } | null;
  allowList: { allowed: boolean; name?: string; label?: string };
  activeSessions: Array<{
    id: string;
    status: string;
    expectedEnd: string;
    spot?: { label: string } | null;
  }>;
  overstayPreview: { fee: number } | null;
  availability: { hasSpot: boolean } | null;
  gateEligibility: { entrance: boolean; exit: boolean; blockedReason?: string };
};

type AdminSessionBody = {
  sessionId: string;
  action:
    | "extend"
    | "cancel"
    | "close"
    | "adjust"
    | "cancel-subscription"
    | "cancel-monthly-session"
    | "adjust-monthly-access";
  days?: number;
  reason?: string;
  endedAt?: string;
  effectiveEnd?: string;
  refundAmount?: number;
  cancellationDisposition?: string;
  cancelImmediately?: boolean;
  accessEndsAt?: "period_end" | "now" | string;
  refund?: { mode: "none" | "unused_time" | "full" | "custom"; amount?: number };
  renewalAction?: "keep" | "stop";
};

type AdminRefundBody = {
  paymentId: string;
  amount?: number;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer";
};

type ApiResult<T> = {
  status: number;
  ok: boolean;
  data: T;
};

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function apiCall<T>(
  fn: () => Promise<{ status: () => number; json: () => Promise<unknown> }>,
  context: string,
): Promise<ApiResult<T>> {
  const res = await fn();
  const status = res.status();
  const data = (await res.json()) as T;
  if (status >= 500) {
    throw new Error(`[app-api] ${context} returned ${status}: ${JSON.stringify(data)}`);
  }
  return { status, ok: status >= 200 && status < 300, data };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/login — sets the admin JWT cookie on the request context.
 * Call once per test that needs admin endpoints. Subsequent calls on the same
 * request context will include the cookie automatically.
 *
 * Password defaults to the playwright test default (ADMIN_PASSWORD env var,
 * falling back to "playwright-admin" from playwright.config.ts).
 */
export async function authenticateAdmin(
  request: APIRequestContext,
  password = process.env.ADMIN_PASSWORD ?? "playwright-admin",
): Promise<void> {
  const res = await request.post("/api/auth/login", {
    data: { password },
  });
  if (!res.ok()) {
    throw new Error(
      `[app-api] authenticateAdmin failed (${res.status()}): ${await res.text()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Driver state
// ---------------------------------------------------------------------------

/**
 * GET /api/driver/state?phone=<phone>
 * Public endpoint — no auth needed.
 */
export async function getDriverState(
  request: APIRequestContext,
  phone: string,
): Promise<ApiResult<DriverStateResponse>> {
  return apiCall<DriverStateResponse>(
    () => request.get(`/api/driver/state?phone=${encodeURIComponent(phone)}`),
    `getDriverState(${phone})`,
  );
}

// ---------------------------------------------------------------------------
// Reconcile / needs-review
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/reconcile/needs-review
 * Requires admin auth — call authenticateAdmin first.
 *
 * @param params.severity - "all" | "warning" | "critical" (default "all")
 * @param params.limit    - max items (default 200)
 */
export async function getNeedsReview(
  request: APIRequestContext,
  params?: { severity?: "all" | "warning" | "critical"; limit?: number; offset?: number },
): Promise<ApiResult<NeedsReviewResponse>> {
  const qs = new URLSearchParams();
  if (params?.severity) qs.set("severity", params.severity);
  if (params?.limit != null) qs.set("limit", String(params.limit));
  if (params?.offset != null) qs.set("offset", String(params.offset));
  const q = qs.toString() ? `?${qs}` : "";
  return apiCall<NeedsReviewResponse>(
    () => request.get(`/api/admin/reconcile/needs-review${q}`),
    "getNeedsReview",
  );
}

// ---------------------------------------------------------------------------
// Admin session actions
// ---------------------------------------------------------------------------

/**
 * PUT /api/admin/sessions
 * Requires admin auth — call authenticateAdmin first.
 */
export async function putAdminSession(
  request: APIRequestContext,
  body: AdminSessionBody,
): Promise<ApiResult<unknown>> {
  return apiCall<unknown>(
    () => request.put("/api/admin/sessions", { data: body }),
    `putAdminSession(${body.action}, ${body.sessionId})`,
  );
}

// ---------------------------------------------------------------------------
// Admin refund
// ---------------------------------------------------------------------------

/**
 * POST /api/admin/refund
 * Requires admin auth — call authenticateAdmin first.
 *
 * NOTE: Only fires a Stripe refund. The charge.refunded webhook (or the
 * synchronous fallback in the route) writes the Payment row update.
 * In tests without Stripe, this will return 409 (Stripe not configured).
 */
export async function postAdminRefund(
  request: APIRequestContext,
  body: AdminRefundBody,
): Promise<ApiResult<{ refundId: string; status: string; amount: number }>> {
  return apiCall<{ refundId: string; status: string; amount: number }>(
    () => request.post("/api/admin/refund", { data: body }),
    `postAdminRefund(${body.paymentId})`,
  );
}

// ---------------------------------------------------------------------------
// Driver gate (no auth required — driver-facing endpoint)
// ---------------------------------------------------------------------------

type OpenGateBody = {
  driverId: string;
  deviceId?: string;
  direction: "ENTRANCE" | "EXIT";
  scanContext: "fresh" | "internal";
};

type OpenGateDenial = {
  code: string;
  message: string;
  severity?: string;
  recoverable?: boolean;
};

type OpenGateResult =
  | { ok: true; result: unknown }
  | { ok: false; denial: OpenGateDenial };

// ---------------------------------------------------------------------------
// Admin settings
// ---------------------------------------------------------------------------

type SettingsUpdate = {
  dailyRateBobtail?: number;
  dailyRateTruck?: number;
  monthlyRateBobtail?: number;
  monthlyRateTruck?: number;
  gracePeriodMinutes?: number;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Allow-list gate
// ---------------------------------------------------------------------------

type AllowListOpenGateBody = {
  phone: string;
  deviceId?: string;
  direction?: "ENTRANCE" | "EXIT";
  scanContext: "fresh" | "internal";
};

type AllowListOpenGateResult =
  | { ok: true; result: { openedAt: string } }
  | { ok: false; denial: { code: string; message: string } };

/**
 * POST /api/allowlist/open-gate
 * No admin auth required — mirrors the driver-facing flow.
 */
export async function postAllowListOpenGate(
  request: APIRequestContext,
  body: AllowListOpenGateBody,
): Promise<ApiResult<AllowListOpenGateResult>> {
  return apiCall<AllowListOpenGateResult>(
    () => request.post("/api/allowlist/open-gate", { data: body }),
    `postAllowListOpenGate(${body.phone}, ${body.scanContext})`,
  );
}

/**
 * PUT /api/settings
 * Requires admin auth — call authenticateAdmin first.
 *
 * Only sends the fields you provide; other settings are left unchanged.
 */
export async function putAdminSettings(
  request: APIRequestContext,
  update: SettingsUpdate,
): Promise<ApiResult<unknown>> {
  return apiCall<unknown>(
    () => request.put("/api/settings", { data: update }),
    "putAdminSettings",
  );
}

/**
 * POST /api/sessions/:id/open-gate
 * Driver-facing endpoint — no admin auth required.
 */
export async function postDriverOpenGate(
  request: APIRequestContext,
  sessionId: string,
  body: OpenGateBody,
): Promise<ApiResult<OpenGateResult>> {
  return apiCall<OpenGateResult>(
    () => request.post(`/api/sessions/${sessionId}/open-gate`, { data: body }),
    `postDriverOpenGate(${sessionId}, ${body.direction}, ${body.scanContext})`,
  );
}

// Re-export the code type so assertion helpers don't need a separate import
export type { NeedsReviewCode };
