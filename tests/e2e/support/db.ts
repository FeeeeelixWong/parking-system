import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { getE2EEnv } from "./env";
import type { TestRun } from "./test-run";

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
  | "SPOT_FREED"
  | "RECURRING_CHARGE_FAILED"
  | "SUBSCRIPTION_CANCELED"
  | "SUBSCRIPTION_CREATED";

let pool: Pool | null = null;

export function requireTestDatabaseUrl(): string {
  const testDatabaseUrl = getE2EEnv().testDatabaseUrl;
  const lower = testDatabaseUrl.toLowerCase();
  const hasTestMarker =
    lower.includes("test") ||
    lower.includes("localhost") ||
    lower.includes("127.0.0.1");

  // Also accept a URL that is provably distinct from the production DATABASE_URL
  // (different hostname = different Neon branch / server).
  const productionUrl = process.env.DATABASE_URL ?? "";
  let isDifferentHost = false;
  if (!hasTestMarker && productionUrl) {
    try {
      isDifferentHost = new URL(testDatabaseUrl).host !== new URL(productionUrl).host;
    } catch { /* unparseable URL falls through to the error below */ }
  }

  if (!hasTestMarker && !isDifferentHost) {
    throw new Error(
      "TEST_DATABASE_URL must contain 'test' / 'localhost', or be a different host from DATABASE_URL.",
    );
  }
  return testDatabaseUrl;
}

function db() {
  pool ??= new Pool({ connectionString: requireTestDatabaseUrl() });
  return pool;
}

export async function resetDb() {
  const client = db();

  // Delete in dependency order. Guard against tables that don't yet exist in
  // the test DB (e.g. schema not fully migrated) so a missing table never
  // prevents the rest of the reset from running.
  const tablesToClear = [
    "StripeEvent",
    "AuditLog",
    "PaymentRefund",
    "Payment",
    "Session",
    "Spot",
    "Vehicle",
    "Driver",
    "AllowList",
    "Settings",
  ];

  const { rows } = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [tablesToClear],
  );
  const existing = new Set(rows.map((r) => r.tablename));

  for (const table of tablesToClear) {
    if (existing.has(table)) {
      await client.query(`DELETE FROM "${table}"`);
    }
  }

  await client.query(`
    INSERT INTO "Settings" (
      id,
      "paymentRequired",
      "dailyRateBobtail",
      "dailyRateTruck",
      "monthlyRateBobtail",
      "monthlyRateTruck",
      "overstayRateBobtail",
      "overstayRateTruck",
      "bobtailOverflow"
    )
    VALUES ('default', false, 30, 30, 250, 400, 20, 25, true)
  `);

  await client.query(
    `
    INSERT INTO "Spot" (id, label, type, cx, cy, w, h, rot)
    VALUES
      ($1, 'T1', 'TRUCK_TRAILER', 0, 0, 10, 10, 0),
      ($2, 'T2', 'TRUCK_TRAILER', 0, 0, 10, 10, 0),
      ($3, 'B1', 'BOBTAIL', 0, 0, 10, 10, 0)
  `,
    [randomUUID(), randomUUID(), randomUUID()],
  );
}

export async function disconnectDb() {
  await pool?.end();
  pool = null;
}

export async function seedActiveDriverSession(args?: {
  phone?: string;
  name?: string;
  deviceLabel?: string;
  testRun?: TestRun;
}) {
  const client = db();
  const testRun = args?.testRun;
  const phone = args?.phone ?? testRun?.driverPhone(0) ?? "5551000001";
  const name = args?.name ?? testRun?.driverName() ?? "Test Driver";
  // Embed testRunId in email so cleanup queries can find rows with WHERE email LIKE '%e2e_<id>%'
  const email = testRun ? testRun.driverEmail() : `${phone}@example.test`;
  const driverId = randomUUID();
  const vehicleId = randomUUID();
  const sessionId = randomUUID();
  const paymentId = randomUUID();

  const driver = await client.query<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
  }>(
    `
    INSERT INTO "Driver" (id, name, phone, email, "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, NOW(), NOW())
    RETURNING id, name, phone, email
  `,
    [driverId, name, phone, email],
  );

  const vehicle = await client.query<{
    id: string;
    driverId: string;
    type: "TRUCK_TRAILER";
    licensePlate: string | null;
    unitNumber: string | null;
  }>(
    `
    INSERT INTO "Vehicle" (id, "driverId", type, "licensePlate", "unitNumber", "createdAt", "updatedAt")
    VALUES ($1, $2, 'TRUCK_TRAILER', $3, $4, NOW(), NOW())
    RETURNING id, "driverId", type, "licensePlate", "unitNumber"
  `,
    [vehicleId, driverId, `PLT${phone.slice(-4)}`, args?.deviceLabel ?? null],
  );

  const spot = await client.query<{ id: string; label: string; type: "TRUCK_TRAILER" }>(
    `SELECT id, label, type FROM "Spot" WHERE type = 'TRUCK_TRAILER' ORDER BY label ASC LIMIT 1`,
  );

  const session = await client.query<{
    id: string;
    driverId: string;
    vehicleId: string;
    spotId: string;
    status: "ACTIVE";
  }>(
    `
    INSERT INTO "Session" (
      id,
      "driverId",
      "vehicleId",
      "spotId",
      "expectedEnd",
      "termsVersion",
      "overstayAuthorized",
      "updatedAt"
    )
    VALUES ($1, $2, $3, $4, $5, '1.0', true, NOW())
    RETURNING id, "driverId", "vehicleId", "spotId", status
  `,
    [sessionId, driverId, vehicleId, spot.rows[0].id, new Date(Date.now() + 24 * 60 * 60 * 1000)],
  );

  // Embed testRunId in legacyQbReference so cleanup queries can find rows with WHERE "legacyQbReference" LIKE '%e2e_<id>%'
  const legacyQbReference = testRun
    ? testRun.reference("free_test")
    : `free_test_${phone}`;

  await client.query(
    `
    INSERT INTO "Payment" (id, "sessionId", type, amount, days, "legacyQbReference")
    VALUES ($1, $2, 'CHECKIN', 0, 1, $3)
  `,
    [paymentId, sessionId, legacyQbReference],
  );

  return {
    driver: driver.rows[0],
    vehicle: vehicle.rows[0],
    spot: spot.rows[0],
    session: session.rows[0],
  };
}

export async function seedCancelledPaidSession(args: {
  testRun?: TestRun;
  phone?: string;
  name?: string;
  amount?: number;
  stripeChargeId?: string;
  cancellationDisposition?: "N_A" | "REFUND_FULL" | "REFUND_PARTIAL_UNUSED" | "REFUND_PARTIAL_CUSTOM" | "RETAINED_INTENTIONAL";
}) {
  const client = db();
  const testRun = args.testRun;
  const phone = args.phone ?? testRun?.driverPhone(0) ?? "5551000002";
  const name = args.name ?? testRun?.driverName() ?? "Test Driver";
  const email = testRun ? testRun.driverEmail() : `${phone}@example.test`;
  const amount = args.amount ?? 30.00;
  const disposition = args.cancellationDisposition ?? "N_A";
  const driverId = randomUUID();
  const vehicleId = randomUUID();
  const sessionId = randomUUID();
  const paymentId = randomUUID();
  const stripeChargeId = args.stripeChargeId ?? `ch_test_seed_${paymentId.slice(0, 8)}`;

  const driver = await client.query<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
  }>(
    `INSERT INTO "Driver" (id, name, phone, email, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, name, phone, email`,
    [driverId, name, phone, email],
  );

  const vehicle = await client.query<{
    id: string;
    driverId: string;
    type: "TRUCK_TRAILER";
  }>(
    `INSERT INTO "Vehicle" (id, "driverId", type, "licensePlate", "unitNumber", "createdAt", "updatedAt")
     VALUES ($1, $2, 'TRUCK_TRAILER', $3, NULL, NOW(), NOW())
     RETURNING id, "driverId", type`,
    [vehicleId, driverId, `PLT${phone.slice(-4)}`],
  );

  const spot = await client.query<{ id: string; label: string }>(
    `SELECT id, label FROM "Spot" WHERE type = 'TRUCK_TRAILER' ORDER BY label ASC LIMIT 1`,
  );

  const session = await client.query<{
    id: string;
    driverId: string;
    vehicleId: string;
    status: "CANCELLED";
    cancellationDisposition: string;
  }>(
    `INSERT INTO "Session" (
       id, "driverId", "vehicleId", "spotId", "expectedEnd",
       status, "cancellationDisposition", "termsVersion", "overstayAuthorized", "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, 'CANCELLED', $6, '1.0', true, NOW())
     RETURNING id, "driverId", "vehicleId", status, "cancellationDisposition"`,
    [
      sessionId,
      driverId,
      vehicleId,
      spot.rows[0].id,
      new Date(Date.now() - 24 * 60 * 60 * 1000), // yesterday
      disposition,
    ],
  );

  const legacyQbReference = testRun
    ? testRun.reference("paid_cancelled")
    : `paid_cancelled_${phone}`;

  const payment = await client.query<{ id: string; amount: number; stripeChargeId: string }>(
    `INSERT INTO "Payment" (id, "sessionId", type, amount, days, status, "stripeChargeId", "legacyQbReference")
     VALUES ($1, $2, 'CHECKIN', $3, 1, 'COMPLETED', $4, $5)
     RETURNING id, amount, "stripeChargeId"`,
    [paymentId, sessionId, amount, stripeChargeId, legacyQbReference],
  );

  return {
    driver: driver.rows[0],
    vehicle: vehicle.rows[0],
    spot: spot.rows[0],
    session: session.rows[0],
    payment: payment.rows[0],
  };
}

export async function seedPaidActiveSession(args?: {
  phone?: string;
  name?: string;
  deviceLabel?: string;
  amount?: number;
  stripeChargeId?: string;
  stripePaymentIntentId?: string;
  testRun?: TestRun;
}) {
  const client = db();
  const testRun = args?.testRun;
  const phone = args?.phone ?? testRun?.driverPhone(0) ?? "5551000003";
  const name = args?.name ?? testRun?.driverName() ?? "Test Driver Paid";
  const email = testRun ? testRun.driverEmail() : `${phone}@example.test`;
  const amount = args?.amount ?? 30.00;
  const driverId = randomUUID();
  const vehicleId = randomUUID();
  const sessionId = randomUUID();
  const paymentId = randomUUID();
  const stripeChargeId = args?.stripeChargeId ?? `ch_test_${paymentId.slice(0, 8)}`;
  const stripePaymentIntentId = args?.stripePaymentIntentId ?? `pi_test_${paymentId.slice(0, 8)}`;

  const driver = await client.query<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
  }>(
    `INSERT INTO "Driver" (id, name, phone, email, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, name, phone, email`,
    [driverId, name, phone, email],
  );

  const vehicle = await client.query<{
    id: string;
    driverId: string;
    type: "TRUCK_TRAILER";
    licensePlate: string | null;
    unitNumber: string | null;
  }>(
    `INSERT INTO "Vehicle" (id, "driverId", type, "licensePlate", "unitNumber", "createdAt", "updatedAt")
     VALUES ($1, $2, 'TRUCK_TRAILER', $3, $4, NOW(), NOW())
     RETURNING id, "driverId", type, "licensePlate", "unitNumber"`,
    [vehicleId, driverId, `PLT${phone.slice(-4)}`, args?.deviceLabel ?? null],
  );

  const spot = await client.query<{ id: string; label: string; type: "TRUCK_TRAILER" }>(
    `SELECT id, label, type FROM "Spot" WHERE type = 'TRUCK_TRAILER' ORDER BY label ASC LIMIT 1`,
  );

  const session = await client.query<{
    id: string;
    driverId: string;
    vehicleId: string;
    spotId: string;
    status: "ACTIVE";
  }>(
    `INSERT INTO "Session" (
      id, "driverId", "vehicleId", "spotId", "expectedEnd",
      "termsVersion", "overstayAuthorized", "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, '1.0', true, NOW())
     RETURNING id, "driverId", "vehicleId", "spotId", status`,
    [sessionId, driverId, vehicleId, spot.rows[0].id, new Date(Date.now() + 24 * 60 * 60 * 1000)],
  );

  const legacyQbReference = testRun
    ? testRun.reference("paid_active")
    : `paid_active_${phone}`;

  const payment = await client.query<{ id: string; amount: number; stripeChargeId: string }>(
    `INSERT INTO "Payment" (
       id, "sessionId", type, amount, days, status,
       "stripeChargeId", "stripePaymentIntentId", "legacyQbReference"
     )
     VALUES ($1, $2, 'CHECKIN', $3, 1, 'COMPLETED', $4, $5, $6)
     RETURNING id, amount, "stripeChargeId"`,
    [paymentId, sessionId, amount, stripeChargeId, stripePaymentIntentId, legacyQbReference],
  );

  return {
    driver: driver.rows[0],
    vehicle: vehicle.rows[0],
    spot: spot.rows[0],
    session: session.rows[0],
    payment: payment.rows[0],
  };
}

export async function countAudit(action: AuditAction, sessionId?: string) {
  const result = await db().query<{ count: string }>(
    `
    SELECT COUNT(*)::text AS count
    FROM "AuditLog"
    WHERE action = $1
      AND ($2::text IS NULL OR "sessionId" = $2)
  `,
    [action, sessionId ?? null],
  );
  return Number(result.rows[0].count);
}

export async function countStripeEvent(eventId: string) {
  const result = await db().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "StripeEvent" WHERE id = $1`,
    [eventId],
  );
  return Number(result.rows[0].count);
}

export async function findDriverByPhone(phone: string) {
  const result = await db().query<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
  }>(
    `SELECT id, name, phone, email FROM "Driver" WHERE phone = $1 LIMIT 1`,
    [phone],
  );
  return result.rows[0] ?? null;
}

/**
 * Seed an ACTIVE session whose expectedEnd is 2 hours in the past.
 * Effective status is OVERSTAY (no cron flip needed). Used for:
 *   - OVERSTAY-002: entry page shows settle-fee screen
 *   - OVERSTAY-005: reconcile flags ACTIVE_SESSION_PAST_EXPECTED_END
 */
export async function seedExpiredActiveSession(args?: {
  phone?: string;
  name?: string;
  testRun?: TestRun;
}) {
  const client = db();
  const testRun = args?.testRun;
  const phone = args?.phone ?? testRun?.driverPhone(0) ?? "5551000004";
  const name = args?.name ?? testRun?.driverName() ?? "Test Overstay Driver";
  const email = testRun ? testRun.driverEmail() : `${phone}@example.test`;
  const driverId = randomUUID();
  const vehicleId = randomUUID();
  const sessionId = randomUUID();
  const paymentId = randomUUID();

  const driver = await client.query<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
  }>(
    `INSERT INTO "Driver" (id, name, phone, email, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, name, phone, email`,
    [driverId, name, phone, email],
  );

  const vehicle = await client.query<{
    id: string;
    driverId: string;
    type: "TRUCK_TRAILER";
  }>(
    `INSERT INTO "Vehicle" (id, "driverId", type, "licensePlate", "unitNumber", "createdAt", "updatedAt")
     VALUES ($1, $2, 'TRUCK_TRAILER', $3, NULL, NOW(), NOW())
     RETURNING id, "driverId", type`,
    [vehicleId, driverId, `PLT${phone.slice(-4)}`],
  );

  const spot = await client.query<{ id: string; label: string; type: "TRUCK_TRAILER" }>(
    `SELECT id, label, type FROM "Spot" WHERE type = 'TRUCK_TRAILER' ORDER BY label ASC LIMIT 1`,
  );

  // expectedEnd 2 hours ago — well past the 15-minute grace period
  const expectedEnd = new Date(Date.now() - 2 * 60 * 60 * 1000);

  const session = await client.query<{
    id: string;
    driverId: string;
    vehicleId: string;
    spotId: string;
    status: "ACTIVE";
  }>(
    `INSERT INTO "Session" (
       id, "driverId", "vehicleId", "spotId", "expectedEnd",
       "termsVersion", "overstayAuthorized", "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, '1.0', true, NOW())
     RETURNING id, "driverId", "vehicleId", "spotId", status`,
    [sessionId, driverId, vehicleId, spot.rows[0].id, expectedEnd],
  );

  const legacyQbReference = testRun
    ? testRun.reference("expired_active")
    : `expired_active_${phone}`;

  await client.query(
    `INSERT INTO "Payment" (id, "sessionId", type, amount, days, "legacyQbReference")
     VALUES ($1, $2, 'CHECKIN', 0, 1, $3)`,
    [paymentId, sessionId, legacyQbReference],
  );

  return {
    driver: driver.rows[0],
    vehicle: vehicle.rows[0],
    spot: spot.rows[0],
    session: session.rows[0],
  };
}

/**
 * Seed an ACTIVE session with a positive completed Payment that has no Stripe IDs.
 * Triggers DB_PAYMENT_WITHOUT_STRIPE_CHARGE in Needs Review.
 */
export async function seedActiveSessionWithOrphanedPayment(args?: {
  phone?: string;
  name?: string;
  amount?: number;
  testRun?: TestRun;
}) {
  const client = db();
  const testRun = args?.testRun;
  const phone = args?.phone ?? testRun?.driverPhone(0) ?? "5551000005";
  const name = args?.name ?? testRun?.driverName() ?? "Test Orphan Driver";
  const email = testRun ? testRun.driverEmail() : `${phone}@example.test`;
  const amount = args?.amount ?? 30.00;
  const driverId = randomUUID();
  const vehicleId = randomUUID();
  const sessionId = randomUUID();
  const paymentId = randomUUID();

  const driver = await client.query<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
  }>(
    `INSERT INTO "Driver" (id, name, phone, email, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, name, phone, email`,
    [driverId, name, phone, email],
  );

  const vehicle = await client.query<{
    id: string;
    driverId: string;
    type: "TRUCK_TRAILER";
  }>(
    `INSERT INTO "Vehicle" (id, "driverId", type, "licensePlate", "unitNumber", "createdAt", "updatedAt")
     VALUES ($1, $2, 'TRUCK_TRAILER', $3, NULL, NOW(), NOW())
     RETURNING id, "driverId", type`,
    [vehicleId, driverId, `PLT${phone.slice(-4)}`],
  );

  const spot = await client.query<{ id: string; label: string }>(
    `SELECT id, label FROM "Spot" WHERE type = 'TRUCK_TRAILER' ORDER BY label ASC LIMIT 1`,
  );

  const session = await client.query<{
    id: string;
    driverId: string;
    vehicleId: string;
    spotId: string;
    status: "ACTIVE";
  }>(
    `INSERT INTO "Session" (
       id, "driverId", "vehicleId", "spotId", "expectedEnd",
       "termsVersion", "overstayAuthorized", "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, '1.0', true, NOW())
     RETURNING id, "driverId", "vehicleId", "spotId", status`,
    [sessionId, driverId, vehicleId, spot.rows[0].id, new Date(Date.now() + 24 * 60 * 60 * 1000)],
  );

  const legacyQbReference = testRun
    ? testRun.reference("orphan_payment")
    : `orphan_payment_${phone}`;

  const payment = await client.query<{ id: string; amount: number }>(
    `INSERT INTO "Payment" (id, "sessionId", type, amount, days, status, "legacyQbReference")
     VALUES ($1, $2, 'CHECKIN', $3, 1, 'COMPLETED', $4)
     RETURNING id, amount`,
    [paymentId, sessionId, amount, legacyQbReference],
  );

  return {
    driver: driver.rows[0],
    vehicle: vehicle.rows[0],
    spot: spot.rows[0],
    session: session.rows[0],
    payment: payment.rows[0],
  };
}

/**
 * Seed an ACTIVE session with a 2-day paid CHECKIN (days=2, amount=$60).
 *
 * Use for ADJUST-002 — the UnitStepper min=1/max=origDays, so a 2-day session
 * is the minimum that allows shortening via the Adjust UI. A 1-day session
 * cannot be shortened (min === max === 1).
 */
export async function seedPaidMultiDayActiveSession(args?: {
  phone?: string;
  name?: string;
  days?: number;
  amount?: number;
  testRun?: TestRun;
}) {
  const client = db();
  const testRun = args?.testRun;
  const days = args?.days ?? 2;
  const phone = args?.phone ?? testRun?.driverPhone(0) ?? "5551000006";
  const name = args?.name ?? testRun?.driverName() ?? "Test MultiDay Driver";
  const email = testRun ? testRun.driverEmail() : `${phone}@example.test`;
  const amount = args?.amount ?? days * 30;
  const driverId = randomUUID();
  const vehicleId = randomUUID();
  const sessionId = randomUUID();
  const paymentId = randomUUID();
  const stripeChargeId = `ch_test_${paymentId.slice(0, 8)}`;
  const stripePaymentIntentId = `pi_test_${paymentId.slice(0, 8)}`;

  const driver = await client.query<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
  }>(
    `INSERT INTO "Driver" (id, name, phone, email, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, name, phone, email`,
    [driverId, name, phone, email],
  );

  const vehicle = await client.query<{ id: string; driverId: string; type: "TRUCK_TRAILER" }>(
    `INSERT INTO "Vehicle" (id, "driverId", type, "licensePlate", "unitNumber", "createdAt", "updatedAt")
     VALUES ($1, $2, 'TRUCK_TRAILER', $3, NULL, NOW(), NOW())
     RETURNING id, "driverId", type`,
    [vehicleId, driverId, `PLT${phone.slice(-4)}`],
  );

  const spot = await client.query<{ id: string; label: string; type: "TRUCK_TRAILER" }>(
    `SELECT id, label, type FROM "Spot" WHERE type = 'TRUCK_TRAILER' ORDER BY label ASC LIMIT 1`,
  );

  const session = await client.query<{
    id: string;
    driverId: string;
    vehicleId: string;
    spotId: string;
    status: "ACTIVE";
    startedAt: string;
    expectedEnd: string;
  }>(
    `INSERT INTO "Session" (
       id, "driverId", "vehicleId", "spotId", "expectedEnd",
       "termsVersion", "overstayAuthorized", "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, '1.0', true, NOW())
     RETURNING id, "driverId", "vehicleId", "spotId", status, "startedAt", "expectedEnd"`,
    [sessionId, driverId, vehicleId, spot.rows[0].id, new Date(Date.now() + days * 24 * 60 * 60 * 1000)],
  );

  const legacyQbReference = testRun
    ? testRun.reference("multiday_active")
    : `multiday_active_${phone}`;

  const payment = await client.query<{ id: string; amount: number; days: number }>(
    `INSERT INTO "Payment" (
       id, "sessionId", type, amount, days, status,
       "stripeChargeId", "stripePaymentIntentId", "legacyQbReference"
     )
     VALUES ($1, $2, 'CHECKIN', $3, $4, 'COMPLETED', $5, $6, $7)
     RETURNING id, amount, days`,
    [paymentId, sessionId, amount, days, stripeChargeId, stripePaymentIntentId, legacyQbReference],
  );

  return {
    driver: driver.rows[0],
    vehicle: vehicle.rows[0],
    spot: spot.rows[0],
    session: session.rows[0],
    payment: payment.rows[0],
  };
}

/**
 * Seed an ACTIVE session that is effectively in OVERSTAY (expectedEnd 3h ago),
 * with a CHECKIN payment (Stripe IDs) and a second OVERSTAY payment created NOW.
 *
 * Use for ADMIN-002 — the close action with a backdated endedAt (e.g. 2h ago)
 * should delete the OVERSTAY payment (createdAt > closedAt) and mark the session COMPLETED.
 */
export async function seedOverstaySessionWithPayment(args?: {
  phone?: string;
  name?: string;
  checkinAmount?: number;
  overstayAmount?: number;
  testRun?: TestRun;
}) {
  const client = db();
  const testRun = args?.testRun;
  const phone = args?.phone ?? testRun?.driverPhone(0) ?? "5551000007";
  const name = args?.name ?? testRun?.driverName() ?? "Test Overstay Close Driver";
  const email = testRun ? testRun.driverEmail() : `${phone}@example.test`;
  const checkinAmount = args?.checkinAmount ?? 30;
  const overstayAmount = args?.overstayAmount ?? 15;
  const driverId = randomUUID();
  const vehicleId = randomUUID();
  const sessionId = randomUUID();
  const checkinPaymentId = randomUUID();
  const overstayPaymentId = randomUUID();
  const stripeChargeId = `ch_test_${checkinPaymentId.slice(0, 8)}`;
  const stripePaymentIntentId = `pi_test_${checkinPaymentId.slice(0, 8)}`;

  const driver = await client.query<{
    id: string; name: string; phone: string; email: string | null;
  }>(
    `INSERT INTO "Driver" (id, name, phone, email, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, name, phone, email`,
    [driverId, name, phone, email],
  );

  const vehicle = await client.query<{ id: string; driverId: string; type: "TRUCK_TRAILER" }>(
    `INSERT INTO "Vehicle" (id, "driverId", type, "licensePlate", "unitNumber", "createdAt", "updatedAt")
     VALUES ($1, $2, 'TRUCK_TRAILER', $3, NULL, NOW(), NOW())
     RETURNING id, "driverId", type`,
    [vehicleId, driverId, `PLT${phone.slice(-4)}`],
  );

  const spot = await client.query<{ id: string; label: string }>(
    `SELECT id, label FROM "Spot" WHERE type = 'TRUCK_TRAILER' ORDER BY label ASC LIMIT 1`,
  );

  // Session started 1 day ago and expectedEnd 3 hours ago — clearly past grace,
  // effectively OVERSTAY, while allowing admin close to be backdated 2h ago.
  const startedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const expectedEnd = new Date(Date.now() - 3 * 60 * 60 * 1000);

  const session = await client.query<{
    id: string; driverId: string; vehicleId: string; spotId: string; status: "ACTIVE";
  }>(
    `INSERT INTO "Session" (
       id, "driverId", "vehicleId", "spotId", "startedAt", "expectedEnd",
       "termsVersion", "overstayAuthorized", "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, $6, '1.0', true, NOW())
     RETURNING id, "driverId", "vehicleId", "spotId", status`,
    [sessionId, driverId, vehicleId, spot.rows[0].id, startedAt, expectedEnd],
  );

  const legacyRef = testRun
    ? testRun.reference("overstay_close")
    : `overstay_close_${phone}`;

  // CHECKIN payment (pre-overstay, has Stripe IDs — not affected by close action)
  const checkinPayment = await client.query<{ id: string; amount: number }>(
    `INSERT INTO "Payment" (
       id, "sessionId", type, amount, days, status,
       "stripeChargeId", "stripePaymentIntentId", "legacyQbReference"
     )
     VALUES ($1, $2, 'CHECKIN', $3, 1, 'COMPLETED', $4, $5, $6)
     RETURNING id, amount`,
    [checkinPaymentId, sessionId, checkinAmount, stripeChargeId, stripePaymentIntentId, legacyRef],
  );

  // OVERSTAY payment created NOW — will be deleted when close backdates to 2h ago
  const overstayPayment = await client.query<{ id: string; amount: number }>(
    `INSERT INTO "Payment" (id, "sessionId", type, amount, days, status, "legacyQbReference")
     VALUES ($1, $2, 'OVERSTAY', $3, 1, 'COMPLETED', $4)
     RETURNING id, amount`,
    [overstayPaymentId, sessionId, overstayAmount, `${legacyRef}_overstay`],
  );

  return {
    driver: driver.rows[0],
    vehicle: vehicle.rows[0],
    spot: spot.rows[0],
    session: session.rows[0],
    checkinPayment: checkinPayment.rows[0],
    overstayPayment: overstayPayment.rows[0],
  };
}

type AllowListLabel =
  | "EMPLOYEE"
  | "FAMILY"
  | "VENDOR"
  | "CONTRACTOR"
  | "Employee"
  | "Family"
  | "Vendor"
  | "Contractor";

const allowListLabelMap: Record<AllowListLabel, "EMPLOYEE" | "FAMILY" | "VENDOR" | "CONTRACTOR"> = {
  EMPLOYEE: "EMPLOYEE",
  FAMILY: "FAMILY",
  VENDOR: "VENDOR",
  CONTRACTOR: "CONTRACTOR",
  Employee: "EMPLOYEE",
  Family: "FAMILY",
  Vendor: "VENDOR",
  Contractor: "CONTRACTOR",
};

/**
 * Seed an active AllowList row.
 *
 * Use for NORMAL-006 (allow-list fresh scan opens gate) and GATE-003
 * (allow-list non-fresh scan denied).
 *
 * The entry has no corresponding Driver row — allow-list access is phone-only.
 */
export async function seedAllowListEntry(args?: {
  phone?: string;
  name?: string;
  label?: AllowListLabel;
  active?: boolean;
  testRun?: TestRun;
}) {
  const client = db();
  const phone = args?.phone ?? args?.testRun?.driverPhone(0) ?? "5559000001";
  const name = args?.name ?? args?.testRun?.driverName() ?? "Test Allow Listed";
  const label = allowListLabelMap[args?.label ?? "EMPLOYEE"];
  const active = args?.active ?? true;
  const id = randomUUID();

  const entry = await client.query<{
    id: string;
    phone: string;
    name: string;
    label: string;
    active: boolean;
  }>(
    `INSERT INTO "AllowList" (id, phone, name, label, active)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (phone) DO UPDATE
       SET name = $3, label = $4, active = $5
     RETURNING id, phone, name, label, active`,
    [id, phone, name, label, active],
  );

  return { entry: entry.rows[0] };
}

/**
 * Seed a Driver + Vehicle without creating a Session.
 * Use when the Session will be created by a webhook handler (e.g. PAYMENT-QB-001).
 */
export async function seedDriverAndVehicle(args?: {
  phone?: string;
  name?: string;
  testRun?: TestRun;
}) {
  const client = db();
  const testRun = args?.testRun;
  const phone = args?.phone ?? testRun?.driverPhone(0) ?? "5551000010";
  const name = args?.name ?? testRun?.driverName() ?? "Test Driver";
  const email = testRun ? testRun.driverEmail() : `${phone}@example.test`;
  const driverId = randomUUID();
  const vehicleId = randomUUID();

  const driver = await client.query<{ id: string; name: string; phone: string; email: string | null }>(
    `INSERT INTO "Driver" (id, name, phone, email, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, name, phone, email`,
    [driverId, name, phone, email],
  );

  const vehicle = await client.query<{ id: string; driverId: string; type: string; licensePlate: string | null }>(
    `INSERT INTO "Vehicle" (id, "driverId", type, "licensePlate", "unitNumber", "createdAt", "updatedAt")
     VALUES ($1, $2, 'TRUCK_TRAILER', $3, NULL, NOW(), NOW())
     RETURNING id, "driverId", type, "licensePlate"`,
    [vehicleId, driverId, `PLT${phone.slice(-4)}`],
  );

  return { driver: driver.rows[0], vehicle: vehicle.rows[0] };
}

/**
 * Write QB OAuth tokens into the Settings row so the app's getTokens() can
 * connect to the QB sandbox during E2E tests.
 *
 * Pass tokenExpiresAt = null to skip the token-refresh logic entirely (the
 * app uses qbAccessToken as-is). Pass a past Date to force a refresh attempt.
 */
export async function seedQbSettings(args: {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt?: Date | null;
}) {
  await db().query(
    `UPDATE "Settings"
     SET "qbRealmId" = $1,
         "qbAccessToken" = $2,
         "qbRefreshToken" = $3,
         "qbTokenExpiresAt" = $4
     WHERE id = 'default'`,
    [args.realmId, args.accessToken, args.refreshToken, args.tokenExpiresAt ?? null],
  );
}

/**
 * Find a Payment row by its Stripe PaymentIntent ID.
 * Returns null if not found.
 */
export async function findPaymentByStripePaymentIntentId(paymentIntentId: string) {
  const result = await db().query<{
    id: string;
    sessionId: string;
    amount: number;
    status: string;
    refundedAmount: number | null;
    stripeChargeId: string | null;
    stripePaymentIntentId: string | null;
    qbSalesReceiptId: string | null;
  }>(
    `SELECT id, "sessionId", amount, status, "refundedAmount",
            "stripeChargeId", "stripePaymentIntentId", "qbSalesReceiptId"
     FROM "Payment"
     WHERE "stripePaymentIntentId" = $1
     LIMIT 1`,
    [paymentIntentId],
  );
  return result.rows[0] ?? null;
}

/**
 * Find a PaymentRefund row by its Stripe refund ID.
 * Returns null if not found.
 */
/**
 * Return all Payment rows for a subscription, ordered by creation time.
 * Used to assert hostedInvoiceUrl and type after invoice webhook events.
 */
export async function findPaymentsByStripeSubscriptionId(stripeSubscriptionId: string) {
  const result = await db().query<{
    id: string;
    sessionId: string;
    type: string;
    amount: number;
    status: string;
    stripeInvoiceId: string | null;
    hostedInvoiceUrl: string | null;
  }>(
    `SELECT id, "sessionId", type, amount, status, "stripeInvoiceId", "hostedInvoiceUrl"
     FROM "Payment"
     WHERE "stripeSubscriptionId" = $1
     ORDER BY "createdAt" ASC`,
    [stripeSubscriptionId],
  );
  return result.rows;
}

export async function findPaymentRefundByStripeRefundId(stripeRefundId: string) {
  const result = await db().query<{
    id: string;
    paymentId: string;
    amount: number;
    stripeRefundId: string;
    qbRefundReceiptId: string | null;
    qbRefundReceiptAmount: number | null;
  }>(
    `SELECT id, "paymentId", amount, "stripeRefundId", "qbRefundReceiptId", "qbRefundReceiptAmount"
     FROM "PaymentRefund"
     WHERE "stripeRefundId" = $1
     LIMIT 1`,
    [stripeRefundId],
  );
  return result.rows[0] ?? null;
}

/**
 * Seed an ACTIVE monthly session with a MONTHLY_CHECKIN payment that has a stripeSubscriptionId.
 * Session + Payment are DB-only — no real Stripe subscription is created.
 * Use for SUB-002 (payment_failed) and SUB-004 (subscription.deleted) tests.
 */
export async function seedMonthlyActiveSession(args?: {
  phone?: string;
  name?: string;
  amount?: number;
  stripeSubscriptionId?: string;
  testRun?: TestRun;
}) {
  const client = db();
  const testRun = args?.testRun;
  const phone = args?.phone ?? testRun?.driverPhone(0) ?? "5551000011";
  const name = args?.name ?? testRun?.driverName() ?? "Test Monthly Driver";
  const email = testRun ? testRun.driverEmail() : `${phone}@example.test`;
  const amount = args?.amount ?? 400.00;
  const driverId = randomUUID();
  const vehicleId = randomUUID();
  const sessionId = randomUUID();
  const paymentId = randomUUID();
  const stripeSubscriptionId = args?.stripeSubscriptionId ?? `sub_test_${paymentId.slice(0, 8)}`;

  const driver = await client.query<{ id: string; name: string; phone: string; email: string | null }>(
    `INSERT INTO "Driver" (id, name, phone, email, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, name, phone, email`,
    [driverId, name, phone, email],
  );

  const vehicle = await client.query<{ id: string; driverId: string; type: string }>(
    `INSERT INTO "Vehicle" (id, "driverId", type, "licensePlate", "unitNumber", "createdAt", "updatedAt")
     VALUES ($1, $2, 'TRUCK_TRAILER', $3, NULL, NOW(), NOW())
     RETURNING id, "driverId", type`,
    [vehicleId, driverId, `PLT${phone.slice(-4)}`],
  );

  const spot = await client.query<{ id: string; label: string }>(
    `SELECT id, label FROM "Spot" WHERE type = 'TRUCK_TRAILER' ORDER BY label ASC LIMIT 1`,
  );

  const expectedEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const session = await client.query<{
    id: string; driverId: string; vehicleId: string; spotId: string;
    status: string; billingStatus: string; expectedEnd: string;
  }>(
    `INSERT INTO "Session" (
       id, "driverId", "vehicleId", "spotId", "expectedEnd",
       "termsVersion", "overstayAuthorized", "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, '1.0', true, NOW())
     RETURNING id, "driverId", "vehicleId", "spotId", status, "billingStatus", "expectedEnd"`,
    [sessionId, driverId, vehicleId, spot.rows[0].id, expectedEnd],
  );

  const legacyQbReference = testRun
    ? testRun.reference("monthly_active")
    : `monthly_active_${phone}`;

  const payment = await client.query<{ id: string; amount: number; stripeSubscriptionId: string }>(
    `INSERT INTO "Payment" (
       id, "sessionId", type, amount, status,
       "stripeSubscriptionId", "legacyQbReference"
     )
     VALUES ($1, $2, 'MONTHLY_CHECKIN', $3, 'COMPLETED', $4, $5)
     RETURNING id, amount, "stripeSubscriptionId"`,
    [paymentId, sessionId, amount, stripeSubscriptionId, legacyQbReference],
  );

  return {
    driver: driver.rows[0],
    vehicle: vehicle.rows[0],
    spot: spot.rows[0],
    session: session.rows[0],
    payment: payment.rows[0],
  };
}

/**
 * Find a Session (with its billingStatus and expectedEnd) by the stripeSubscriptionId
 * of its linked MONTHLY_CHECKIN Payment.
 */
export async function findSessionByStripeSubscriptionId(stripeSubscriptionId: string) {
  const result = await db().query<{
    id: string;
    driverId: string;
    status: string;
    billingStatus: string;
    expectedEndMs: string; // bigint from Postgres, returned as string by pg
  }>(
    // Use EXTRACT(EPOCH) to return milliseconds as a number, bypassing the
    // TIMESTAMP WITHOUT TIME ZONE string-parsing ambiguity in Node.js (pg returns
    // the raw local-time string which new Date() may interpret with a TZ offset).
    `SELECT s.id, s."driverId", s.status, s."billingStatus",
            FLOOR(EXTRACT(EPOCH FROM s."expectedEnd") * 1000)::bigint AS "expectedEndMs"
     FROM "Session" s
     JOIN "Payment" p ON p."sessionId" = s.id
     WHERE p."stripeSubscriptionId" = $1
     LIMIT 1`,
    [stripeSubscriptionId],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return { ...row, expectedEndMs: Number(row.expectedEndMs) };
}

/**
 * Backdate a session's billingFailedAt to `date`.
 * Used for DELINQ-003: set a past billingFailedAt so the cron escalates
 * PAYMENT_FAILED → DELINQUENT when the grace period policy is configured.
 */
export async function updateSessionBillingFailedAt(sessionId: string, date: Date) {
  await db().query(`UPDATE "Session" SET "billingFailedAt" = $1 WHERE id = $2`, [date, sessionId]);
}

export async function updateSessionExpectedEnd(sessionId: string, date: Date) {
  await db().query(`UPDATE "Session" SET "expectedEnd" = $1 WHERE id = $2`, [date, sessionId]);
}

export async function setSessionBillingCancelledByAdmin(sessionId: string) {
  await db().query(`UPDATE "Session" SET "billingCancelledByAdmin" = true WHERE id = $1`, [sessionId]);
}

/**
 * Forces billingStatus to PAYMENT_FAILED and clears billingFailedAt to NULL.
 * Used for DELINQ-017: fail-closed test for legacy/corrupt rows.
 */
export async function setBillingPaymentFailedWithNullTimestamp(sessionId: string) {
  await db().query(
    `UPDATE "Session" SET "billingStatus" = 'PAYMENT_FAILED', "billingFailedAt" = NULL WHERE id = $1`,
    [sessionId],
  );
}

export async function setSessionBillingPaymentFailed(sessionId: string) {
  await db().query(
    `UPDATE "Session" SET "billingStatus" = 'PAYMENT_FAILED', "billingFailedAt" = NOW() WHERE id = $1`,
    [sessionId],
  );
}

export async function setPaymentHostedInvoiceUrl(paymentId: string, url: string) {
  await db().query(`UPDATE "Payment" SET "hostedInvoiceUrl" = $1 WHERE id = $2`, [url, paymentId]);
}

/**
 * Reads the most recent SUBSCRIPTION_CANCELED audit row for a session.
 * Used for DELINQ-019: verify the [SUB_DEL:UNKNOWN] prefix is present on
 * unknown-reason deletions.
 */
export async function readLatestSubscriptionCanceledAudit(sessionId: string) {
  const result = await db().query<{ details: string; "createdAt": string }>(
    `SELECT details, "createdAt" FROM "AuditLog"
     WHERE action = 'SUBSCRIPTION_CANCELED' AND "sessionId" = $1
     ORDER BY "createdAt" DESC LIMIT 1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function setSessionStatus(sessionId: string, status: "ACTIVE" | "COMPLETED" | "CANCELLED" | "OVERSTAY") {
  await db().query(`UPDATE "Session" SET status = $1 WHERE id = $2`, [status, sessionId]);
}

export async function getSessionEvidenceSnapshot(sessionId: string) {
  const client = db();
  const [sessions, drivers, vehicles, payments, refunds, audits] = await Promise.all([
    client.query(
      `SELECT id, status, "billingStatus", "billingFailedAt", "billingDelinquentAt",
              "billingCancelledByAdmin", "cancellationDisposition", "startedAt",
              "expectedEnd", "endedAt", "driverId", "vehicleId", "spotId"
       FROM "Session"
       WHERE id = $1`,
      [sessionId],
    ),
    client.query(
      `SELECT d.id, d.name, d.phone, d.email
       FROM "Driver" d
       JOIN "Session" s ON s."driverId" = d.id
       WHERE s.id = $1`,
      [sessionId],
    ),
    client.query(
      `SELECT v.id, v.type, v."licensePlate", v."unitNumber", v.nickname
       FROM "Vehicle" v
       JOIN "Session" s ON s."vehicleId" = v.id
       WHERE s.id = $1`,
      [sessionId],
    ),
    client.query(
      `SELECT id, type, amount, status, "refundedAmount", "stripeSubscriptionId",
              "stripePaymentIntentId", "stripeChargeId", "qbSalesReceiptId",
              "createdAt"
       FROM "Payment"
       WHERE "sessionId" = $1
       ORDER BY "createdAt", id`,
      [sessionId],
    ),
    client.query(
      `SELECT r.id, r."paymentId", r.amount, r."stripeRefundId",
              r."qbRefundReceiptId", r."createdAt"
       FROM "PaymentRefund" r
       JOIN "Payment" p ON p.id = r."paymentId"
       WHERE p."sessionId" = $1
       ORDER BY r."createdAt", r.id`,
      [sessionId],
    ),
    client.query(
      `SELECT id, action, details, "createdAt"
       FROM "AuditLog"
       WHERE "sessionId" = $1
       ORDER BY "createdAt", id`,
      [sessionId],
    ),
  ]);

  return {
    session: sessions.rows,
    driver: drivers.rows,
    vehicle: vehicles.rows,
    payments: payments.rows,
    refunds: refunds.rows,
    auditLogs: audits.rows,
  };
}

/**
 * Update the failedPaymentPolicy and failedPaymentGraceDays on the Settings row.
 * Use for DELINQ tests that need specific policy before seeding.
 */
export async function setFailedPaymentPolicy(
  policy: "on_subscription_deleted" | "immediate_on_payment_failed" | "after_grace_days",
  graceDays?: number,
) {
  await db().query(
    `UPDATE "Settings" SET "failedPaymentPolicy" = $1, "failedPaymentGraceDays" = $2 WHERE id = 'default'`,
    [policy, graceDays ?? 7],
  );
}

export async function countPaymentsByTypeForSession(sessionId: string, type: string) {
  const result = await db().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "Payment" WHERE "sessionId" = $1 AND type = $2`,
    [sessionId, type],
  );
  return Number(result.rows[0].count);
}

export async function readSessionBillingDiagnostic(sessionId: string) {
  const result = await db().query<{
    billingStatus: string;
    billingFailedAt: string | null;
    failedPaymentPolicy: string;
    failedPaymentGraceDays: number;
    server_now_ms: string;
  }>(
    `SELECT s."billingStatus", s."billingFailedAt",
            st."failedPaymentPolicy", st."failedPaymentGraceDays",
            EXTRACT(EPOCH FROM NOW()) * 1000 AS server_now_ms
     FROM "Session" s, "Settings" st
     WHERE s.id = $1 AND st.id = 'default'`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function readGateDeniedAuditDetail(sessionId: string) {
  const result = await db().query<{ details: string; "createdAt": string }>(
    `SELECT details, "createdAt" FROM "AuditLog"
     WHERE action = 'GATE_DENIED' AND "sessionId" = $1
     ORDER BY "createdAt" DESC LIMIT 1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function findSessionsByDriverPhone(phone: string) {
  const result = await db().query<{
    id: string;
    driverId: string;
    status: string;
    startedAt: string;
    expectedEnd: string;
  }>(
    `
    SELECT s.id, s."driverId", s.status, s."startedAt", s."expectedEnd"
    FROM "Session" s
    JOIN "Driver" d ON d.id = s."driverId"
    WHERE d.phone = $1
    ORDER BY s."startedAt" DESC
  `,
    [phone],
  );
  return result.rows;
}
