import { expect, test } from "@playwright/test";
import { createWorld } from "../../support/world";
import { resetDb, disconnectDb } from "../../support/db";
import { seedPaidDailyActiveSession } from "../../support/scenarios/daily";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed admin UI tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// UI-SYNC-001: Sync receipt widget appears after successful sync
//
// - QB receipt ID rendered as an external link (href provided)
// - DB payment ID rendered as plain monospace <code> (no href → no fake link)
// ---------------------------------------------------------------------------

test("UI-SYNC-001: sync receipt widget shows QB receipt as link, payment ID as monospace", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);

  const { payment } = await seedPaidDailyActiveSession(world);

  const fakeQbReceiptId = "WIDGET-TEST-QB-123";

  // Intercept sync-receipt POST — avoids needing real QB credentials in CI
  await page.route(`**/api/admin/payments/${payment.id}/sync-receipt`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, qbSalesReceiptId: fakeQbReceiptId }),
    });
  });

  // ── 1. Log in and navigate to Needs Review tab ───────────────────────────
  await page.goto("/admin?tab=reconcile");
  await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD ?? "playwright-admin");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin/);
  await page.goto("/admin?tab=reconcile");

  // ── 2. Click Sync on the QB_RECEIPT_MISSING item ─────────────────────────
  const syncButton = page.getByRole("button", { name: "Sync" }).first();
  await syncButton.waitFor({ state: "visible", timeout: 12_000 });
  await syncButton.click();

  // ── 3. Widget header appears ─────────────────────────────────────────────
  await expect(page.getByText("QuickBooks receipt synced")).toBeVisible({ timeout: 5_000 });

  // ── 4. QB receipt ID is rendered as a link (href provided by caller) ──────
  const qbLink = page.getByRole("link", { name: new RegExp(fakeQbReceiptId) });
  await expect(qbLink).toBeVisible();
  await expect(qbLink).toHaveAttribute("target", "_blank");
  await expect(qbLink).toHaveAttribute("rel", /noreferrer/);

  // ── 5. Payment ID rendered as monospace <code>, NOT as a link ────────────
  const paymentIdPrefix = payment.id.slice(0, 8);
  await expect(page.locator(`code`).filter({ hasText: paymentIdPrefix })).toBeVisible();
  await expect(page.locator(`a`).filter({ hasText: paymentIdPrefix })).toHaveCount(0);

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// UI-SYNC-002: alreadySynced path shows "Already linked" detail, no Stripe row
// ---------------------------------------------------------------------------

test("UI-SYNC-002: alreadySynced response omits Stripe step and shows already-linked detail", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);

  const { payment } = await seedPaidDailyActiveSession(world);

  const fakeQbReceiptId = "WIDGET-ALREADY-QB-456";

  await page.route(`**/api/admin/payments/${payment.id}/sync-receipt`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, qbSalesReceiptId: fakeQbReceiptId, alreadySynced: true }),
    });
  });

  await page.goto("/admin?tab=reconcile");
  await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD ?? "playwright-admin");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin/);
  await page.goto("/admin?tab=reconcile");

  const syncButton = page.getByRole("button", { name: "Sync" }).first();
  await syncButton.waitFor({ state: "visible", timeout: 12_000 });
  await syncButton.click();

  await expect(page.getByText("QuickBooks receipt synced")).toBeVisible({ timeout: 5_000 });

  // "Already linked" step detail shown
  await expect(page.getByText("Already linked — no new write")).toBeVisible();

  // Stripe step is omitted — "Stripe charge resolved" must not appear
  await expect(page.getByText("Stripe charge resolved")).toHaveCount(0);

  // Audit step is omitted — "Audit log written" must not appear
  await expect(page.getByText("Audit log written")).toHaveCount(0);

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// UI-SYNC-003: Sync button posts to the server-authored actionPath
//
// Proves the UI reads actionPath from the API response rather than deriving
// it client-side from item.code. Also confirms sync-refunds is never called
// for a QB_RECEIPT_MISSING item (that was the old wrong path).
// ---------------------------------------------------------------------------

test("UI-SYNC-003: sync button posts to server-authored actionPath and not sync-refunds", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);

  const { payment } = await seedPaidDailyActiveSession(world);

  let syncReceiptCalled = false;
  let syncRefundsCalled = false;

  await page.route(`**/api/admin/payments/${payment.id}/sync-receipt`, async (route) => {
    syncReceiptCalled = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, qbSalesReceiptId: "QB-SYNC-003-TEST" }),
    });
  });

  await page.route(`**/api/admin/payments/${payment.id}/sync-refunds`, async (route) => {
    syncRefundsCalled = true;
    await route.abort();
  });

  await page.goto("/admin?tab=reconcile");
  await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD ?? "playwright-admin");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin/);
  await page.goto("/admin?tab=reconcile");

  const syncButton = page.getByRole("button", { name: "Sync" }).first();
  await syncButton.waitFor({ state: "visible", timeout: 12_000 });
  await syncButton.click();

  await expect(page.getByText("QuickBooks receipt synced")).toBeVisible({ timeout: 5_000 });

  expect(syncReceiptCalled, "UI must POST to server-authored actionPath (sync-receipt)").toBe(true);
  expect(syncRefundsCalled, "UI must not POST to sync-refunds for QB_RECEIPT_MISSING").toBe(false);

  await world.cleanup();
});
