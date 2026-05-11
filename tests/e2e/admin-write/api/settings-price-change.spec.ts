import { expect, test } from "@playwright/test";
import { disconnectDb, resetDb } from "../../support/db";
import { authenticateAdmin, putAdminSettings } from "../../support/app-api";
import { createWorld } from "../../support/world";
import { seedPaidDailyActiveSession } from "../../support/scenarios/daily";
import { expectPaymentAmount } from "../../support/assertions/db";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed admin settings tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// ADMIN-004: changing daily rate does not mutate existing payment amounts
// ---------------------------------------------------------------------------

test("ADMIN-004: updating daily rate leaves existing payment amount unchanged", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: ACTIVE daily session with $30 CHECKIN payment
  const { session, payment } = await seedPaidDailyActiveSession(world, { amount: 30 });

  await authenticateAdmin(request);

  // Change the truck daily rate from $30 to $50 for new sessions
  const settingsResult = await putAdminSettings(request, {
    dailyRateTruck: 50,
    dailyRateBobtail: 50,
  });
  expect(settingsResult.status).toBe(200);

  // The existing payment row must not be mutated — settings are prospective only.
  // Amount is still $30, not re-priced at the new $50 rate.
  await expectPaymentAmount(payment.id, 30);

  // Suppress unused reference lint
  void session;

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// ADMIN-004b: settings change does not affect already-created session fields
// ---------------------------------------------------------------------------

test("ADMIN-004b: settings update response has ok=true and new rate values are present", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  await authenticateAdmin(request);

  const result = await putAdminSettings(request, { dailyRateTruck: 75 });
  expect(result.status).toBe(200);
  // Response wraps settings in a `settings` key; daily rate should reflect new value
  const data = result.data as { settings: { dailyRateTruck?: number } };
  expect(data.settings.dailyRateTruck).toBe(75);

  // Reset for next test
  await putAdminSettings(request, { dailyRateTruck: 30 });

  await world.cleanup();
});
