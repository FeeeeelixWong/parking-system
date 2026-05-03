import { randomUUID } from "node:crypto";
import { Pool } from "pg";

type AuditAction =
  | "GATE_OPEN"
  | "GATE_DENIED"
  | "SUSPICIOUS_ENTRY"
  | "CHECKIN"
  | "CHECKOUT";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
let pool: Pool | null = null;

export function requireTestDatabaseUrl(): string {
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for Playwright DB tests.");
  }
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
  await client.query(`
    DELETE FROM "StripeEvent";
    DELETE FROM "AuditLog";
    DELETE FROM "PaymentRefund";
    DELETE FROM "Payment";
    DELETE FROM "Session";
    DELETE FROM "Spot";
    DELETE FROM "Vehicle";
    DELETE FROM "Driver";
    DELETE FROM "AllowList";
    DELETE FROM "Settings";
  `);

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
}) {
  const client = db();
  const phone = args?.phone ?? "5551000001";
  const name = args?.name ?? "Test Driver";
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
    [driverId, name, phone, `${phone}@example.test`],
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

  await client.query(
    `
    INSERT INTO "Payment" (id, "sessionId", type, amount, days, "legacyQbReference")
    VALUES ($1, $2, 'CHECKIN', 0, 1, $3)
  `,
    [paymentId, sessionId, `free_test_${phone}`],
  );

  return {
    driver: driver.rows[0],
    vehicle: vehicle.rows[0],
    spot: spot.rows[0],
    session: session.rows[0],
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
