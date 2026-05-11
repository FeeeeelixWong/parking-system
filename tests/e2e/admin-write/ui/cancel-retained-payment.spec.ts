import { expect, test } from "@playwright/test";
import { createWorld } from "../../support/world";
import { resetDb, disconnectDb } from "../../support/db";
import { authenticateAdmin } from "../../support/app-api";
import { seedPaidDailyActiveSession } from "../../support/scenarios/daily";
import {
  expectSessionStatus,
  expectCancellationDisposition,
  expectAuditCount,
} from "../../support/assertions/db";
import { expectNoNeedsReviewCode } from "../../support/assertions/reconcile";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed admin cancellation tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// CANCEL-001: admin cancels a paid daily session and retains payment
// ---------------------------------------------------------------------------

test("CANCEL-001: admin cancels paid daily session, retains payment, disposition is RETAINED_INTENTIONAL", async ({
  page,
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: ACTIVE daily session with $30 completed Stripe charge
  const { session, driver } = await seedPaidDailyActiveSession(world, {
    amount: 30,
    name: `E2E Cancel ${world.testRun.testRunId.slice(4, 12)}`,
  });

  // ── 1. Navigate to admin sessions tab (redirects through login) ─────────
  await page.goto("/admin?tab=sessions");
  await page.getByLabel("Password").fill(
    process.env.ADMIN_PASSWORD ?? "playwright-admin",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin/);
  await page.goto("/admin?tab=sessions");

  // ── 2. Wait for session list and expand the row ─────────────────────────
  await page.getByText(driver.name).first().waitFor({ state: "visible", timeout: 10_000 });
  await page.getByText(driver.name).first().click();

  // ── 3. Open the manage modal ────────────────────────────────────────────
  await page.getByRole("button", { name: "Manage" }).click();

  // ── 4. Choose "Cancel session" from the menu ────────────────────────────
  await page.getByRole("button", { name: "Cancel session" }).click();

  // ── 5. Switch refund choice to "No refund" ──────────────────────────────
  // Default is "Refund unused time" because refundable=$30 and unused>0
  await page.locator("label", { hasText: "No refund" }).click();

  // ── 6. Fill in reason (required when keeping money with no refund) ──────
  await page.getByPlaceholder("Why keep the collected payment?").fill(
    "Driver requested cancellation, explicitly waived refund",
  );

  // ── 7. Confirm cancellation ─────────────────────────────────────────────
  const cancelResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/admin/sessions") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Cancel Session Without Refund" }).click();
  const cancelResponse = await cancelResponsePromise;
  expect(cancelResponse.ok()).toBe(true);
  await expect(cancelResponse.json()).resolves.toMatchObject({
    success: true,
    action: "cancelled",
  });

  // Wait for the modal to close (callCancel has 600ms delay after success)
  await expect(
    page.getByRole("button", { name: "Cancel Session Without Refund" }),
  ).not.toBeVisible({ timeout: 5000 });

  // ── 8. DB assertions ────────────────────────────────────────────────────
  await expectSessionStatus(session.id, "CANCELLED");
  await expectCancellationDisposition(session.id, "RETAINED_INTENTIONAL");
  await expectAuditCount("SPOT_FREED", 1, session.id);

  // ── 9. Needs Review: retained disposition suppresses the warning ─────────
  // The request context is a separate auth context from the page — authenticate independently.
  await authenticateAdmin(request);
  await expectNoNeedsReviewCode(
    request,
    "CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE",
    { sessionId: session.id },
  );

  await world.cleanup();
});
