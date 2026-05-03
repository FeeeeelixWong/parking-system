import { prisma } from "./prisma";
import { Prisma, VehicleType } from "@/generated/prisma/client";
import { getSettings } from "./settings";

type SpotRow = { id: string; label: string };

/**
 * Execute a locked spot query using FOR UPDATE SKIP LOCKED.
 *
 * Within a transaction, this lock persists until the transaction commits —
 * a second concurrent transaction will skip the locked row and pick another
 * spot, eliminating the race window between "find spot" and "create session".
 */
async function pickSpot(
  vehicleType: string,
  client: typeof prisma | Prisma.TransactionClient,
): Promise<SpotRow | null> {
  const spots = await (client as typeof prisma).$queryRaw<SpotRow[]>`
    SELECT s.id, s.label
    FROM "Spot" s
    WHERE s.type = ${vehicleType}
      AND NOT EXISTS (
        SELECT 1 FROM "Session" sess
        WHERE sess."spotId" = s.id
          AND sess.status IN ('ACTIVE', 'OVERSTAY')
      )
    ORDER BY s.label ASC
    LIMIT 1
    FOR UPDATE OF s SKIP LOCKED
  `;
  return spots[0] ?? null;
}

/**
 * Find and lock a free spot for the given vehicle type.
 *
 * Pass a Prisma transaction client (`tx`) from a `$transaction(fn)` block
 * so the FOR UPDATE SKIP LOCKED lock persists until the transaction commits.
 * Create the Session row inside the same transaction to atomically claim the
 * spot — no other concurrent check-in can select the same spot until your
 * transaction commits.
 *
 * Callers that omit `tx` are not protected against concurrent races (the lock
 * is released immediately after the SELECT). Only use without `tx` for
 * low-concurrency paths (e.g. admin manual session creation).
 */
export async function assignSpot(
  vehicleType: VehicleType,
  tx?: Prisma.TransactionClient,
): Promise<SpotRow | null> {
  const client = tx ?? prisma;

  const spot = await pickSpot(vehicleType, client);
  if (spot) return spot;

  // Bobtail overflow: a bobtail can use a TRUCK_TRAILER spot when bobtail spots are full.
  if (vehicleType === "BOBTAIL") {
    const settings = await getSettings();
    if (settings.bobtailOverflow) {
      return pickSpot("TRUCK_TRAILER", client);
    }
  }

  return null;
}

/** Read-only count of free spots per type. No locking — display only. */
export async function countFreeSpots(): Promise<{ bobtail: number; truck: number }> {
  const [bobtail, truck] = await Promise.all([
    prisma.spot.count({
      where: {
        type: "BOBTAIL",
        sessions: { none: { status: { in: ["ACTIVE", "OVERSTAY"] } } },
      },
    }),
    prisma.spot.count({
      where: {
        type: "TRUCK_TRAILER",
        sessions: { none: { status: { in: ["ACTIVE", "OVERSTAY"] } } },
      },
    }),
  ]);
  return { bobtail, truck };
}
