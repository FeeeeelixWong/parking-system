import { expect, test } from "@playwright/test";
import { getE2EEnv } from "../support/env";
import { getE2EStripe } from "../support/stripe/client";
import { createStripeCustomer, attachTestPaymentMethod, TEST_PAYMENT_METHODS } from "../support/stripe/customers";
import { createWorld } from "../support/world";
import {
  resetDb,
  seedDriverAndVehicle,
  seedQbSettings,
  seedMonthlyActiveSession,
  findPaymentByStripePaymentIntentId,
  findSessionByStripeSubscriptionId,
  findPaymentsByStripeSubscriptionId,
  countAudit,
  countPaymentsByTypeForSession,
} from "../support/db";
import { authenticateAdmin } from "../support/app-api";
import { expectNoNeedsReviewCode, expectNeedsReviewCode } from "../support/assertions/reconcile";
import { ensureQbTokens } from "../support/quickbooks/client";

test.skip(
  !getE2EEnv().stripe,
  "Set E2E_STRIPE_SECRET_KEY and E2E_STRIPE_PUBLISHABLE_KEY to run Stripe integration tests.",
);

// ---------------------------------------------------------------------------
// MONTHLY-BOOT-001: Subscription bootstrap writes DB Payment + QB Sales Receipt
// ---------------------------------------------------------------------------
test(
  "MONTHLY-BOOT-001: checkout.session.completed (subscription) creates monthly DB session + QB receipt",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    const stripe = getE2EStripe();
    const env = getE2EEnv();
    const baseUrl = env.baseUrl;
    const qbTokens = await ensureQbTokens();
    const qbUsable = qbTokens != null;

    try {
      await resetDb();

      if (qbTokens) {
        await seedQbSettings({
          realmId: qbTokens.realmId,
          accessToken: qbTokens.accessToken,
          refreshToken: qbTokens.refreshToken,
          tokenExpiresAt: null,
        });
      }

      // Seed Driver + Vehicle only — webhook creates the Session
      const { driver, vehicle } = await seedDriverAndVehicle({
        testRun: world.testRun,
        name: `E2E MB001 ${world.testRun.testRunId.slice(3, 11)}`,
      });

      // STEP 1: Create real Stripe customer + payment method + subscription
      const customer = await createStripeCustomer({
        testRunId: world.testRun.testRunId,
        name: driver.name,
        email: driver.email ?? `${world.testRun.testRunId}@example.test`,
      });

      await attachTestPaymentMethod({
        customerId: customer.id,
        paymentMethodId: TEST_PAYMENT_METHODS.VISA,
      });

      // Price for 1-month parking — unit amount in cents
      const MONTHLY_CENTS = 40000; // $400.00 truck monthly
      const price = await stripe.prices.create({
        unit_amount: MONTHLY_CENTS,
        currency: "usd",
        recurring: { interval: "month" },
        product_data: { name: "E2E Monthly Parking" },
      });

      const sub = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: price.id }],
        expand: ["latest_invoice"],
      });

      // STEP 2: Poll for InvoicePayment materialization (eventually consistent)
      const invoiceId =
        typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id ?? "";

      let invoicePaymentPi: string | null = null;
      for (let i = 0; i < 20 && !invoicePaymentPi; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const list = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 1 });
        const ip = list.data[0];
        const rawPi = ip?.payment?.payment_intent;
        if (rawPi) {
          invoicePaymentPi = typeof rawPi === "string" ? rawPi : rawPi.id;
        }
      }
      expect(
        invoicePaymentPi,
        "InvoicePayment must materialize with a payment_intent before sending CS event",
      ).not.toBeNull();

      // STEP 3: Send synthetic checkout.session.completed (subscription mode)
      const fakeCsId = `cs_test_mb_${world.testRun.testRunId.replace(/-/g, "_")}`;
      const csEventId = `evt_test_mb_${world.testRun.testRunId.replace(/-/g, "_")}`;

      const syntheticCs = {
        id: fakeCsId,
        object: "checkout.session",
        mode: "subscription",
        status: "complete",
        payment_status: "paid",
        subscription: sub.id,
        amount_total: MONTHLY_CENTS,
        currency: "usd",
        metadata: {
          sessionPurpose: "MONTHLY_CHECKIN",
          driverId: driver.id,
          vehicleId: vehicle.id,
          months: "1",
          termsVersion: "1.0",
          vehicleType: "TRUCK_TRAILER",
          overstayAuthorized: "true",
        },
      };

      const csEventPayload = JSON.stringify({
        id: csEventId,
        object: "event",
        api_version: "2025-09-30.clover",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 0,
        type: "checkout.session.completed",
        data: { object: syntheticCs },
      });

      const webhookSecret = env.stripe!.webhookSecret;
      const csSignature = stripe.webhooks.generateTestHeaderString({
        payload: csEventPayload,
        secret: webhookSecret!,
      });

      const csRes = await request.post(`${baseUrl}/api/stripe/webhook`, {
        data: csEventPayload,
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": csSignature,
        },
      });
      expect(csRes.status(), `Webhook must accept CS event, got: ${await csRes.text()}`).toBe(200);

      // STEP 4: Poll for Payment row created by the webhook
      let payment = await findPaymentByStripePaymentIntentId(invoicePaymentPi!);
      for (let i = 0; i < 15 && !payment; i++) {
        await new Promise((r) => setTimeout(r, 400));
        payment = await findPaymentByStripePaymentIntentId(invoicePaymentPi!);
      }
      expect(payment, "Payment must be created in DB after checkout.session.completed").not.toBeNull();

      // STEP 5: Assert DB state
      expect(payment!.status).toBe("COMPLETED");
      expect(payment!.amount).toBeCloseTo(MONTHLY_CENTS / 100, 2);

      // STEP 6: QB receipt (when QB is configured)
      if (world.qb && qbUsable) {
        expect(
          payment!.qbSalesReceiptId,
          "QB Sales Receipt ID must be written for MONTHLY_CHECKIN",
        ).not.toBeNull();

        type QbReceiptResponse = { SalesReceipt: { Id: string; TotalAmt: number } };
        const receiptData = await world.qb.fetch<QbReceiptResponse>(
          `/salesreceipt/${payment!.qbSalesReceiptId}?minorversion=65`,
        );
        expect(receiptData.SalesReceipt.TotalAmt).toBeCloseTo(payment!.amount, 2);
      }

      // STEP 7: Needs Review must be clean for this session
      const sessionId = payment!.sessionId;
      await authenticateAdmin(request);
      await expectNoNeedsReviewCode(request, "SUBSCRIPTION_PAYMENT_FAILED", { sessionId });
      await expectNoNeedsReviewCode(request, "SUBSCRIPTION_DELINQUENT", { sessionId });
    } finally {
      // world.cleanup() calls deleteCustomersForTestRun which deletes the Stripe
      // customer by metadata.testRunId. Stripe cascades the deletion to cancel
      // the attached subscription. The Stripe price created inline is left as a
      // sandbox artifact (prices cannot be deleted, only archived).
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// SUB-002: invoice.payment_failed marks billingStatus PAYMENT_FAILED
// ---------------------------------------------------------------------------
test(
  "SUB-002: invoice.payment_failed webhook sets Session.billingStatus to PAYMENT_FAILED",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    const stripe = getE2EStripe();
    const env = getE2EEnv();
    const baseUrl = env.baseUrl;

    try {
      await resetDb();

      // Synthetic subscription ID — no real Stripe subscription needed.
      // The handler only does a DB lookup by stripeSubscriptionId.
      const subId = `sub_test_s2_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 16)}`;

      const { session: seededSession } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // Build synthetic invoice.payment_failed event
      const eventId = `evt_test_s2_${world.testRun.testRunId.replace(/-/g, "_")}`;
      const syntheticInvoice = {
        id: `in_test_s2_${world.testRun.testRunId.replace(/-/g, "_")}`,
        object: "invoice",
        subscription: subId,
        status: "open",
        attempt_count: 1,
        amount_due: 40000,
        currency: "usd",
      };

      const eventPayload = JSON.stringify({
        id: eventId,
        object: "event",
        api_version: "2025-09-30.clover",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 0,
        type: "invoice.payment_failed",
        data: { object: syntheticInvoice },
      });

      const webhookSecret = env.stripe!.webhookSecret;
      const signature = stripe.webhooks.generateTestHeaderString({
        payload: eventPayload,
        secret: webhookSecret!,
      });

      const res = await request.post(`${baseUrl}/api/stripe/webhook`, {
        data: eventPayload,
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
      });
      expect(res.status(), `Webhook must accept invoice.payment_failed, got: ${await res.text()}`).toBe(200);

      // Assert: Session.billingStatus flipped to PAYMENT_FAILED
      let updatedSession = await findSessionByStripeSubscriptionId(subId);
      for (let i = 0; i < 10 && updatedSession?.billingStatus !== "PAYMENT_FAILED"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        updatedSession = await findSessionByStripeSubscriptionId(subId);
      }
      expect(
        updatedSession?.billingStatus,
        "Session.billingStatus must be PAYMENT_FAILED after invoice.payment_failed",
      ).toBe("PAYMENT_FAILED");

      // Session status remains ACTIVE (no eviction — Stripe will retry)
      expect(updatedSession?.status).toBe("ACTIVE");

      // Audit: RECURRING_CHARGE_FAILED logged for this session
      const auditCount = await countAudit("RECURRING_CHARGE_FAILED", seededSession.id);
      expect(auditCount, "RECURRING_CHARGE_FAILED audit must be logged").toBeGreaterThanOrEqual(1);

      // No MONTHLY_RENEWAL payment must be created — handler only flips billingStatus.
      // invoice.payment_succeeded creates renewals; invoice.payment_failed must not.
      const renewalCount = await countPaymentsByTypeForSession(seededSession.id, "MONTHLY_RENEWAL");
      expect(renewalCount, "invoice.payment_failed must not create a MONTHLY_RENEWAL payment").toBe(0);

      // Needs Review: SUBSCRIPTION_PAYMENT_FAILED must appear
      await authenticateAdmin(request);
      await expectNeedsReviewCode(request, "SUBSCRIPTION_PAYMENT_FAILED", { sessionId: seededSession.id });
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// SUB-004: customer.subscription.deleted marks billingStatus DELINQUENT
// ---------------------------------------------------------------------------
test(
  "SUB-004: customer.subscription.deleted webhook sets Session.billingStatus to DELINQUENT and clamps expectedEnd",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    const stripe = getE2EStripe();
    const env = getE2EEnv();
    const baseUrl = env.baseUrl;

    try {
      await resetDb();

      // Synthetic subscription ID — no real Stripe subscription needed.
      // The handler only does a DB lookup by stripeSubscriptionId and sets
      // billingStatus + clamps expectedEnd. No Stripe API calls are made.
      const subId = `sub_test_s4_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 16)}`;

      const { session: seededSession } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // Record expectedEnd before the event so we can assert clamping.
      // seededSession.expectedEnd is raw from seedMonthlyActiveSession (a pg Date
      // or string) — don't rely on its parsed value, just confirm it's in the future
      // by re-reading via findSessionByStripeSubscriptionId after seeding.
      const seededState = await findSessionByStripeSubscriptionId(subId);
      expect(
        seededState?.expectedEndMs,
        "Seeded session must have a future expectedEnd",
      ).toBeGreaterThan(Date.now());

      // Build synthetic customer.subscription.deleted event
      const eventId = `evt_test_s4_${world.testRun.testRunId.replace(/-/g, "_")}`;
      // cancellation_details.reason = "payment_failed" is required for the deletion to
      // classify as payment_failed (→ DELINQUENT). Without it, the new classifier treats
      // reason-less deletions as "unknown" — conservative, no auto-DELINQUENT mark.
      // This test specifically proves the payment-failed deletion path.
      const syntheticSub = {
        id: subId,
        object: "subscription",
        status: "canceled",
        canceled_at: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000),
        customer: `cus_test_s4_${world.testRun.testRunId.slice(0, 8)}`,
        cancellation_details: { reason: "payment_failed" },
      };

      const eventPayload = JSON.stringify({
        id: eventId,
        object: "event",
        api_version: "2025-09-30.clover",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 0,
        type: "customer.subscription.deleted",
        data: { object: syntheticSub },
      });

      const webhookSecret = env.stripe!.webhookSecret;
      const signature = stripe.webhooks.generateTestHeaderString({
        payload: eventPayload,
        secret: webhookSecret!,
      });

      const res = await request.post(`${baseUrl}/api/stripe/webhook`, {
        data: eventPayload,
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
      });
      expect(
        res.status(),
        `Webhook must accept customer.subscription.deleted, got: ${await res.text()}`,
      ).toBe(200);

      // Assert: Session.billingStatus flipped to DELINQUENT
      let updatedSession = await findSessionByStripeSubscriptionId(subId);
      for (let i = 0; i < 10 && updatedSession?.billingStatus !== "DELINQUENT"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        updatedSession = await findSessionByStripeSubscriptionId(subId);
      }
      expect(
        updatedSession?.billingStatus,
        "Session.billingStatus must be DELINQUENT after customer.subscription.deleted",
      ).toBe("DELINQUENT");

      // expectedEnd clamped: must be ≤ now (handler sets it to min(original, now))
      expect(
        updatedSession!.expectedEndMs,
        "expectedEnd must be clamped to ≤ now after subscription deleted",
      ).toBeLessThanOrEqual(Date.now() + 5000); // 5s tolerance for test latency

      // Audit: SUBSCRIPTION_CANCELED logged for this session
      const auditCount = await countAudit("SUBSCRIPTION_CANCELED", seededSession.id);
      expect(auditCount, "SUBSCRIPTION_CANCELED audit must be logged").toBeGreaterThanOrEqual(1);

      // Needs Review: SUBSCRIPTION_DELINQUENT must appear
      await authenticateAdmin(request);
      await expectNeedsReviewCode(request, "SUBSCRIPTION_DELINQUENT", { sessionId: seededSession.id });
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// SUB-010: invoice.payment_failed stores hostedInvoiceUrl on anchor payment
// ---------------------------------------------------------------------------
test(
  "SUB-010: invoice.payment_failed persists hosted_invoice_url on the anchor MONTHLY_CHECKIN payment",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    const stripe = getE2EStripe();
    const env = getE2EEnv();
    const baseUrl = env.baseUrl;

    try {
      await resetDb();

      const subId = `sub_test_s10_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 14)}`;
      const { session: seededSession } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      const fakeInvoiceUrl = `https://invoice.stripe.com/i/test_${world.testRun.testRunId.replace(/-/g, "")}`;

      const eventId = `evt_test_s10_${world.testRun.testRunId.replace(/-/g, "_")}`;
      const syntheticInvoice = {
        id: `in_test_s10_${world.testRun.testRunId.replace(/-/g, "_")}`,
        object: "invoice",
        subscription: subId,
        status: "open",
        attempt_count: 1,
        amount_due: 40000,
        currency: "usd",
        hosted_invoice_url: fakeInvoiceUrl,
      };

      const eventPayload = JSON.stringify({
        id: eventId,
        object: "event",
        api_version: "2025-09-30.clover",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 0,
        type: "invoice.payment_failed",
        data: { object: syntheticInvoice },
      });

      const webhookSecret = env.stripe!.webhookSecret;
      const signature = stripe.webhooks.generateTestHeaderString({
        payload: eventPayload,
        secret: webhookSecret!,
      });

      const res = await request.post(`${baseUrl}/api/stripe/webhook`, {
        data: eventPayload,
        headers: { "Content-Type": "application/json", "stripe-signature": signature },
      });
      expect(res.status(), `Webhook must accept invoice.payment_failed, got: ${await res.text()}`).toBe(200);

      // Poll: anchor payment must gain hostedInvoiceUrl
      let payments = await findPaymentsByStripeSubscriptionId(subId);
      for (let i = 0; i < 15 && !payments.find((p) => p.hostedInvoiceUrl); i++) {
        await new Promise((r) => setTimeout(r, 400));
        payments = await findPaymentsByStripeSubscriptionId(subId);
      }

      const anchor = payments[0];
      expect(anchor, "Anchor MONTHLY_CHECKIN payment must exist").toBeDefined();
      expect(anchor.hostedInvoiceUrl, "hostedInvoiceUrl must be persisted on anchor payment").toBe(fakeInvoiceUrl);

      // No MONTHLY_RENEWAL must have been created by invoice.payment_failed
      const renewals = payments.filter((p) => p.type === "MONTHLY_RENEWAL");
      expect(renewals.length, "invoice.payment_failed must not create a MONTHLY_RENEWAL row").toBe(0);

      // Needs Review: SUBSCRIPTION_PAYMENT_FAILED actionHref must equal fakeInvoiceUrl
      await authenticateAdmin(request);
      const nrRes = await request.get(`${baseUrl}/api/admin/reconcile/needs-review`);
      expect(nrRes.status()).toBe(200);
      const nrBody = await nrRes.json() as { items: Array<{ code: string; actionHref?: string; related?: { sessionId?: string } }> };
      const nrItem = nrBody.items.find(
        (i) => i.code === "SUBSCRIPTION_PAYMENT_FAILED" && i.related?.sessionId === seededSession.id,
      );
      expect(nrItem, "SUBSCRIPTION_PAYMENT_FAILED Needs Review item must exist").toBeDefined();
      expect(nrItem!.actionHref, "actionHref must equal the invoice recovery URL").toBe(fakeInvoiceUrl);
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// SUB-011: invoice.payment_succeeded (renewal) stores hostedInvoiceUrl on MONTHLY_RENEWAL
// ---------------------------------------------------------------------------
test(
  "SUB-011: invoice.payment_succeeded (renewal) persists hosted_invoice_url on the created MONTHLY_RENEWAL payment",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    const stripe = getE2EStripe();
    const env = getE2EEnv();
    const baseUrl = env.baseUrl;

    try {
      await resetDb();

      const subId = `sub_test_s11_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 14)}`;
      await seedMonthlyActiveSession({ testRun: world.testRun, stripeSubscriptionId: subId });

      const renewalInvoiceId = `in_test_s11_${world.testRun.testRunId.replace(/-/g, "_")}`;
      const renewalPiId = `pi_test_s11_${world.testRun.testRunId.replace(/-/g, "_")}`;
      const fakeInvoiceUrl = `https://invoice.stripe.com/i/test_s11_${world.testRun.testRunId.replace(/-/g, "")}`;

      const eventPayload = JSON.stringify({
        id: `evt_test_s11_${world.testRun.testRunId.replace(/-/g, "_")}`,
        object: "event",
        api_version: "2025-09-30.clover",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 0,
        type: "invoice.payment_succeeded",
        data: {
          object: {
            id: renewalInvoiceId,
            object: "invoice",
            subscription: subId,
            billing_reason: "subscription_cycle",
            status: "paid",
            amount_paid: 40000,
            currency: "usd",
            payment_intent: renewalPiId,
            hosted_invoice_url: fakeInvoiceUrl,
          },
        },
      });

      const webhookSecret = env.stripe!.webhookSecret;
      const signature = stripe.webhooks.generateTestHeaderString({
        payload: eventPayload,
        secret: webhookSecret!,
      });

      const res = await request.post(`${baseUrl}/api/stripe/webhook`, {
        data: eventPayload,
        headers: { "Content-Type": "application/json", "stripe-signature": signature },
      });
      expect(res.status(), `Webhook must accept invoice.payment_succeeded, got: ${await res.text()}`).toBe(200);

      // Poll: MONTHLY_RENEWAL with this invoice ID must appear with hostedInvoiceUrl set
      let payments = await findPaymentsByStripeSubscriptionId(subId);
      let renewal = payments.find((p) => p.type === "MONTHLY_RENEWAL" && p.stripeInvoiceId === renewalInvoiceId);
      for (let i = 0; i < 15 && !renewal?.hostedInvoiceUrl; i++) {
        await new Promise((r) => setTimeout(r, 400));
        payments = await findPaymentsByStripeSubscriptionId(subId);
        renewal = payments.find((p) => p.type === "MONTHLY_RENEWAL" && p.stripeInvoiceId === renewalInvoiceId);
      }

      expect(renewal, "MONTHLY_RENEWAL payment must be created").toBeDefined();
      expect(renewal!.hostedInvoiceUrl, "MONTHLY_RENEWAL must carry hostedInvoiceUrl").toBe(fakeInvoiceUrl);

      // The anchor MONTHLY_CHECKIN row must NOT have been overwritten with the renewal's URL.
      const anchor = payments.find((p) => p.type === "MONTHLY_CHECKIN");
      expect(anchor).toBeDefined();
      expect(anchor!.hostedInvoiceUrl, "MONTHLY_CHECKIN anchor row must not receive renewal invoice URL").toBeNull();
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// SUB-012: CHECKIN rows seeded without invoice context have null hostedInvoiceUrl
// ---------------------------------------------------------------------------
test(
  "SUB-012: MONTHLY_CHECKIN rows seeded without an invoice have null hostedInvoiceUrl",
  async ({}, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();

      const subId = `sub_test_s12_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 14)}`;
      await seedMonthlyActiveSession({ testRun: world.testRun, stripeSubscriptionId: subId });

      const payments = await findPaymentsByStripeSubscriptionId(subId);
      const anchor = payments.find((p) => p.type === "MONTHLY_CHECKIN");

      expect(anchor, "MONTHLY_CHECKIN payment must exist after seed").toBeDefined();
      expect(anchor!.hostedInvoiceUrl, "MONTHLY_CHECKIN starts with null hostedInvoiceUrl — no invoice event fired").toBeNull();
    } finally {
      await world.cleanup();
    }
  },
);
