import { expect, test } from "@playwright/test";
import { createWorld } from "../../support/world";
import { resetDb, disconnectDb } from "../../support/db";
import { authenticateAdmin } from "../../support/app-api";
import { seedPaidMultiDayDailySession } from "../../support/scenarios/daily";
import {
  expectSessionStatus,
  expectAuditCount,
  expectPaymentCount,
} from "../../support/assertions/db";
import { expectNoNeedsReviewCode } from "../../support/assertions/reconcile";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed admin adjustment tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// ADJUST-002: admin shortens daily session, retains payment intentionally
// ---------------------------------------------------------------------------

test("ADJUST-002: admin shortens 2-day session to 1 day, keeps payment, SPOT_FREED logged", async ({
  page,
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: ACTIVE 2-day session with $60 completed Stripe charge.
  // 2 days required — UnitStepper min=1/max=origDays means a 1-day session
  // cannot be shortened via the Adjust UI.
  const { session, driver } = await seedPaidMultiDayDailySession(world, {
    days: 2,
    amount: 60,
    name: `E2E Adjust ${world.testRun.testRunId.slice(4, 12)}`,
  });

  // ── 1. Navigate to admin sessions tab (login required) ───────────────────
  await page.goto("/admin?tab=sessions");
  await page.getByLabel("Password").fill(
    process.env.ADMIN_PASSWORD ?? "playwright-admin",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin/);
  await page.goto("/admin?tab=sessions");

  // ── 2. Wait for session list and expand the row ──────────────────────────
  await page.getByText(driver.name).first().waitFor({ state: "visible", timeout: 10_000 });
  await page.getByText(driver.name).first().click();

  // ── 3. Open the manage modal ─────────────────────────────────────────────
  await page.getByRole("button", { name: "Manage" }).click();

  // ── 4. Choose "Adjust session" from the menu ─────────────────────────────
  await page.getByRole("button", { name: "Adjust session" }).click();

  // ── 5. Click the "−" stepper once: 2 → 1 day ────────────────────────────
  // UnitStepper renders as a button with text "−"
  await page.getByRole("button", { name: "−" }).click();

  // ── 6. Switch refund choice to "No refund" ───────────────────────────────
  // Default after shortening is "Refund unused paid time" ($30).
  // Selecting "No refund" makes the reason textarea required.
  await page.locator("label", { hasText: "No refund" }).click();

  // ── 7. Fill in reason (required: shortening + no refund + unused > $0) ───
  await page
    .getByPlaceholder("Why keep the unused-time payment?")
    .fill("Driver requested early end, waived unused-time refund");

  // ── 8. Confirm the adjustment ────────────────────────────────────────────
  await page.getByRole("button", { name: "Adjust Time Without Refund" }).click();

  // Wait for modal to close (success → 600 ms delay → modal dismissed)
  await expect(
    page.getByRole("button", { name: "Adjust Time Without Refund" }),
  ).not.toBeVisible({ timeout: 5000 });

  // ── 9. DB assertions ─────────────────────────────────────────────────────
  // Session stays ACTIVE (new expectedEnd is in the future — 1 day from startedAt)
  await expectSessionStatus(session.id, "ACTIVE");
  // adjust always logs SPOT_FREED (the spot is conceptually "freed" for the removed days)
  await expectAuditCount("SPOT_FREED", 1, session.id);
  // Payment was NOT deleted or refunded — still one CHECKIN row
  await expectPaymentCount(session.id, "CHECKIN", 1);

  // ── 10. Needs Review: retained payment doesn't introduce a false alarm ────
  // The request context has a separate cookie jar — authenticate independently.
  await authenticateAdmin(request);
  // Adjust with no refund should not introduce CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE
  // (session is ACTIVE, not CANCELLED)
  await expectNoNeedsReviewCode(
    request,
    "CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE",
    { sessionId: session.id },
  );

  await world.cleanup();
});
