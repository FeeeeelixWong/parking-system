import { expect, test } from "@playwright/test";
import { countAudit, disconnectDb, resetDb, seedActiveDriverSession } from "../../support/db";
import { setSavedDriverAndDevice } from "../../support/driver-ui";
import { createWorld } from "../../support/world";
import { seedOverstayEffectiveSession } from "../../support/scenarios/daily";

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
// NORMAL-005: active exit — gate opens automatically on fresh /exit navigation
// ---------------------------------------------------------------------------

test("NORMAL-005: active driver scans /exit, gate opens, GATE_OPEN logged", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: ACTIVE daily session — DB status ACTIVE, expectedEnd in the future.
  const { driver, session } = await seedActiveDriverSession({ testRun: world.testRun });

  // Set saved driver + device so /exit can look up the session immediately.
  await setSavedDriverAndDevice(page, driver, "device-normal-005");

  // Fresh navigation → exit page fires driver-state lookup and auto-opens gate.
  await page.goto("/exit");

  // ── UI contract: gate-opened confirmation is shown ────────────────────────
  await expect(
    page.getByText("Gate opening · Puerta abierta"),
  ).toBeVisible({ timeout: 10_000 });

  // ── Audit contract: exactly one GATE_OPEN for this session ───────────────
  expect(await countAudit("GATE_OPEN", session.id)).toBe(1);

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// OVERSTAY-003: overstay driver at exit sees payment screen; gate stays closed
// ---------------------------------------------------------------------------

test("OVERSTAY-003: overstay driver at exit sees settle-fee prompt, gate never opens", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: ACTIVE session with expectedEnd 2h ago — driver state API computes
  // effectiveStatus = OVERSTAY and returns it as the session status.
  // The exit page skips the auto-gate path (s.status !== "ACTIVE") and shows
  // the overstay view instead.
  const { driver, session } = await seedOverstayEffectiveSession(world);

  await setSavedDriverAndDevice(page, driver, "device-overstay-003");

  const opensBefore = await countAudit("GATE_OPEN", session.id);

  await page.goto("/exit");

  // ── UI contract: overstay payment prompt is shown ─────────────────────────
  await expect(
    page.getByText("Overstay fees must be settled before the gate can open."),
  ).toBeVisible({ timeout: 10_000 });

  // ── Audit contract: gate never opened ────────────────────────────────────
  await expect
    .poll(() => countAudit("GATE_OPEN", session.id), { timeout: 5000 })
    .toBe(opensBefore);

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// GATE-007: /exit reload does not re-open gate; rescan UI is shown
// ---------------------------------------------------------------------------

test("GATE-007: /exit page reload after gate open does not fire gate a second time", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);

  const { driver, session } = await seedActiveDriverSession({ testRun: world.testRun });

  await setSavedDriverAndDevice(page, driver, "device-gate-007");

  // ── First navigation: fresh scan → gate fires once ────────────────────────
  await page.goto("/exit");
  await expect(
    page.getByText("Gate opening · Puerta abierta"),
  ).toBeVisible({ timeout: 10_000 });
  expect(await countAudit("GATE_OPEN", session.id)).toBe(1);

  // ── Reload: PerformanceNavigationTiming.type becomes "reload" ────────────
  // isExternalNavigation() returns false → freshScan.current = false
  // The gate_active effect sees !freshScan.current → setGateDenied(true)
  await page.reload();

  // ── UI contract: rescan prompt shown, NOT the gate-opened screen ─────────
  await expect(
    page.getByText("Please re-scan the QR code at the gate to open it."),
  ).toBeVisible({ timeout: 10_000 });

  // ── Audit contract: GATE_OPEN count unchanged after reload ───────────────
  await expect
    .poll(() => countAudit("GATE_OPEN", session.id), { timeout: 5000 })
    .toBe(1);

  await world.cleanup();
});
