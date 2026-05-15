/**
 * DEMO-FILTER — demoId scoping for admin API endpoints
 *
 * Verifies that ?demoId=X on admin endpoints returns only records for
 * demo driver X, not records for other demo drivers. Also verifies that
 * omitting demoId returns unfiltered results (both drivers visible).
 *
 * Seeds two demo drivers directly via SQL rather than through the demo
 * scenario factory, because these tests need the demoId format without
 * requiring Stripe/QB sandbox credentials.
 *
 * Affected endpoints:
 *   GET /api/admin/reconcile/needs-review?demoId=
 *   GET /api/sessions/history?demoId=
 *   GET /api/admin/payments?demoId=
 *   GET /api/admin/payments/pending?demoId=
 */

import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { resetDb, disconnectDb } from "../../support/db";
import { authenticateAdmin } from "../../support/app-api";
import { getE2EEnv } from "../../support/env";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run demoId filter tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

// Fixed fake demo IDs — valid regex: /^demo_[a-z0-9-]+_\d{8}_\d{6}_[a-z0-9]{4}$/i
const DEMO_A = "demo_filter-a_20260101_120000_aa01";
const DEMO_B = "demo_filter-b_20260101_120000_bb02";

type DemoSeed = {
  driverId: string;
  sessionId: string;
  paymentId: string;
};

async function seedDemoDriver(
  pool: Pool,
  demoId: string,
  opts: {
    billingStatus?: "CURRENT" | "PAYMENT_FAILED" | "DELINQUENT";
    hasQbReceipt?: boolean;
  } = {},
): Promise<DemoSeed> {
  const { billingStatus = "CURRENT", hasQbReceipt = false } = opts;

  const driverId = randomUUID();
  const vehicleId = randomUUID();
  const sessionId = randomUUID();
  const paymentId = randomUUID();
  // Phone must be 10 digits and unique; derive from a UUID slice.
  const phone = `555${randomUUID().replace(/-/g, "").slice(0, 7)}`;
  // Email embeds demoId so the ?demoId=... filter (email CONTAINS demoId) matches.
  const email = `driver+${demoId}@demo.test`;
  const stripeChargeId = `ch_test_${randomUUID().slice(0, 8)}`;
  const qbSalesReceiptId = hasQbReceipt ? `qb_test_${randomUUID().slice(0, 8)}` : null;

  const spotRes = await pool.query<{ id: string }>(
    `SELECT id FROM "Spot" WHERE type = 'TRUCK_TRAILER' LIMIT 1`,
  );
  const spotId = spotRes.rows[0]?.id;
  if (!spotId) throw new Error("No TRUCK_TRAILER spot found — did resetDb() run?");

  await pool.query(
    `INSERT INTO "Driver" (id, name, phone, email, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
    [driverId, `Demo Driver ${demoId}`, phone, email],
  );

  await pool.query(
    `INSERT INTO "Vehicle" (id, "driverId", type, "licensePlate", "createdAt", "updatedAt")
     VALUES ($1, $2, 'TRUCK_TRAILER', $3, NOW(), NOW())`,
    [vehicleId, driverId, `PLT${phone.slice(-4)}`],
  );

  const futureEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO "Session" (id, "driverId", "vehicleId", "spotId", "startedAt", "expectedEnd", status, "billingStatus", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), $5, 'ACTIVE', $6, NOW(), NOW())`,
    [sessionId, driverId, vehicleId, spotId, futureEnd, billingStatus],
  );

  await pool.query(
    `INSERT INTO "Payment" (id, "sessionId", type, amount, days, status, "stripeChargeId", "qbSalesReceiptId", "createdAt")
     VALUES ($1, $2, 'CHECKIN', 30.00, 1, 'COMPLETED', $3, $4, NOW())`,
    [paymentId, sessionId, stripeChargeId, qbSalesReceiptId],
  );

  return { driverId, sessionId, paymentId };
}

// ---------------------------------------------------------------------------
// Needs Review
// ---------------------------------------------------------------------------

test(
  "DEMO-FILTER-001: needs-review?demoId returns only that demo's sessions",
  async ({ request }, testInfo) => {
    void testInfo;
    await resetDb();

    const pool = new Pool({ connectionString: getE2EEnv().testDatabaseUrl });
    try {
      // DEMO_A: CURRENT + no QB receipt → QB_RECEIPT_MISSING
      const a = await seedDemoDriver(pool, DEMO_A);
      // DEMO_B: PAYMENT_FAILED + no QB receipt → SUBSCRIPTION_PAYMENT_FAILED + QB_RECEIPT_MISSING
      const b = await seedDemoDriver(pool, DEMO_B, { billingStatus: "PAYMENT_FAILED" });

      await authenticateAdmin(request);

      // Filter by DEMO_A: all returned items must reference A's session
      const resA = await request.get(
        `/api/admin/reconcile/needs-review?demoId=${encodeURIComponent(DEMO_A)}&limit=200`,
      );
      expect(resA.status()).toBe(200);
      const dataA = await resA.json() as { items: { related: { sessionId?: string } }[]; total: number };
      expect(dataA.items.length).toBeGreaterThan(0);
      for (const item of dataA.items) {
        expect(item.related.sessionId).toBe(a.sessionId);
      }

      // Filter by DEMO_B: all returned items must reference B's session
      const resB = await request.get(
        `/api/admin/reconcile/needs-review?demoId=${encodeURIComponent(DEMO_B)}&limit=200`,
      );
      expect(resB.status()).toBe(200);
      const dataB = await resB.json() as { items: { related: { sessionId?: string } }[]; total: number };
      expect(dataB.items.length).toBeGreaterThan(0);
      for (const item of dataB.items) {
        expect(item.related.sessionId).toBe(b.sessionId);
      }

      // No demoId: both sessions appear
      const resAll = await request.get("/api/admin/reconcile/needs-review?limit=200");
      expect(resAll.status()).toBe(200);
      const dataAll = await resAll.json() as { items: { related: { sessionId?: string } }[] };
      const sessionIds = new Set(dataAll.items.map((i) => i.related.sessionId));
      expect(sessionIds.has(a.sessionId)).toBe(true);
      expect(sessionIds.has(b.sessionId)).toBe(true);
    } finally {
      await pool.end();
    }
  },
);

// ---------------------------------------------------------------------------
// Sessions history
// ---------------------------------------------------------------------------

test(
  "DEMO-FILTER-002: sessions/history?demoId returns only that demo's sessions",
  async ({ request }, testInfo) => {
    void testInfo;
    await resetDb();

    const pool = new Pool({ connectionString: getE2EEnv().testDatabaseUrl });
    try {
      const a = await seedDemoDriver(pool, DEMO_A);
      const b = await seedDemoDriver(pool, DEMO_B);

      await authenticateAdmin(request);

      // Filter by DEMO_A
      const resA = await request.get(
        `/api/sessions/history?demoId=${encodeURIComponent(DEMO_A)}&limit=50`,
      );
      expect(resA.status()).toBe(200);
      const dataA = await resA.json() as { sessions: { id: string }[]; total: number };
      expect(dataA.total).toBe(1);
      expect(dataA.sessions[0].id).toBe(a.sessionId);

      // Filter by DEMO_B
      const resB = await request.get(
        `/api/sessions/history?demoId=${encodeURIComponent(DEMO_B)}&limit=50`,
      );
      expect(resB.status()).toBe(200);
      const dataB = await resB.json() as { sessions: { id: string }[]; total: number };
      expect(dataB.total).toBe(1);
      expect(dataB.sessions[0].id).toBe(b.sessionId);

      // No demoId: both sessions appear
      const resAll = await request.get("/api/sessions/history?limit=50");
      expect(resAll.status()).toBe(200);
      const dataAll = await resAll.json() as { sessions: { id: string }[]; total: number };
      expect(dataAll.total).toBeGreaterThanOrEqual(2);
      const ids = dataAll.sessions.map((s) => s.id);
      expect(ids).toContain(a.sessionId);
      expect(ids).toContain(b.sessionId);
    } finally {
      await pool.end();
    }
  },
);

// ---------------------------------------------------------------------------
// Admin payments
// ---------------------------------------------------------------------------

test(
  "DEMO-FILTER-003: admin/payments?demoId returns only that demo's payments",
  async ({ request }, testInfo) => {
    void testInfo;
    await resetDb();

    const pool = new Pool({ connectionString: getE2EEnv().testDatabaseUrl });
    try {
      const a = await seedDemoDriver(pool, DEMO_A);
      const b = await seedDemoDriver(pool, DEMO_B);

      await authenticateAdmin(request);

      // Filter by DEMO_A
      const resA = await request.get(
        `/api/admin/payments?demoId=${encodeURIComponent(DEMO_A)}&limit=50`,
      );
      expect(resA.status()).toBe(200);
      const dataA = await resA.json() as { payments: { id: string }[]; total: number };
      expect(dataA.total).toBe(1);
      expect(dataA.payments[0].id).toBe(a.paymentId);

      // Filter by DEMO_B
      const resB = await request.get(
        `/api/admin/payments?demoId=${encodeURIComponent(DEMO_B)}&limit=50`,
      );
      expect(resB.status()).toBe(200);
      const dataB = await resB.json() as { payments: { id: string }[]; total: number };
      expect(dataB.total).toBe(1);
      expect(dataB.payments[0].id).toBe(b.paymentId);

      // No demoId: both payments appear
      const resAll = await request.get("/api/admin/payments?limit=50");
      expect(resAll.status()).toBe(200);
      const dataAll = await resAll.json() as { payments: { id: string }[]; total: number };
      expect(dataAll.total).toBeGreaterThanOrEqual(2);
      const ids = dataAll.payments.map((p) => p.id);
      expect(ids).toContain(a.paymentId);
      expect(ids).toContain(b.paymentId);
    } finally {
      await pool.end();
    }
  },
);

// ---------------------------------------------------------------------------
// Admin payments/pending
// ---------------------------------------------------------------------------

test(
  "DEMO-FILTER-004: admin/payments/pending?demoId returns only that demo's failed sessions",
  async ({ request }, testInfo) => {
    void testInfo;
    await resetDb();

    const pool = new Pool({ connectionString: getE2EEnv().testDatabaseUrl });
    try {
      // DEMO_A: CURRENT → not in pending
      await seedDemoDriver(pool, DEMO_A, { billingStatus: "CURRENT" });
      // DEMO_B: PAYMENT_FAILED → appears in pending
      const b = await seedDemoDriver(pool, DEMO_B, { billingStatus: "PAYMENT_FAILED" });

      await authenticateAdmin(request);

      // Filter by DEMO_A: no pending sessions (CURRENT billing status)
      const resA = await request.get(
        `/api/admin/payments/pending?demoId=${encodeURIComponent(DEMO_A)}`,
      );
      expect(resA.status()).toBe(200);
      const dataA = await resA.json() as { items: unknown[] };
      expect(dataA.items.length).toBe(0);

      // Filter by DEMO_B: one pending session
      const resB = await request.get(
        `/api/admin/payments/pending?demoId=${encodeURIComponent(DEMO_B)}`,
      );
      expect(resB.status()).toBe(200);
      const dataB = await resB.json() as { items: { sessionId: string }[] };
      expect(dataB.items.length).toBe(1);
      expect(dataB.items[0].sessionId).toBe(b.sessionId);

      // No demoId: B's session appears
      const resAll = await request.get("/api/admin/payments/pending");
      expect(resAll.status()).toBe(200);
      const dataAll = await resAll.json() as { items: { sessionId: string }[] };
      const ids = dataAll.items.map((s) => s.sessionId);
      expect(ids).toContain(b.sessionId);
    } finally {
      await pool.end();
    }
  },
);

// ---------------------------------------------------------------------------
// Invalid demoId is silently dropped (no 400, returns unfiltered)
// ---------------------------------------------------------------------------

test(
  "DEMO-FILTER-005: invalid demoId is silently dropped — returns unfiltered results",
  async ({ request }, testInfo) => {
    void testInfo;
    await resetDb();

    const pool = new Pool({ connectionString: getE2EEnv().testDatabaseUrl });
    try {
      const a = await seedDemoDriver(pool, DEMO_A);

      await authenticateAdmin(request);

      // A malformed demoId should not return 400 and should not filter
      const res = await request.get(
        "/api/admin/reconcile/needs-review?demoId=../../etc/passwd&limit=200",
      );
      expect(res.status()).toBe(200);
      const data = await res.json() as { items: { related: { sessionId?: string } }[] };
      // A's session should appear (not filtered out by invalid demoId)
      const sessionIds = new Set(data.items.map((i) => i.related.sessionId));
      expect(sessionIds.has(a.sessionId)).toBe(true);
    } finally {
      await pool.end();
    }
  },
);
