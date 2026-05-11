import { expect, test } from "@playwright/test";
import { countAudit, disconnectDb, resetDb } from "../../support/db";
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
// OVERSTAY-002: entry page shows settle-fee screen and never opens the gate
// ---------------------------------------------------------------------------

test("OVERSTAY-002: overstay driver at entry sees settle-fee screen, gate never opens", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: ACTIVE session with expectedEnd 2h ago — effective overstay, no cron flip
  const { driver, session } = await seedOverstayEffectiveSession(world);

  // Set saved driver + device so /entry can look up the session immediately
  await setSavedDriverAndDevice(page, driver, "device-a");

  // Count gate opens before navigation
  const opensBefore = await countAudit("GATE_OPEN", session.id);

  // Fresh navigation → entry page fires driver-state lookup
  await page.goto("/entry");

  // ── UI contract: overstay settle screen is shown ─────────────────────────
  await expect(
    page.getByRole("link", { name: /settle overstay/i }),
  ).toBeVisible({ timeout: 10_000 });

  // ── Audit contract: no gate open ─────────────────────────────────────────
  // The entry page short-circuits on effective overstay — it never calls open-gate.
  await expect
    .poll(() => countAudit("GATE_OPEN", session.id), { timeout: 5000 })
    .toBe(opensBefore);

  await world.cleanup();
});
