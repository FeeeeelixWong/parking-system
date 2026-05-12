import { expect, test } from "@playwright/test";
import { createWorld } from "../../support/world";
import { resetDb, disconnectDb, seedMonthlyActiveSession, setSessionBillingPaymentFailed, setPaymentHostedInvoiceUrl } from "../../support/db";
import { seedOrphanedPaymentSession } from "../../support/scenarios/reconcile";

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
// UI-NR-001: Needs Review item with actionHref renders an action link
// UI-NR-002: Needs Review item without actionHref does not render a dead button
// ---------------------------------------------------------------------------

test("UI-NR-001/002: actionHref renders a link; no-actionHref item renders nothing", async ({
  page,
}, testInfo) => {
  const world = createWorld(testInfo);

  // ── Scenario A: SUBSCRIPTION_PAYMENT_FAILED with hostedInvoiceUrl ─────────
  // Seed monthly session, set billingStatus=PAYMENT_FAILED, attach a fake
  // invoice URL to the anchor payment row. The Needs Review endpoint will
  // return a SUBSCRIPTION_PAYMENT_FAILED item with actionHref set.
  const { session: monthlySession, payment: checkinPayment } = await seedMonthlyActiveSession({
    testRun: world.testRun,
    phone: world.testRun.driverPhone(0),
  });
  await setSessionBillingPaymentFailed(monthlySession.id);
  const fakeInvoiceUrl = `https://invoice.stripe.com/i/test_ui_nr_${world.testRun.testRunId}`;
  await setPaymentHostedInvoiceUrl(checkinPayment.id, fakeInvoiceUrl);

  // ── Scenario B: DB_PAYMENT_WITHOUT_STRIPE_CHARGE (no actionHref) ─────────
  // An orphaned payment produces "Payment missing Stripe charge", which has
  // actionLabel but no actionHref. It must not render a dead disabled button.
  await seedOrphanedPaymentSession(world, { amount: 30, phone: world.testRun.driverPhone(1) });

  // ── Navigate and log in ───────────────────────────────────────────────────
  await page.goto("/admin?tab=reconcile");
  await page.getByLabel("Password").fill(
    process.env.ADMIN_PASSWORD ?? "playwright-admin",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin/);
  // Re-navigate after login to land on the reconcile tab
  await page.goto("/admin?tab=reconcile");

  // ── Assert A: "Open invoice ↗" link is rendered with the correct href ─────
  const invoiceLink = page.getByRole("link", { name: "Open invoice ↗" }).first();
  await invoiceLink.waitFor({ state: "visible", timeout: 10_000 });
  await expect(invoiceLink).toHaveAttribute("href", fakeInvoiceUrl);
  await expect(invoiceLink).toHaveAttribute("target", "_blank");
  await expect(invoiceLink).toHaveAttribute("rel", /noreferrer/);

  // ── Assert B: "Payment missing Stripe charge" item has no dead button ─────
  const chargeCard = page
    .locator("article")
    .filter({ hasText: "Payment missing Stripe charge" })
    .first();
  await chargeCard.waitFor({ state: "visible", timeout: 10_000 });
  await expect(chargeCard.locator("button[disabled]")).toHaveCount(0);
  await expect(chargeCard.locator("a[href]")).toHaveCount(0);

  await world.cleanup();
});
