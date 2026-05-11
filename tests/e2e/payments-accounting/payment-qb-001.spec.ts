import { expect, test } from "@playwright/test";
import { getE2EEnv } from "../support/env";
import { getE2EStripe } from "../support/stripe/client";
import { createStripeCustomer } from "../support/stripe/customers";
import { createWorld } from "../support/world";
import {
  resetDb,
  seedDriverAndVehicle,
  seedQbSettings,
  findPaymentByStripePaymentIntentId,
} from "../support/db";
import { authenticateAdmin } from "../support/app-api";
import { expectNoNeedsReviewCode } from "../support/assertions/reconcile";
import { ensureQbTokens } from "../support/quickbooks/client";

test.skip(
  !getE2EEnv().stripe,
  "Set E2E_STRIPE_SECRET_KEY and E2E_STRIPE_PUBLISHABLE_KEY to run Stripe integration tests.",
);

// ---------------------------------------------------------------------------
// PAYMENT-QB-001
// End-to-end: real checkout.session.completed webhook → DB Payment + QB receipt
//
// Strategy:
//   In Stripe API 2025-09-30.clover, checkout session PaymentIntents are created
//   lazily (when the customer opens the hosted URL) so we cannot get the PI ID
//   from the session object directly. Instead we:
//     1. Create + confirm a real PaymentIntent directly (so the Stripe charge exists)
//     2. Build a synthetic checkout.session.completed event referencing the real PI ID
//     3. POST the signed event to /api/stripe/webhook
//   This is the standard pattern for webhook integration tests — the handler only
//   needs real Stripe resource IDs it can re-fetch, not a real Checkout Session URL.
//
// Assertions (field agreement, not just existence):
//   - DB stripePaymentIntentId == real Stripe PI ID
//   - DB stripeChargeId       == real Stripe Charge ID (retrieved from confirmed PI)
//   - DB payment.amount       == AMOUNT_CENTS / 100
//   - QB SalesReceipt.TotalAmt == DB payment.amount
//   - Needs Review: no DB_PAYMENT_WITHOUT_STRIPE_CHARGE, no QB_RECEIPT_MISSING
//
// Cleanup:
//   - Stripe Customer tagged with testRunId → deleted by world.cleanup()
//   - QB SalesReceipt stays as a sandbox artifact (QB sandbox has no bulk delete)
//   - DB reset by resetDb() at test start; test-run scoped email in Driver row
// ---------------------------------------------------------------------------

test("PAYMENT-QB-001: checkout.session.completed → DB Payment + QB Sales Receipt", async (
  { request },
  testInfo,
) => {
  const world = createWorld(testInfo);
  const stripe = getE2EStripe();
  const env = getE2EEnv();
  const baseUrl = env.baseUrl;
  const qbTokens = await ensureQbTokens();
  const qbUsable = qbTokens != null;

  try {
    await resetDb();

    // Seed QB OAuth tokens into DB Settings so writeSalesReceiptSafe can connect
    // during the webhook. tokenExpiresAt=null skips the refresh-token check so
    // the app uses the access token as-is without attempting a refresh.
    if (qbTokens) {
      await seedQbSettings({
        realmId: qbTokens.realmId,
        accessToken: qbTokens.accessToken,
        refreshToken: qbTokens.refreshToken,
        tokenExpiresAt: null,
      });
    }

    // Seed Driver + Vehicle only — the webhook handler creates the Session.
    // Use a QB-safe name: QB DisplayName rejects em dashes and colons, which
    // driverName() would include from the test title.
    const { driver, vehicle } = await seedDriverAndVehicle({
      testRun: world.testRun,
      name: `E2E QB001 ${world.testRun.testRunId.slice(3, 11)}`,
    });

    // Create a Stripe test-mode Customer so the PI has a real customer reference
    const customer = await createStripeCustomer({
      testRunId: world.testRun.testRunId,
      name: driver.name,
      email: driver.email ?? `e2e+${world.testRun.testRunId}@example.test`,
    });

    // ── Create and confirm a real Stripe PaymentIntent ─────────────────────────
    // In Stripe 2025-09-30.clover, Checkout Session PaymentIntents are created
    // lazily (only when the customer opens the hosted URL). We bypass that by
    // creating the PI directly so the real charge exists in Stripe — the webhook
    // handler will call stripe.paymentIntents.retrieve(piId) to get the chargeId.
    const AMOUNT_CENTS = 3000; // $30.00

    const pi = await stripe.paymentIntents.create({
      amount: AMOUNT_CENTS,
      currency: "usd",
      customer: customer.id,
      metadata: { testRunId: world.testRun.testRunId },
    });

    const confirmedPi = await stripe.paymentIntents.confirm(pi.id, {
      payment_method: "pm_card_visa",
      return_url: `${baseUrl}/confirmation`,
    });

    // Capture the exact Charge ID to compare against DB later
    const stripeChargeId = typeof confirmedPi.latest_charge === "string"
      ? confirmedPi.latest_charge
      : (confirmedPi.latest_charge as { id: string } | null)?.id ?? null;
    expect(stripeChargeId, "PaymentIntent must have a Charge after confirmation").toBeTruthy();

    // ── Build a synthetic checkout.session.completed event ─────────────────────
    // The handler reads: session.mode, session.payment_intent, session.metadata,
    // session.amount_total, session.id (stored as stripeCheckoutSessionId).
    // A fake CS ID is fine — the real PI ID is what matters for Stripe re-fetches.
    const fakeCsId = `cs_test_${world.testRun.testRunId.replace(/-/g, "_")}`;
    const eventId  = `evt_test_${world.testRun.testRunId.replace(/-/g, "_")}`;

    const syntheticCs = {
      id: fakeCsId,
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      payment_intent: pi.id,      // real Stripe PI ID — handler re-fetches this
      amount_total: AMOUNT_CENTS,
      currency: "usd",
      customer: customer.id,
      // processCheckoutSession required fields for CHECKIN:
      //   sessionPurpose, driverId, vehicleId, days, termsVersion
      // Optional (used in description / session create):
      //   vehicleType, licensePlate, overstayAuthorized
      metadata: {
        sessionPurpose: "CHECKIN",
        driverId: driver.id,
        vehicleId: vehicle.id,
        days: "1",
        termsVersion: "1.0",
        vehicleType: "TRUCK_TRAILER",
        licensePlate: vehicle.licensePlate ?? "",
        overstayAuthorized: "true",
      },
    };

    const eventPayload = JSON.stringify({
      id: eventId,
      object: "event",
      api_version: "2025-09-30.clover",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: "checkout.session.completed",
      data: { object: syntheticCs },
    });

    // Sign the payload. The app verifies with STRIPE_WEBHOOK_SECRET which
    // playwright.config.ts maps from E2E_STRIPE_WEBHOOK_SECRET.
    const webhookSecret = env.stripe!.webhookSecret;
    expect(webhookSecret, "E2E_STRIPE_WEBHOOK_SECRET must be set for PAYMENT-QB-001").toBeTruthy();

    const stripeSignature = stripe.webhooks.generateTestHeaderString({
      payload: eventPayload,
      secret: webhookSecret!,
    });

    // POST the raw JSON bytes. The body must be byte-identical to the signed payload.
    const webhookRes = await request.post(`${baseUrl}/api/stripe/webhook`, {
      data: eventPayload,
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": stripeSignature,
      },
    });

    expect(
      webhookRes.status(),
      `Webhook returned ${webhookRes.status()}: ${await webhookRes.text()}`,
    ).toBe(200);
    const webhookBody = await webhookRes.json() as { received?: boolean };
    expect(webhookBody.received).toBe(true);

    // ── DB assertions — field agreement, not just existence ────────────────────

    const payment = await findPaymentByStripePaymentIntentId(pi.id);
    expect(payment, "Payment row must exist after webhook").not.toBeNull();

    expect(payment!.stripePaymentIntentId).toBe(pi.id);        // exact PI ID match
    expect(payment!.stripeChargeId).toBe(stripeChargeId);      // exact Charge ID match
    expect(payment!.amount).toBeCloseTo(AMOUNT_CENTS / 100, 2); // $30.00

    // ── QB assertions (only when QB is configured) ─────────────────────────────

    if (world.qb && qbUsable) {
      expect(
        payment!.qbSalesReceiptId,
        "QB Sales Receipt ID must be written to the Payment row when QB is configured",
      ).not.toBeNull();

      // Fetch the QB sandbox Sales Receipt and assert TotalAmt matches DB amount
      type QbSalesReceiptResponse = { SalesReceipt: { Id: string; TotalAmt: number } };
      const receiptData = await world.qb.fetch<QbSalesReceiptResponse>(
        `/salesreceipt/${payment!.qbSalesReceiptId}?minorversion=65`,
      );
      // Both QB TotalAmt and payment.amount are in dollars — compare directly
      expect(receiptData.SalesReceipt.TotalAmt).toBeCloseTo(payment!.amount, 2);
    }

    // ── Needs Review — no drift codes for the session ──────────────────────────

    const sessionId = payment!.sessionId;
    await authenticateAdmin(request);

    // Webhook stored stripeChargeId → no "no Stripe charge" drift for this session
    await expectNoNeedsReviewCode(request, "DB_PAYMENT_WITHOUT_STRIPE_CHARGE", { sessionId });

    // QB receipt was written (or QB is unconfigured) → no "QB receipt missing" drift
    if (world.qb && qbUsable) {
      await expectNoNeedsReviewCode(request, "QB_RECEIPT_MISSING", { sessionId });
    }
  } finally {
    // Stripe customers tagged with testRunId are deleted by world.cleanup().
    // QB SalesReceipts remain as sandbox artifacts (QB sandbox has no bulk delete).
    await world.cleanup();
  }
});
