import { expect } from "@playwright/test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../db";

// Lazy pool — same pattern as db.ts but scoped to this module.
let pool: Pool | null = null;
function db() {
  pool ??= new Pool({ connectionString: requireTestDatabaseUrl() });
  return pool;
}

type SessionStatus = "ACTIVE" | "COMPLETED" | "OVERSTAY" | "CANCELLED";

type CancellationDisposition =
  | "N_A"
  | "REFUND_FULL"
  | "REFUND_PARTIAL_UNUSED"
  | "REFUND_PARTIAL_CUSTOM"
  | "RETAINED_INTENTIONAL";

type PaymentType =
  | "CHECKIN"
  | "MONTHLY_CHECKIN"
  | "MONTHLY_RENEWAL"
  | "EXTENSION"
  | "OVERSTAY";

type AuditAction =
  | "GATE_OPEN"
  | "GATE_DENIED"
  | "SUSPICIOUS_ENTRY"
  | "CHECKIN"
  | "CHECKOUT"
  | "REFUND_ISSUED"
  | "EXTENSION"
  | "OVERSTAY_DETECTED"
  | "SESSION_EXPIRED"
  | "ADMIN_ACTION"
  | "ALLOWLIST_ENTRY"
  | "NOTIFICATION_SENT"
  | "SPOT_FREED";

// ---------------------------------------------------------------------------
// Audit log assertions
// ---------------------------------------------------------------------------

/**
 * Assert that exactly `expected` audit log entries exist for `action`.
 * Uses `expect.poll` with a short timeout so the assertion retries briefly
 * in case a webhook or background write is in flight.
 */
export async function expectAuditCount(
  action: AuditAction,
  expected: number,
  sessionId?: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await db().query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM "AuditLog"
           WHERE action = $1 AND ($2::text IS NULL OR "sessionId" = $2)`,
          [action, sessionId ?? null],
        );
        return Number(result.rows[0].count);
      },
      { timeout: 5000 },
    )
    .toBe(expected);
}

// ---------------------------------------------------------------------------
// Session assertions
// ---------------------------------------------------------------------------

/**
 * Assert that a session's status field equals `expected`.
 */
export async function expectSessionStatus(
  sessionId: string,
  expected: SessionStatus,
): Promise<void> {
  const result = await db().query<{ status: string }>(
    `SELECT status FROM "Session" WHERE id = $1`,
    [sessionId],
  );
  expect(result.rows[0]?.status, `Session ${sessionId} status`).toBe(expected);
}

/**
 * Assert that a session's cancellationDisposition equals `expected`.
 */
export async function expectCancellationDisposition(
  sessionId: string,
  expected: CancellationDisposition,
): Promise<void> {
  const result = await db().query<{ cancellationDisposition: string }>(
    `SELECT "cancellationDisposition" FROM "Session" WHERE id = $1`,
    [sessionId],
  );
  expect(
    result.rows[0]?.cancellationDisposition,
    `Session ${sessionId} cancellationDisposition`,
  ).toBe(expected);
}

// ---------------------------------------------------------------------------
// Payment assertions
// ---------------------------------------------------------------------------

/**
 * Assert that a specific Payment row has `amount` equal to `expected`.
 * Use for ADMIN-004 and similar checks that a settings change didn't mutate
 * the stored amount on an existing payment.
 */
export async function expectPaymentAmount(
  paymentId: string,
  expected: number,
): Promise<void> {
  const result = await db().query<{ amount: number }>(
    `SELECT amount FROM "Payment" WHERE id = $1`,
    [paymentId],
  );
  expect(result.rows[0]?.amount, `Payment ${paymentId} amount`).toBe(expected);
}

/**
 * Assert that exactly `expected` Payment rows exist for `sessionId` with
 * the given `type`. Pass `undefined` for type to count all payments.
 */
export async function expectPaymentCount(
  sessionId: string,
  type: PaymentType | undefined,
  expected: number,
): Promise<void> {
  const result = await db().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "Payment"
     WHERE "sessionId" = $1 AND ($2::text IS NULL OR type::text = $2::text)`,
    [sessionId, type ?? null],
  );
  const actual = Number(result.rows[0].count);
  expect(actual, `Payment count for session ${sessionId} type=${type ?? "any"}`).toBe(expected);
}
