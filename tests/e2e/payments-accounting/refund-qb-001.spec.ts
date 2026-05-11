import { expect, test } from "@playwright/test";
import { getE2EEnv } from "../support/env";
import { getE2EStripe } from "../support/stripe/client";
import { createStripeCustomer, TEST_PAYMENT_METHODS } from "../support/stripe/customers";
import { createWorld } from "../support/world";
import {
  resetDb,
  seedDriverAndVehicle,
  seedQbSettings,
  findPaymentByStripePaymentIntentId,
  findPaymentRefundByStripeRefundId,
} from "../support/db";
import { authenticateAdmin } from "../support/app-api";
import { expectNoNeedsReviewCode } from "../support/assertions/reconcile";
import { ensureQbTokens } from "../support/quickbooks/client";

test.skip(
  !getE2EEnv().stripe,
  "Set E2E_STRIPE_SECRET_KEY and E2E_STRIPE_PUBLISHABLE_KEY to run Stripe integration tests.",
);

// Full refund in cents — $30.00
const AMOUNT_CENTS = 3000;

test(
  "REFUND-QB-001: Stripe refund webhook writes PaymentRefund and QB RefundReceipt",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    const stripe = getE2EStripe();
    const env = getE2EEnv();
    const baseUrl = env.baseUrl;
    const qbTokens = await ensureQbTokens();
    const qbUsable = qbTokens != null;

    try {
      await resetDb();

      // tokenExpiresAt=null → app uses token as-is, skipping refresh
      if (qbTokens) {
        await seedQbSettings({
          realmId: qbTokens.realmId,
          accessToken: qbTokens.accessToken,
          refreshToken: qbTokens.refreshToken,
          tokenExpiresAt: null,
        });
      }

      // QB-safe name: printable ASCII only, no Unicode that would break QB fields
      const { driver, vehicle } = await seedDriverAndVehicle({
        testRun: world.testRun,
        name: `E2E RQ001 ${world.testRun.testRunId.slice(3, 11)}`,
      });

      // --- STEP 1: Create and confirm a real Stripe PaymentIntent ---
      // Stripe 2025-09-30.clover creates PaymentIntents lazily for Checkout Sessions.
      // We must create a real PI directly to get a real charge ID for the refund.
      const customer = await createStripeCustomer({
        testRunId: world.testRun.testRunId,
        name: driver.name,
        email: driver.email!,
      });

      const pi = await stripe.paymentIntents.create({
        amount: AMOUNT_CENTS,
        currency: "usd",
        customer: customer.id,
        payment_method: TEST_PAYMENT_METHODS.VISA,
        confirm: true,
        return_url: `${baseUrl}/checkin`,
      });

      // Retrieve the confirmed PI to get the real charge ID
      const confirmedPi = await stripe.paymentIntents.retrieve(pi.id);
      const stripeChargeId = typeof confirmedPi.latest_charge === "string"
        ? confirmedPi.latest_charge
        : confirmedPi.latest_charge?.id ?? null;

      expect(stripeChargeId, "PaymentIntent must produce a real charge ID after confirmation").not.toBeNull();

      // --- STEP 2: Send synthetic checkout.session.completed to create DB records ---
      const fakeCsId = `cs_test_co_${world.testRun.testRunId.replace(/-/g, "_")}`;
      const checkoutEventId = `evt_test_co_${world.testRun.testRunId.replace(/-/g, "_")}`;

      const syntheticCs = {
        id: fakeCsId,
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        payment_intent: pi.id,
        amount_total: AMOUNT_CENTS,
        currency: "usd",
        metadata: {
          sessionPurpose: "CHECKIN",
          driverId: driver.id,
          vehicleId: vehicle.id,
          days: "1",
          termsVersion: "1.0",
          vehicleType: "TRUCK_TRAILER",
          licensePlate: null,
          overstayAuthorized: "true",
        },
      };

      const checkoutEventPayload = JSON.stringify({
        id: checkoutEventId,
        object: "event",
        api_version: "2025-09-30.clover",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 0,
        type: "checkout.session.completed",
        data: { object: syntheticCs },
      });

      const webhookSecret = env.stripe!.webhookSecret;
      const checkoutSignature = stripe.webhooks.generateTestHeaderString({
        payload: checkoutEventPayload,
        secret: webhookSecret!,
      });

      const checkoutRes = await request.post(`${baseUrl}/api/stripe/webhook`, {
        data: checkoutEventPayload,
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": checkoutSignature,
        },
      });
      expect(checkoutRes.status(), "checkout.session.completed webhook must return 200").toBe(200);

      // Wait for the Payment row to be created
      let payment = await findPaymentByStripePaymentIntentId(pi.id);
      for (let i = 0; i < 10 && !payment; i++) {
        await new Promise((r) => setTimeout(r, 300));
        payment = await findPaymentByStripePaymentIntentId(pi.id);
      }

      expect(payment, "Payment row must be created after checkout.session.completed").not.toBeNull();
      expect(payment!.status, "Initial payment status must be COMPLETED").toBe("COMPLETED");

      if (world.qb && qbUsable) {
        expect(
          payment!.qbSalesReceiptId,
          "QB Sales Receipt ID must be written to Payment before issuing refund",
        ).not.toBeNull();
      }

      // --- STEP 3: Issue a real Stripe refund ---
      const refund = await stripe.refunds.create({
        charge: stripeChargeId!,
        reason: "requested_by_customer",
      });

      expect(refund.id, "Stripe must return a refund ID").toBeTruthy();
      expect(refund.status, "Refund must be succeeded immediately for test cards").toBe("succeeded");

      // Retrieve the charge AFTER the refund with refunds expanded — processChargeRefund
      // reads directly from the charge object passed in the event, not from Stripe.
      const chargeAfterRefund = await stripe.charges.retrieve(stripeChargeId!, {
        expand: ["refunds"],
      });

      expect(
        (chargeAfterRefund.refunds?.data?.length ?? 0) > 0,
        "Charge must have at least one refund after stripe.refunds.create",
      ).toBe(true);

      // --- STEP 4: Send synthetic charge.refunded to trigger PaymentRefund + QB write ---
      // Use a DIFFERENT event ID from the checkout event to avoid StripeEvent dedup collision.
      const refundEventId = `evt_test_rf_${world.testRun.testRunId.replace(/-/g, "_")}`;

      const refundEventPayload = JSON.stringify({
        id: refundEventId,
        object: "event",
        api_version: "2025-09-30.clover",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 0,
        type: "charge.refunded",
        data: { object: chargeAfterRefund },
      });

      const refundSignature = stripe.webhooks.generateTestHeaderString({
        payload: refundEventPayload,
        secret: webhookSecret!,
      });

      const refundWebhookRes = await request.post(`${baseUrl}/api/stripe/webhook`, {
        data: refundEventPayload,
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": refundSignature,
        },
      });
      expect(refundWebhookRes.status(), "charge.refunded webhook must return 200").toBe(200);

      // --- STEP 5: Assert PaymentRefund row was created ---
      let paymentRefund = await findPaymentRefundByStripeRefundId(refund.id);
      for (let i = 0; i < 10 && !paymentRefund; i++) {
        await new Promise((r) => setTimeout(r, 300));
        paymentRefund = await findPaymentRefundByStripeRefundId(refund.id);
      }

      expect(paymentRefund, "PaymentRefund row must be created after charge.refunded").not.toBeNull();
      expect(paymentRefund!.paymentId, "PaymentRefund must be linked to the Payment row").toBe(payment!.id);
      expect(paymentRefund!.amount, "PaymentRefund amount must match refund amount in dollars").toBeCloseTo(
        AMOUNT_CENTS / 100,
        2,
      );
      expect(paymentRefund!.stripeRefundId, "PaymentRefund must store the Stripe refund ID").toBe(refund.id);

      // --- STEP 6: Assert Payment status updated to REFUNDED ---
      const paymentAfterRefund = await findPaymentByStripePaymentIntentId(pi.id);
      expect(paymentAfterRefund!.status, "Payment status must be REFUNDED after full refund").toBe("REFUNDED");
      expect(
        paymentAfterRefund!.refundedAmount,
        "Payment.refundedAmount must reflect total refunded amount",
      ).toBeCloseTo(AMOUNT_CENTS / 100, 2);

      // --- STEP 7: QB RefundReceipt assertions ---
      if (world.qb && qbUsable) {
        expect(
          paymentRefund!.qbRefundReceiptId,
          "QB RefundReceipt ID must be written to PaymentRefund when QB is configured",
        ).not.toBeNull();

        type QbRefundReceiptResponse = { RefundReceipt: { Id: string; TotalAmt: number } };
        const receiptData = await world.qb.fetch<QbRefundReceiptResponse>(
          `/refundreceipt/${paymentRefund!.qbRefundReceiptId}?minorversion=65`,
        );
        expect(
          receiptData.RefundReceipt.TotalAmt,
          "QB RefundReceipt TotalAmt must match the refund amount",
        ).toBeCloseTo(AMOUNT_CENTS / 100, 2);
      }

      // --- STEP 8: Needs Review must be clean for this payment ---
      const paymentId = payment!.id;
      await authenticateAdmin(request);
      if (qbUsable) {
        await expectNoNeedsReviewCode(request, "QB_REFUND_RECEIPT_MISSING", { paymentId });
        await expectNoNeedsReviewCode(request, "QB_REFUND_AMOUNT_MISMATCH", { paymentId });
      }
    } finally {
      // Stripe customers tagged with testRunId are deleted by world.cleanup().
      // QB RefundReceipts remain as sandbox artifacts (QB sandbox has no bulk delete).
      await world.cleanup();
    }
  },
);
