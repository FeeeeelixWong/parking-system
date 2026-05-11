import { expect, test } from "@playwright/test";
import { disconnectDb, resetDb } from "../../support/db";
import { authenticateAdmin, putAdminSession } from "../../support/app-api";
import { createWorld } from "../../support/world";
import { seedOverstaySessionWithCleanupPayment } from "../../support/scenarios/daily";
import {
  expectSessionStatus,
  expectPaymentCount,
  expectAuditCount,
} from "../../support/assertions/db";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed admin close tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// ADMIN-002: close/backdate removes OVERSTAY payment created after backdated end
// ---------------------------------------------------------------------------

test("ADMIN-002: backdated close deletes OVERSTAY payment seeded after closedAt, session COMPLETED", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: ACTIVE session, expectedEnd 3h ago.
  //   - CHECKIN payment (has Stripe IDs) — survives the close (type != OVERSTAY)
  //   - OVERSTAY payment created NOW — should be deleted (createdAt > closedAt)
  const { session, checkinPayment, overstayPayment } =
    await seedOverstaySessionWithCleanupPayment(world, {
      checkinAmount: 30,
      overstayAmount: 15,
    });

  await authenticateAdmin(request);

  // Backdate the close to 2 hours ago.
  // The OVERSTAY payment (createdAt = NOW) is after this threshold → gets deleted.
  // The CHECKIN payment survives (type = CHECKIN, not OVERSTAY).
  const closedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

  const result = await putAdminSession(request, {
    sessionId: session.id,
    action: "close",
    reason: "Driver confirmed departure at 2 hours ago — admin backdated close",
    endedAt: closedAt.toISOString(),
  });

  // ── Response contract ─────────────────────────────────────────────────────
  expect(result.status).toBe(200);
  expect((result.data as { success: boolean }).success).toBe(true);
  expect((result.data as { paymentsRemoved: number }).paymentsRemoved).toBe(1);

  // ── DB assertions ─────────────────────────────────────────────────────────
  await expectSessionStatus(session.id, "COMPLETED");
  // OVERSTAY payment (created NOW, after closedAt 2h ago) is deleted
  await expectPaymentCount(session.id, "OVERSTAY", 0);
  // CHECKIN payment is preserved
  await expectPaymentCount(session.id, "CHECKIN", 1);
  // close action always logs SPOT_FREED
  await expectAuditCount("SPOT_FREED", 1, session.id);

  // Suppress "unused reference" lint — IDs are in the seed return for test clarity
  void checkinPayment;
  void overstayPayment;

  await world.cleanup();
});
