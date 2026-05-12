import { expect, test } from "@playwright/test";
import { createWorld } from "../../support/world";
import { resetDb, disconnectDb, seedPaymentRefundWithoutQb } from "../../support/db";
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
// Shared setup: seed a payment with a refund row that has no QB receipt.
// Triggers QB_REFUND_RECEIPT_MISSING in the Needs Review route.
// Mock sync-refunds so QB credentials are not needed in CI.
// ---------------------------------------------------------------------------

async function setupRefundSeed(world: ReturnType<typeof createWorld>) {
  const { payment } = await seedPaidDailyActiveSession(world);
  await seedPaymentRefundWithoutQb({ paymentId: payment.id, amount: 25.0 });
  return { payment };
}

async function mockSyncRefunds(
  page: import("@playwright/test").Page,
  paymentId: string,
  response = { ok: true, refundedAmount: 25.0, status: "REFUNDED" },
) {
  await page.route(`**/api/admin/payments/${paymentId}/sync-refunds`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
}

async function loginAndGoToNeedsReview(page: import("@playwright/test").Page) {
  await page.goto("/admin?tab=reconcile");
  await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD ?? "playwright-admin");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin/);
  await page.goto("/admin?tab=reconcile");
}

// ---------------------------------------------------------------------------
// UI-REFUND-001: widget appears with confirmed Stripe + DB steps after sync
// ---------------------------------------------------------------------------

test("UI-REFUND-001: sync-refunds widget shows Stripe and DB steps as confirmed", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);
  const { payment } = await setupRefundSeed(world);
  await mockSyncRefunds(page, payment.id);
  await loginAndGoToNeedsReview(page);

  // Click the sync button for the QB_REFUND_RECEIPT_MISSING item
  const syncButton = page.getByRole("button", { name: "Sync refund receipt" }).first();
  await syncButton.waitFor({ state: "visible", timeout: 12_000 });
  await syncButton.click();

  // Widget title appears — scope all assertions inside it
  const widget = page.getByRole("status");
  await expect(widget).toBeVisible({ timeout: 5_000 });
  await expect(widget.getByText("Refund sync checked")).toBeVisible();

  // Stripe step confirmed
  await expect(widget.getByText("Stripe charge checked")).toBeVisible();

  // DB step confirmed with refunded amount and status
  await expect(widget.getByText("DB refund state updated")).toBeVisible();
  await expect(widget.getByText(/Refunded.*\$25\.00/)).toBeVisible();
  await expect(widget.getByText(/Status: REFUNDED/)).toBeVisible();

  // Payment ID rendered as monospace <code>, not a link
  const paymentIdPrefix = payment.id.slice(0, 8);
  await expect(widget.locator("code").filter({ hasText: paymentIdPrefix })).toBeVisible();
  await expect(widget.locator("a").filter({ hasText: paymentIdPrefix })).toHaveCount(0);

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// UI-REFUND-002: QB step shows warning and Next footer points to Needs Review
// ---------------------------------------------------------------------------

test("UI-REFUND-002: sync-refunds widget shows QB warning step and Open Needs Review footer", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);
  const { payment } = await setupRefundSeed(world);
  await mockSyncRefunds(page, payment.id);
  await loginAndGoToNeedsReview(page);

  const syncButton = page.getByRole("button", { name: "Sync refund receipt" }).first();
  await syncButton.waitFor({ state: "visible", timeout: 12_000 });
  await syncButton.click();

  const widget = page.getByRole("status");
  await expect(widget).toBeVisible({ timeout: 5_000 });

  // QB refund receipt step is present (warning)
  await expect(widget.getByText("QuickBooks refund receipt")).toBeVisible();
  await expect(widget.getByText("Not confirmed — sync did not prove QB receipt")).toBeVisible();

  // Needs Review follow-up step is shown
  await expect(widget.getByText("Needs Review follow-up")).toBeVisible();

  // Next footer points admin to Needs Review
  await expect(
    widget.getByText("Open Needs Review to track until QuickBooks catches up."),
  ).toBeVisible();

  await world.cleanup();
});
