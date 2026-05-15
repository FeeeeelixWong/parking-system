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
// UI-REFUND-001: QB_REFUND_RECEIPT_MISSING card has no action button
//
// sync-refunds does not write a QB Refund Receipt, so no action button is
// shown. The admin resolves this manually via QB or by linking a nearby match.
// The card must still show a clear recommendedAction so the admin knows
// what to do.
// ---------------------------------------------------------------------------

test("UI-REFUND-001: QB_REFUND_RECEIPT_MISSING card renders no action button and shows recommendedAction text", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);

  const { payment } = await seedPaidDailyActiveSession(world);
  await seedPaymentRefundWithoutQb({ paymentId: payment.id, amount: 25.0 });

  await page.goto("/admin?tab=reconcile");
  await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD ?? "playwright-admin");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin/);
  await page.goto("/admin?tab=reconcile");

  const refundCard = page
    .locator("article")
    .filter({ hasText: "QuickBooks refund receipt not synced" })
    .first();
  await refundCard.waitFor({ state: "visible", timeout: 12_000 });

  // No button of any kind (enabled or disabled)
  await expect(refundCard.locator("button")).toHaveCount(0);

  // No action link with sync-related label
  await expect(refundCard.locator("a[href]").filter({ hasText: /sync/i })).toHaveCount(0);

  // recommendedAction text instructs the admin on what to do manually
  await expect(
    refundCard.getByText(/write the receipt manually in QuickBooks/i),
  ).toBeVisible();

  await world.cleanup();
});
