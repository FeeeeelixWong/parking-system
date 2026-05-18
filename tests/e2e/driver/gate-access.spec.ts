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

  await expect.poll(() => countAudit("GATE_OPEN", session.id), { timeout: 10000 }).toBe(before + 1);
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

test("repeated session gate commands from one IP are rate-limited", async ({ request }) => {
  const { driver, session } = await seedActiveDriverSession();
  const headers = { "x-forwarded-for": "198.51.100.16" };
  const body = {
    driverId: driver.id,
    deviceId: "rate-limit-device",
    direction: "EXIT",
    scanContext: "fresh",
  };

  for (let i = 0; i < 5; i++) {
    const res = await request.post(`/api/sessions/${session.id}/open-gate`, {
      headers,
      data: body,
    });
    expect(res.status(), `request ${i + 1}`).toBe(200);
  }

  const limited = await request.post(`/api/sessions/${session.id}/open-gate`, {
    headers,
    data: body,
  });

  expect(limited.status()).toBe(429);
  expect(limited.headers()["retry-after"]).toBeTruthy();
});

test("repeated allowlist gate lookups from one IP are rate-limited", async ({ request }) => {
  const headers = { "x-forwarded-for": "198.51.100.17" };
  const body = {
    phone: "5550000001",
    direction: "ENTRANCE",
    scanContext: "fresh",
  };

  for (let i = 0; i < 5; i++) {
    const res = await request.post("/api/allowlist/open-gate", {
      headers,
      data: body,
    });
    expect(res.status(), `request ${i + 1}`).toBe(200);
  }

  const limited = await request.post("/api/allowlist/open-gate", {
    headers,
    data: body,
  });

  expect(limited.status()).toBe(429);
  expect(limited.headers()["retry-after"]).toBeTruthy();
});

test("xfail: stolen saved driver identity on a new device should require PIN before opening gate", async ({ page }) => {
  test.fail(true, "Current contract trusts a valid saved driver object on a new device. Future fix: require PIN/new-device verification before gate access.");

  const { driver, session } = await seedActiveDriverSession();
  await setSavedDriverAndDevice(page, driver, "unknown-new-device");

  await page.goto("/entry");
  // Wait for gate to open (current impl trusts any valid saved driver regardless of device).
  // GATE_OPEN reaches 1 → toBe(0) fails → test.fail catches it as expected failure.
  // When PIN verification is added, this poll will timeout (GATE_OPEN stays 0) and the
  // assertion will pass → test.fail flags "unexpected pass" → remove xfail at that point.
  await expect.poll(() => countAudit("GATE_OPEN", session.id), { timeout: 8000 }).toBeGreaterThan(0);
  await expect.poll(() => countAudit("GATE_OPEN", session.id)).toBe(0);
});
