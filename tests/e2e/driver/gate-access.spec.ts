import { expect, test } from "@playwright/test";
import {
  countAudit,
  disconnectDb,
  resetDb,
  seedActiveDriverSession,
} from "../support/db";
import { setSavedDriverAndDevice } from "../support/driver-ui";

test.skip(!process.env.TEST_DATABASE_URL, "Set TEST_DATABASE_URL to run DB-backed driver e2e tests.");

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

test("fresh entry scan for saved active driver opens the gate once", async ({ page }) => {
  const { driver, session } = await seedActiveDriverSession();
  await setSavedDriverAndDevice(page, driver, "device-a");

  const before = await countAudit("GATE_OPEN", session.id);
  await page.goto("/entry");

  await expect.poll(() => countAudit("GATE_OPEN", session.id)).toBe(before + 1);
  await expect.poll(() => countAudit("GATE_DENIED", session.id)).toBe(0);
});

test("refresh after a fresh entry scan does not open the gate again", async ({ page }) => {
  const { driver, session } = await seedActiveDriverSession();
  await setSavedDriverAndDevice(page, driver, "device-a");

  await page.goto("/entry");
  await expect.poll(() => countAudit("GATE_OPEN", session.id)).toBe(1);

  await page.reload();

  await expect(page.getByText(/Please re-scan the QR code at the gate/i)).toBeVisible();
  await expect.poll(() => countAudit("GATE_OPEN", session.id)).toBe(1);
});

test("second device using same saved session is marked suspicious and does not open gate", async ({ browser }) => {
  const { driver, session } = await seedActiveDriverSession();

  const first = await browser.newPage();
  await setSavedDriverAndDevice(first, driver, "device-a");
  await first.goto("/entry");
  await expect.poll(() => countAudit("GATE_OPEN", session.id)).toBe(1);
  await first.close();

  const second = await browser.newPage();
  await setSavedDriverAndDevice(second, driver, "device-b");
  await second.goto("/entry");

  await expect.poll(() => countAudit("GATE_OPEN", session.id)).toBe(1);
  await expect.poll(() => countAudit("SUSPICIOUS_ENTRY", session.id)).toBe(1);
  await second.close();
});

test("xfail: stolen saved driver identity on a new device should require PIN before opening gate", async ({ page }) => {
  test.fail(true, "Current contract trusts a valid saved driver object on a new device. Future fix: require PIN/new-device verification before gate access.");

  const { driver, session } = await seedActiveDriverSession();
  await setSavedDriverAndDevice(page, driver, "unknown-new-device");

  await page.goto("/entry");

  await expect.poll(() => countAudit("GATE_OPEN", session.id)).toBe(0);
});
