import { expect, test } from "@playwright/test";
import { countAudit, disconnectDb, resetDb, seedActiveDriverSession } from "../../support/db";
import { postDriverOpenGate } from "../../support/app-api";
import { createTestRun } from "../../support/test-run";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed driver e2e tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// GATE-001: internal scanContext is rejected before session lookup
// ---------------------------------------------------------------------------

test("GATE-001: open-gate with scanContext=internal returns RESCAN_REQUIRED, no gate opens", async ({
  request,
}, testInfo) => {
  const testRun = createTestRun(testInfo);
  const { driver, session } = await seedActiveDriverSession({ testRun });

  const result = await postDriverOpenGate(request, session.id, {
    driverId: driver.id,
    direction: "ENTRANCE",
    scanContext: "internal",
    deviceId: "test-device-gate-001",
  });

  // ── Response contract ─────────────────────────────────────────────────────
  expect(result.status).toBe(200);
  expect(result.data.ok).toBe(false);
  const denial = (result.data as { ok: false; denial: { code: string } }).denial;
  expect(denial.code).toBe("RESCAN_REQUIRED");

  // ── Audit contract: gate never opened ────────────────────────────────────
  // The internal-scanContext check fires before session validation, so no
  // GATE_DENIED is logged either — the route returns without reaching audit code.
  expect(await countAudit("GATE_OPEN", session.id)).toBe(0);
});

// ---------------------------------------------------------------------------
// GATE-006: second exit attempt with scanContext=internal does not re-open gate
// ---------------------------------------------------------------------------

test("GATE-006: fresh exit opens gate once; subsequent internal-scan attempt is rejected", async ({
  request,
}, testInfo) => {
  const testRun = createTestRun(testInfo);
  const { driver, session } = await seedActiveDriverSession({ testRun });

  // ── First exit: fresh scan → gate opens ──────────────────────────────────
  const first = await postDriverOpenGate(request, session.id, {
    driverId: driver.id,
    direction: "EXIT",
    scanContext: "fresh",
    deviceId: "test-device-gate-006",
  });
  expect(first.status).toBe(200);
  expect(first.data.ok).toBe(true);
  expect(await countAudit("GATE_OPEN", session.id)).toBe(1);

  // ── Second attempt: internal scan (reload / back-button simulation) ───────
  // scanContext="internal" is rejected server-side before any session check.
  // No additional GATE_OPEN is logged.
  const second = await postDriverOpenGate(request, session.id, {
    driverId: driver.id,
    direction: "EXIT",
    scanContext: "internal",
    deviceId: "test-device-gate-006",
  });
  expect(second.status).toBe(200);
  expect(second.data.ok).toBe(false);
  const denial = (second.data as { ok: false; denial: { code: string } }).denial;
  expect(denial.code).toBe("RESCAN_REQUIRED");

  // Gate opened exactly once — the second attempt was blocked
  expect(await countAudit("GATE_OPEN", session.id)).toBe(1);
});
