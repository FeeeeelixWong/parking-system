import { expect, test } from "@playwright/test";
import { getE2EEnv } from "../support/env";
import { getE2EStripe } from "../support/stripe/client";
import { attachTestPaymentMethod, createStripeCustomer, TEST_PAYMENT_METHODS } from "../support/stripe/customers";
import { createWorld } from "../support/world";
import {
  countAudit,
  countStripeEvent,
  getSessionEvidenceSnapshot,
  resetDb,
  seedMonthlyActiveSession,
  setFailedPaymentPolicy,
  updateSessionBillingFailedAt,
  updateSessionExpectedEnd,
  setSessionBillingCancelledByAdmin,
  setBillingPaymentFailedWithNullTimestamp,
  readLatestSubscriptionCanceledAudit,
  setSessionStatus,
  findSessionByStripeSubscriptionId,
} from "../support/db";
import { authenticateAdmin, getDriverState, getNeedsReview, postDriverOpenGate, putAdminSession } from "../support/app-api";
import { writeEvidenceReport } from "../support/evidence";

test.skip(
  !getE2EEnv().stripe,
  "Set E2E_STRIPE_SECRET_KEY and E2E_STRIPE_WEBHOOK_SECRET to run Stripe integration tests.",
);

// Shared helper: build and send a signed synthetic invoice.payment_failed webhook
async function sendInvoicePaymentFailed(
  request: import("@playwright/test").APIRequestContext,
  subId: string,
): Promise<void> {
  const stripe = getE2EStripe();
  const env = getE2EEnv();
  const webhookSecret = env.stripe!.webhookSecret!;

  const syntheticInvoice = {
    id: `in_test_dq_${subId.slice(-8)}`,
    object: "invoice",
    subscription: subId,
    status: "open",
    attempt_count: 1,
    amount_due: 40000,
    currency: "usd",
  };

  const payload = JSON.stringify({
    id: `evt_test_dq_pf_${subId.slice(-8)}`,
    object: "event",
    api_version: "2025-09-30.clover",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    type: "invoice.payment_failed",
    data: { object: syntheticInvoice },
  });

  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
  });

  const res = await request.post(`${env.baseUrl}/api/stripe/webhook`, {
    data: payload,
    headers: { "Content-Type": "application/json", "stripe-signature": signature },
  });
  expect(res.status(), `invoice.payment_failed webhook: ${await res.text()}`).toBe(200);
}

// Shared helper: build and send a signed synthetic customer.subscription.deleted webhook.
// Returns the synthetic event ID so callers can assert against the StripeEvent row.
async function sendSubscriptionDeleted(
  request: import("@playwright/test").APIRequestContext,
  subId: string,
  options?: {
    /** Stripe cancellation_details.reason — omit to send no cancellation_details. */
    cancellationReason?: "payment_failed" | "payment_disputed" | "cancellation_requested" | null;
    /** Unix timestamp for cancel_at — omit to send no cancel_at. */
    cancelAt?: number;
    /** Whether cancel_at_period_end was set. */
    cancelAtPeriodEnd?: boolean;
    /** Appended to the event ID for disambiguation when sending >1 event per sub. */
    eventIdSuffix?: string;
  },
): Promise<string> {
  const stripe = getE2EStripe();
  const env = getE2EEnv();
  const webhookSecret = env.stripe!.webhookSecret!;

  const syntheticSub: Record<string, unknown> = {
    id: subId,
    object: "subscription",
    status: "canceled",
    canceled_at: Math.floor(Date.now() / 1000),
    current_period_end: Math.floor(Date.now() / 1000),
    customer: `cus_test_dq_${subId.slice(-8)}`,
  };
  if (options?.cancellationReason !== undefined) {
    syntheticSub.cancellation_details = {
      reason: options.cancellationReason,
      comment: null,
      feedback: null,
    };
  }
  if (options?.cancelAt != null) syntheticSub.cancel_at = options.cancelAt;
  if (options?.cancelAtPeriodEnd != null) syntheticSub.cancel_at_period_end = options.cancelAtPeriodEnd;

  const suffix = options?.eventIdSuffix ?? "";
  const eventId = `evt_test_dq_sd_${subId.slice(-8)}${suffix}`;
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    api_version: "2025-09-30.clover",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    type: "customer.subscription.deleted",
    data: { object: syntheticSub },
  });

  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
  });

  const res = await request.post(`${env.baseUrl}/api/stripe/webhook`, {
    data: payload,
    headers: { "Content-Type": "application/json", "stripe-signature": signature },
  });
  expect(res.status(), `customer.subscription.deleted webhook: ${await res.text()}`).toBe(200);
  return eventId;
}

async function createRealMonthlySubscription(testRun: ReturnType<typeof createWorld>["testRun"]) {
  const stripe = getE2EStripe();
  const customer = await createStripeCustomer({
    testRunId: testRun.testRunId,
    name: `E2E Delinq ${testRun.testRunId.slice(4, 12)}`,
    email: testRun.driverEmail(),
  });

  await attachTestPaymentMethod({
    customerId: customer.id,
    paymentMethodId: TEST_PAYMENT_METHODS.VISA,
  });

  const price = await stripe.prices.create({
    unit_amount: 40000,
    currency: "usd",
    recurring: { interval: "month" },
    product_data: { name: "E2E Delinquency Policy Monthly Parking" },
  });

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
  });

  return { customer, subscription };
}

// ---------------------------------------------------------------------------
// DELINQ-001: policy=on_subscription_deleted + invoice.payment_failed → gate OK
// ---------------------------------------------------------------------------
test(
  "DELINQ-001: policy on_subscription_deleted — invoice.payment_failed does not block gate",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();

      // policy = on_subscription_deleted (default) — PAYMENT_FAILED alone must not block
      await setFailedPaymentPolicy("on_subscription_deleted");

      const subId = `sub_test_d1_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session, driver } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // Trigger: invoice.payment_failed → billingStatus = PAYMENT_FAILED
      await sendInvoicePaymentFailed(request, subId);

      // Poll until status flips
      let updated = await findSessionByStripeSubscriptionId(subId);
      for (let i = 0; i < 10 && updated?.billingStatus !== "PAYMENT_FAILED"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        updated = await findSessionByStripeSubscriptionId(subId);
      }
      expect(updated?.billingStatus).toBe("PAYMENT_FAILED");

      // Gate must still open — policy says only subscription.deleted blocks
      const gateRes = await postDriverOpenGate(request, session.id, {
        driverId: driver.id,
        direction: "ENTRANCE",
        scanContext: "fresh",
      });
      const body = gateRes.data;
      expect(body.ok, `Gate must be ok under on_subscription_deleted policy: ${JSON.stringify(body)}`).toBe(
        true,
      );
      expect(await countAudit("GATE_OPEN", session.id), "GATE_OPEN must be logged").toBe(1);
      expect(await countAudit("GATE_DENIED", session.id), "no GATE_DENIED").toBe(0);
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-002: policy=immediate_on_payment_failed + invoice.payment_failed → gate denied
// ---------------------------------------------------------------------------
test(
  "DELINQ-002: policy immediate_on_payment_failed — invoice.payment_failed blocks gate",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();

      await setFailedPaymentPolicy("immediate_on_payment_failed");

      const subId = `sub_test_d2_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session, driver } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // Trigger: invoice.payment_failed → billingStatus = PAYMENT_FAILED
      await sendInvoicePaymentFailed(request, subId);

      let updated = await findSessionByStripeSubscriptionId(subId);
      for (let i = 0; i < 10 && updated?.billingStatus !== "PAYMENT_FAILED"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        updated = await findSessionByStripeSubscriptionId(subId);
      }
      expect(updated?.billingStatus).toBe("PAYMENT_FAILED");

      // Gate must be denied — immediate policy blocks on first failure
      const gateRes = await postDriverOpenGate(request, session.id, {
        driverId: driver.id,
        direction: "ENTRANCE",
        scanContext: "fresh",
      });
      const body = gateRes.data;
      expect(body.ok, `Gate must be denied (immediate policy): ${JSON.stringify(body)}`).toBe(false);
      expect(
        (body as { ok: false; denial: { code: string } }).denial?.code,
        "Denial code must be SUBSCRIPTION_DELINQUENT",
      ).toBe("SUBSCRIPTION_DELINQUENT");
      expect(await countAudit("GATE_DENIED", session.id), "GATE_DENIED must be logged").toBe(1);
      expect(await countAudit("GATE_OPEN", session.id), "no GATE_OPEN").toBe(0);
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-003: policy=after_grace_days + grace elapsed via cron → gate denied
// ---------------------------------------------------------------------------
test(
  "DELINQ-003: policy after_grace_days — cron escalates after grace period, gate denied",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    const env = getE2EEnv();
    const baseUrl = env.baseUrl;

    try {
      await resetDb();

      // grace = 1 day, billingFailedAt will be backdated 2 days so grace is elapsed
      await setFailedPaymentPolicy("after_grace_days", 1);

      const subId = `sub_test_d3_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session, driver } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // Set billingStatus = PAYMENT_FAILED and billingFailedAt = 2 days ago
      // by sending the webhook and then backdating in the DB.
      await sendInvoicePaymentFailed(request, subId);
      let updated = await findSessionByStripeSubscriptionId(subId);
      for (let i = 0; i < 10 && updated?.billingStatus !== "PAYMENT_FAILED"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        updated = await findSessionByStripeSubscriptionId(subId);
      }
      expect(updated?.billingStatus).toBe("PAYMENT_FAILED");

      // Backdate billingFailedAt to 2 days ago so the grace period (1d) has elapsed
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await updateSessionBillingFailedAt(session.id, twoDaysAgo);

      // Gate should still open before cron runs — grace not yet evaluated by app
      // (policy check in open-gate only checks billingStatus === DELINQUENT or immediate policy,
      //  so PAYMENT_FAILED with after_grace_days policy does NOT block yet at this layer)

      // Run the cron — it should escalate PAYMENT_FAILED → DELINQUENT
      await authenticateAdmin(request); // /api/cron/check-sessions has no authentication — any HTTP request works; the admin cookie is incidental
      const cronRes = await request.get(`${baseUrl}/api/cron/check-sessions`);
      expect(cronRes.status(), `Cron must succeed: ${await cronRes.text()}`).toBe(200);

      // Poll until DELINQUENT
      updated = await findSessionByStripeSubscriptionId(subId);
      for (let i = 0; i < 10 && updated?.billingStatus !== "DELINQUENT"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        updated = await findSessionByStripeSubscriptionId(subId);
      }
      expect(
        updated?.billingStatus,
        "Cron must escalate to DELINQUENT after grace period elapsed",
      ).toBe("DELINQUENT");

      // Now gate must be denied
      const gateRes = await postDriverOpenGate(request, session.id, {
        driverId: driver.id,
        direction: "ENTRANCE",
        scanContext: "fresh",
      });
      const body = gateRes.data;
      expect(body.ok, `Gate must be denied after DELINQUENT: ${JSON.stringify(body)}`).toBe(false);
      expect((body as { ok: false; denial: { code: string } }).denial?.code).toBe(
        "SUBSCRIPTION_DELINQUENT",
      );
      expect(await countAudit("GATE_DENIED", session.id), "GATE_DENIED must be logged").toBe(1);
      expect(await countAudit("GATE_OPEN", session.id), "no GATE_OPEN").toBe(0);
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-004: policy=on_subscription_deleted + subscription.deleted → gate denied
// ---------------------------------------------------------------------------
test(
  "DELINQ-004: payment_failed subscription.deleted marks DELINQUENT and blocks gate regardless of policy",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();

      // Use default policy (on_subscription_deleted) — payment_failed deletion is terminal
      await setFailedPaymentPolicy("on_subscription_deleted");

      const subId = `sub_test_d4_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session, driver } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // Trigger: customer.subscription.deleted with payment_failed reason → billingStatus = DELINQUENT
      await sendSubscriptionDeleted(request, subId, { cancellationReason: "payment_failed" });

      let updated = await findSessionByStripeSubscriptionId(subId);
      for (let i = 0; i < 10 && updated?.billingStatus !== "DELINQUENT"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        updated = await findSessionByStripeSubscriptionId(subId);
      }
      expect(updated?.billingStatus).toBe("DELINQUENT");

      // Gate must be denied
      const gateRes = await postDriverOpenGate(request, session.id, {
        driverId: driver.id,
        direction: "ENTRANCE",
        scanContext: "fresh",
      });
      const body = gateRes.data;
      expect(body.ok, `Gate must be denied after subscription deleted: ${JSON.stringify(body)}`).toBe(false);
      expect((body as { ok: false; denial: { code: string } }).denial?.code).toBe(
        "SUBSCRIPTION_DELINQUENT",
      );
      expect(await countAudit("GATE_DENIED", session.id), "GATE_DENIED must be logged").toBe(1);
      expect(await countAudit("GATE_OPEN", session.id), "no GATE_OPEN").toBe(0);
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-005: after_grace_days inline gate check — no cron needed
// Proves isAccessBlocked computes the effective block inline from billingFailedAt
// ---------------------------------------------------------------------------
test(
  "DELINQ-005: policy after_grace_days — inline gate check denies without cron when grace elapsed",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();

      // grace = 1 day, billingFailedAt will be backdated 2 days so grace is elapsed
      await setFailedPaymentPolicy("after_grace_days", 1);

      const subId = `sub_test_d5_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session, driver } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // Trigger: invoice.payment_failed → billingStatus = PAYMENT_FAILED
      await sendInvoicePaymentFailed(request, subId);
      let updated = await findSessionByStripeSubscriptionId(subId);
      for (let i = 0; i < 10 && updated?.billingStatus !== "PAYMENT_FAILED"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        updated = await findSessionByStripeSubscriptionId(subId);
      }
      expect(updated?.billingStatus).toBe("PAYMENT_FAILED");

      // Backdate billingFailedAt to 2 days ago so grace (1d) is elapsed
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await updateSessionBillingFailedAt(session.id, twoDaysAgo);

      // Gate must be denied inline — no cron required
      const gateRes = await postDriverOpenGate(request, session.id, {
        driverId: driver.id,
        direction: "ENTRANCE",
        scanContext: "fresh",
      });
      const body = gateRes.data;
      expect(body.ok, `Gate must be denied by inline grace check: ${JSON.stringify(body)}`).toBe(false);
      expect(
        (body as { ok: false; denial: { code: string } }).denial?.code,
        "Denial code must be SUBSCRIPTION_DELINQUENT",
      ).toBe("SUBSCRIPTION_DELINQUENT");
      expect(await countAudit("GATE_DENIED", session.id), "GATE_DENIED must be logged").toBe(1);
      expect(await countAudit("GATE_OPEN", session.id), "no GATE_OPEN").toBe(0);
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-006: billingCancelledByAdmin suppresses DELINQUENT on subscription.deleted
// ---------------------------------------------------------------------------
test(
  "DELINQ-006: billingCancelledByAdmin=true — subscription.deleted does not mark DELINQUENT",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();

      await setFailedPaymentPolicy("on_subscription_deleted");

      const subId = `sub_test_d6_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // Simulate admin "cancel at period end" — sets the guard flag before webhook arrives
      await setSessionBillingCancelledByAdmin(session.id);

      // Trigger: customer.subscription.deleted (response 200 already asserted inside helper)
      const eventId = await sendSubscriptionDeleted(request, subId);

      // Poll until the StripeEvent row exists — proves the webhook ran and committed all side effects
      let stripeEventCount = 0;
      for (let i = 0; i < 10 && stripeEventCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 300));
        stripeEventCount = await countStripeEvent(eventId);
      }
      expect(stripeEventCount, "StripeEvent row must exist — proves webhook was processed").toBe(1);

      // The early-return branch (billingCancelledByAdmin) must NOT write SUBSCRIPTION_CANCELED
      expect(
        await countAudit("SUBSCRIPTION_CANCELED", session.id),
        "SUBSCRIPTION_CANCELED must NOT be written when billingCancelledByAdmin=true",
      ).toBe(0);

      // billingStatus must remain non-DELINQUENT
      const updated = await findSessionByStripeSubscriptionId(subId);
      expect(
        updated?.billingStatus,
        `billingCancelledByAdmin should suppress DELINQUENT — got: ${updated?.billingStatus}`,
      ).not.toBe("DELINQUENT");
    } finally {
      await world.cleanup();
    }
  },
);

test(
  "DELINQ-007: adjust-monthly-access stop marks admin cancellation and suppresses later delinquency",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();
      await authenticateAdmin(request);
      await setFailedPaymentPolicy("on_subscription_deleted");

      const { subscription } = await createRealMonthlySubscription(world.testRun);
      const { session } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subscription.id,
      });
      const before = await getSessionEvidenceSnapshot(session.id);
      const effectiveEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);

      const adjustRes = await putAdminSession(request, {
        sessionId: session.id,
        action: "adjust-monthly-access",
        effectiveEnd: effectiveEnd.toISOString(),
        renewalAction: "stop",
        refund: { mode: "none" },
        reason: "E2E: shorten access and stop renewal",
      });
      expect(adjustRes.status, JSON.stringify(adjustRes.data)).toBe(200);

      await sendSubscriptionDeleted(request, subscription.id);

      const after = await getSessionEvidenceSnapshot(session.id);
      const updated = await findSessionByStripeSubscriptionId(subscription.id);
      expect(updated?.billingStatus, "billingStatus must not become DELINQUENT").not.toBe("DELINQUENT");
      expect(updated?.status, "session must remain ACTIVE — custom access window still open").toBe("ACTIVE");
      expect((after.session as Array<{ billingCancelledByAdmin: boolean }>)[0]?.billingCancelledByAdmin).toBe(true);

      await writeEvidenceReport(testInfo, {
        scenarioId: "DELINQ-007",
        objective: "Admin monthly access adjustment that stops renewal marks the Stripe cancellation as intentional, so a later subscription.deleted event does not create delinquency or close the session before the custom access end.",
        expectedChanges: [
          "Session.expectedEnd shortens to the admin-selected future access end.",
          "Session.billingCancelledByAdmin becomes true.",
          "Session.status remains ACTIVE — custom access window (10 days) is still open.",
          "Session.billingStatus remains non-DELINQUENT after customer.subscription.deleted.",
          "AuditLog records the monthly access adjustment.",
        ],
        actions: [
          { label: "Seed monthly session with real Stripe subscription", data: { sessionId: session.id, subscriptionId: subscription.id } },
          { label: "PUT /api/admin/sessions adjust-monthly-access renewalAction=stop", data: adjustRes.data },
          { label: "POST signed customer.subscription.deleted webhook", data: { subscriptionId: subscription.id } },
        ],
        before,
        after,
      });
    } finally {
      await world.cleanup();
    }
  },
);

test(
  "DELINQ-008: cancel-monthly-session period_end marks admin cancellation and suppresses later delinquency",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();
      await authenticateAdmin(request);
      await setFailedPaymentPolicy("on_subscription_deleted");

      const { subscription } = await createRealMonthlySubscription(world.testRun);
      const { session } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subscription.id,
      });
      const before = await getSessionEvidenceSnapshot(session.id);

      const cancelRes = await putAdminSession(request, {
        sessionId: session.id,
        action: "cancel-monthly-session",
        accessEndsAt: "period_end",
        refund: { mode: "none" },
        reason: "E2E: cancel renewal at period end",
      });
      expect(cancelRes.status, JSON.stringify(cancelRes.data)).toBe(200);

      // Capture audit count after the admin action (which writes one SUBSCRIPTION_CANCELED),
      // before the webhook fires — so we can assert the webhook adds exactly one more.
      const auditCountBeforeWebhook = await countAudit("SUBSCRIPTION_CANCELED", session.id);

      // Backdate expectedEnd to 2 days ago so the webhook handler sees the period as ended.
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await updateSessionExpectedEnd(session.id, twoDaysAgo);

      const eventId = await sendSubscriptionDeleted(request, subscription.id);

      // Wait for the webhook to be processed (StripeEvent row proves it ran).
      let stripeEventCount = 0;
      for (let i = 0; i < 10 && stripeEventCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 300));
        stripeEventCount = await countStripeEvent(eventId);
      }
      expect(stripeEventCount, "StripeEvent row must exist — proves webhook was processed").toBe(1);

      const after = await getSessionEvidenceSnapshot(session.id);
      const updated = await findSessionByStripeSubscriptionId(subscription.id);
      expect(updated?.billingStatus, "billingStatus must not become DELINQUENT").not.toBe("DELINQUENT");
      expect(updated?.status, "session must be COMPLETED — paid period has ended").toBe("COMPLETED");
      expect((after.session as Array<{ billingCancelledByAdmin: boolean }>)[0]?.billingCancelledByAdmin).toBe(true);
      expect(await countAudit("SUBSCRIPTION_CANCELED", session.id), "webhook must add exactly one SUBSCRIPTION_CANCELED").toBe(auditCountBeforeWebhook + 1);

      await writeEvidenceReport(testInfo, {
        scenarioId: "DELINQ-008",
        objective: "Admin period-end monthly cancellation: when Stripe fires subscription.deleted after the paid period ends, the session is closed as COMPLETED (not DELINQUENT).",
        expectedChanges: [
          "Session.billingCancelledByAdmin becomes true (set by admin cancel action).",
          "Session.status becomes COMPLETED when subscription.deleted fires after period end.",
          "Session.billingStatus remains non-DELINQUENT.",
          "AuditLog records SUBSCRIPTION_CANCELED.",
        ],
        actions: [
          { label: "Seed monthly session with real Stripe subscription", data: { sessionId: session.id, subscriptionId: subscription.id } },
          { label: "PUT /api/admin/sessions cancel-monthly-session accessEndsAt=period_end", data: cancelRes.data },
          { label: "Backdate expectedEnd to 2 days ago (simulate period elapsed)", data: { expectedEnd: twoDaysAgo.toISOString() } },
          { label: "POST signed customer.subscription.deleted webhook", data: { subscriptionId: subscription.id, eventId } },
        ],
        before,
        after,
      });
    } finally {
      await world.cleanup();
    }
  },
);

test(
  "DELINQ-009: deprecated cancel-subscription returns 410 and does not mutate session",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();
      await authenticateAdmin(request);

      const subId = `sub_test_d9_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });
      const before = await getSessionEvidenceSnapshot(session.id);

      const deprecatedRes = await putAdminSession(request, {
        sessionId: session.id,
        action: "cancel-subscription",
        cancelImmediately: false,
      });
      expect(deprecatedRes.status, JSON.stringify(deprecatedRes.data)).toBe(410);

      const after = await getSessionEvidenceSnapshot(session.id);
      expect(after.session).toEqual(before.session);
      expect(after.auditLogs).toEqual(before.auditLogs);

      await writeEvidenceReport(testInfo, {
        scenarioId: "DELINQ-009",
        objective: "The deprecated subscription cancellation mutation is inert and cannot recreate admin-initiated delinquency drift.",
        expectedChanges: [
          "API returns HTTP 410 with a migration message.",
          "No Session fields change.",
          "No AuditLog entry is written.",
        ],
        actions: [
          { label: "Seed monthly session with synthetic subscription ID", data: { sessionId: session.id, subscriptionId: subId } },
          { label: "PUT /api/admin/sessions cancel-subscription", data: deprecatedRes.data },
        ],
        before,
        after,
      });
    } finally {
      await world.cleanup();
    }
  },
);

test(
  "DELINQ-010: driver state reflects inline grace-period billing block",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();
      await setFailedPaymentPolicy("after_grace_days", 1);

      const subId = `sub_test_d10_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session, driver } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });
      const before = await getSessionEvidenceSnapshot(session.id);

      await sendInvoicePaymentFailed(request, subId);
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await updateSessionBillingFailedAt(session.id, twoDaysAgo);

      const stateRes = await getDriverState(request, driver.phone);
      expect(stateRes.status, JSON.stringify(stateRes.data)).toBe(200);
      expect(stateRes.data.gateEligibility.entrance).toBe(false);
      expect(stateRes.data.gateEligibility.exit).toBe(false);
      expect(stateRes.data.gateEligibility.blockedReason).toContain("billing");

      const openGate = stateRes.data.activeSessions.length > 0
        ? stateRes.data.activeSessions[0]
        : null;
      expect(openGate).not.toBeNull();

      const after = await getSessionEvidenceSnapshot(session.id);
      await writeEvidenceReport(testInfo, {
        scenarioId: "DELINQ-010",
        objective: "The driver-state contract renders the same effective after-grace billing block as the open-gate command, before cron persists DELINQUENT.",
        expectedChanges: [
          "Session.billingStatus becomes PAYMENT_FAILED.",
          "Session.billingFailedAt is backdated beyond the configured grace period.",
          "GET /api/driver/state reports entrance=false and exit=false with a billing blocked reason.",
          "Session.billingStatus does not need to be persisted as DELINQUENT for the UI to block access.",
        ],
        actions: [
          { label: "Seed monthly session", data: { sessionId: session.id, subscriptionId: subId } },
          { label: "POST signed invoice.payment_failed webhook", data: { subscriptionId: subId } },
          { label: "Backdate billingFailedAt", data: { billingFailedAt: twoDaysAgo.toISOString() } },
          { label: "GET /api/driver/state", data: stateRes.data },
        ],
        before,
        after,
      });
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-011: after_grace_days boundary — billingFailedAt just inside grace → gate OK
// Locks the <= inequality: access blocks only when billingFailedAt + graceDays * 86400000 <= now
// ---------------------------------------------------------------------------
test(
  "DELINQ-011: policy after_grace_days — billingFailedAt just inside grace window allows gate",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();

      // grace = 1 day; billingFailedAt will be set to now - 24h + 60s (just inside grace)
      await setFailedPaymentPolicy("after_grace_days", 1);

      const subId = `sub_test_d11_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session, driver } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // Trigger: invoice.payment_failed → billingStatus = PAYMENT_FAILED
      await sendInvoicePaymentFailed(request, subId);
      let updated = await findSessionByStripeSubscriptionId(subId);
      for (let i = 0; i < 10 && updated?.billingStatus !== "PAYMENT_FAILED"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        updated = await findSessionByStripeSubscriptionId(subId);
      }
      expect(updated?.billingStatus).toBe("PAYMENT_FAILED");

      // Set billingFailedAt to 6 hours ago — well inside the 1-day grace window.
      // Using a large margin (18h before grace expiry) makes the test resilient to clock
      // differences between the test process and the reused Next.js server process.
      const clearlyInsideGrace = new Date(Date.now() - 6 * 60 * 60 * 1000);
      await updateSessionBillingFailedAt(session.id, clearlyInsideGrace);

      // Gate must still open — grace has NOT elapsed yet
      const gateRes = await postDriverOpenGate(request, session.id, {
        driverId: driver.id,
        direction: "ENTRANCE",
        scanContext: "fresh",
      });
      const body = gateRes.data;
      expect(body.ok, `Gate must be ok while within grace window: ${JSON.stringify(body)}`).toBe(true);
      expect(await countAudit("GATE_OPEN", session.id), "GATE_OPEN must be logged").toBe(1);
      expect(await countAudit("GATE_DENIED", session.id), "no GATE_DENIED").toBe(0);
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-012: Natural cancel_at expiry → session COMPLETED, never DELINQUENT
// Covers the P1 bug: monthly checkouts set cancel_at = expectedEnd, so Stripe
// fires subscription.deleted at period end. The new classifier treats cancel_at
// as planned_expiry and closes the session as COMPLETED.
// ---------------------------------------------------------------------------
test(
  "DELINQ-012: natural cancel_at expiry closes session as COMPLETED, not DELINQUENT",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();
      await setFailedPaymentPolicy("on_subscription_deleted");

      const subId = `sub_test_d12_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });
      const before = await getSessionEvidenceSnapshot(session.id);

      // Backdate expectedEnd to simulate that the period has elapsed.
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await updateSessionExpectedEnd(session.id, twoDaysAgo);

      // Send subscription.deleted with cancel_at set (the signal our checkout always adds).
      // No cancellation_details.reason — Stripe may omit it for natural expiry.
      const cancelAtTs = Math.floor(twoDaysAgo.getTime() / 1000);
      const eventId = await sendSubscriptionDeleted(request, subId, {
        cancelAt: cancelAtTs,
      });

      // Wait for StripeEvent row — proves webhook ran to completion.
      let stripeEventCount = 0;
      for (let i = 0; i < 10 && stripeEventCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 300));
        stripeEventCount = await countStripeEvent(eventId);
      }
      expect(stripeEventCount, "StripeEvent row must exist — proves webhook processed").toBe(1);

      const after = await getSessionEvidenceSnapshot(session.id);
      const updated = await findSessionByStripeSubscriptionId(subId);
      expect(updated?.status, "session must be COMPLETED after natural expiry").toBe("COMPLETED");
      expect(updated?.billingStatus, "billingStatus must not become DELINQUENT").not.toBe("DELINQUENT");
      expect(
        await countAudit("SUBSCRIPTION_CANCELED", session.id),
        "SUBSCRIPTION_CANCELED must be audited exactly once",
      ).toBe(1);

      // Verify audit details mention planned expiry (not dunning/delinquency).
      const cancelAudit = (after.auditLogs as Array<{ action: string; details: string }>).find(
        (a) => a.action === "SUBSCRIPTION_CANCELED",
      );
      expect(
        cancelAudit?.details,
        "audit details must indicate planned expiry, not payment failure",
      ).toMatch(/planned expiry|cancel_at/i);

      await writeEvidenceReport(testInfo, {
        scenarioId: "DELINQ-012",
        objective: "Natural cancel_at expiry (set at checkout = expectedEnd) closes the session as COMPLETED rather than mislabeling it as delinquent.",
        expectedChanges: [
          "Session.status becomes COMPLETED.",
          "Session.billingStatus remains non-DELINQUENT.",
          "AuditLog records SUBSCRIPTION_CANCELED with planned-expiry details.",
        ],
        actions: [
          { label: "Seed monthly session with real Stripe subscription", data: { sessionId: session.id, subscriptionId: subId } },
          { label: "Backdate expectedEnd to 2 days ago", data: { expectedEnd: twoDaysAgo.toISOString() } },
          { label: "POST signed customer.subscription.deleted with cancel_at", data: { subscriptionId: subId, cancelAt: cancelAtTs, eventId } },
        ],
        before,
        after,
      });
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-013: payment_failed subscription.deleted → DELINQUENT + gate denied
// Explicit cancellation_details.reason = "payment_failed" is the only signal
// that should produce billingStatus = DELINQUENT.
// ---------------------------------------------------------------------------
test(
  "DELINQ-013: payment_failed subscription.deleted marks DELINQUENT and denies gate",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();
      await setFailedPaymentPolicy("on_subscription_deleted");

      const subId = `sub_test_d13_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session, driver } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });
      const before = await getSessionEvidenceSnapshot(session.id);

      const eventId = await sendSubscriptionDeleted(request, subId, {
        cancellationReason: "payment_failed",
      });

      // Poll until webhook completes.
      let stripeEventCount = 0;
      for (let i = 0; i < 10 && stripeEventCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 300));
        stripeEventCount = await countStripeEvent(eventId);
      }
      expect(stripeEventCount, "StripeEvent row must exist").toBe(1);

      const updated = await findSessionByStripeSubscriptionId(subId);
      expect(updated?.billingStatus, "billingStatus must be DELINQUENT").toBe("DELINQUENT");

      // Gate must be denied.
      const gateRes = await postDriverOpenGate(request, session.id, {
        driverId: driver.id,
        direction: "ENTRANCE",
        scanContext: "fresh",
      });
      const body = gateRes.data;
      expect(body.ok, `Gate must be denied: ${JSON.stringify(body)}`).toBe(false);
      expect(
        (body as { ok: false; denial: { code: string } }).denial?.code,
        "denial code must be SUBSCRIPTION_DELINQUENT",
      ).toBe("SUBSCRIPTION_DELINQUENT");
      expect(await countAudit("GATE_DENIED", session.id), "GATE_DENIED must be logged").toBe(1);
      expect(await countAudit("GATE_OPEN", session.id), "no GATE_OPEN").toBe(0);

      const after = await getSessionEvidenceSnapshot(session.id);
      await writeEvidenceReport(testInfo, {
        scenarioId: "DELINQ-013",
        objective: "A subscription.deleted with cancellation_details.reason=payment_failed is the only signal that marks billingStatus=DELINQUENT and denies gate access.",
        expectedChanges: [
          "Session.billingStatus becomes DELINQUENT.",
          "Session.expectedEnd clamped to now.",
          "Gate denied with SUBSCRIPTION_DELINQUENT.",
          "GATE_DENIED audited.",
        ],
        actions: [
          { label: "Seed monthly session", data: { sessionId: session.id, subscriptionId: subId } },
          { label: "POST subscription.deleted with reason=payment_failed", data: { eventId } },
          { label: "POST open-gate ENTRANCE", data: body },
        ],
        before,
        after,
      });
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-014: payment_disputed subscription.deleted → DELINQUENT with dispute audit
// Dispute-driven cancellations must be logged distinctly from dunning failures.
// ---------------------------------------------------------------------------
test(
  "DELINQ-014: payment_disputed subscription.deleted marks DELINQUENT with dispute-specific audit",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();
      await setFailedPaymentPolicy("on_subscription_deleted");

      const subId = `sub_test_d14_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });
      const before = await getSessionEvidenceSnapshot(session.id);

      const eventId = await sendSubscriptionDeleted(request, subId, {
        cancellationReason: "payment_disputed",
      });

      let stripeEventCount = 0;
      for (let i = 0; i < 10 && stripeEventCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 300));
        stripeEventCount = await countStripeEvent(eventId);
      }
      expect(stripeEventCount, "StripeEvent row must exist").toBe(1);

      const updated = await findSessionByStripeSubscriptionId(subId);
      expect(updated?.billingStatus, "billingStatus must be DELINQUENT").toBe("DELINQUENT");

      const after = await getSessionEvidenceSnapshot(session.id);
      const cancelAudit = (after.auditLogs as Array<{ action: string; details: string }>).find(
        (a) => a.action === "SUBSCRIPTION_CANCELED",
      );
      expect(
        cancelAudit?.details,
        "audit details must mention dispute, not generic dunning",
      ).toMatch(/dispute/i);
      expect(
        cancelAudit?.details,
        "audit details must NOT say 'dunning exhausted'",
      ).not.toMatch(/dunning exhausted/i);

      await writeEvidenceReport(testInfo, {
        scenarioId: "DELINQ-014",
        objective: "Payment-dispute-driven subscription deletion is logged distinctly from dunning failures so admins know to review the dispute in Stripe rather than contact the driver about a late payment.",
        expectedChanges: [
          "Session.billingStatus becomes DELINQUENT.",
          "AuditLog SUBSCRIPTION_CANCELED details mention 'dispute', not 'dunning exhausted'.",
        ],
        actions: [
          { label: "Seed monthly session", data: { sessionId: session.id, subscriptionId: subId } },
          { label: "POST subscription.deleted with reason=payment_disputed", data: { eventId } },
        ],
        before,
        after,
      });
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-015: cancellation_requested + expectedEnd still future → stays ACTIVE
// Stripe may fire subscription.deleted with reason=cancellation_requested before
// the paid-through period ends (e.g. admin cancelled via Stripe dashboard directly).
// The session should remain ACTIVE until its expectedEnd.
// ---------------------------------------------------------------------------
test(
  "DELINQ-015: cancellation_requested with future expectedEnd leaves session ACTIVE",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();
      await setFailedPaymentPolicy("on_subscription_deleted");

      const subId = `sub_test_d15_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // expectedEnd is 30 days from now (seeded default) — access window still open.
      const eventId = await sendSubscriptionDeleted(request, subId, {
        cancellationReason: "cancellation_requested",
      });

      let stripeEventCount = 0;
      for (let i = 0; i < 10 && stripeEventCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 300));
        stripeEventCount = await countStripeEvent(eventId);
      }
      expect(stripeEventCount, "StripeEvent row must exist").toBe(1);

      const updated = await findSessionByStripeSubscriptionId(subId);
      expect(updated?.status, "session must remain ACTIVE — access window is still open").toBe("ACTIVE");
      expect(updated?.billingStatus, "billingStatus must not become DELINQUENT").not.toBe("DELINQUENT");
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-016: already-COMPLETED session + payment_failed deletion → no mutation
// Protects against retroactively marking a closed session DELINQUENT.
// ---------------------------------------------------------------------------
test(
  "DELINQ-016: already-COMPLETED session is not mutated by payment_failed subscription.deleted",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);

    try {
      await resetDb();
      await setFailedPaymentPolicy("on_subscription_deleted");

      const subId = `sub_test_d16_${world.testRun.testRunId.replace(/-/g, "_").slice(0, 12)}`;
      const { session } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // Pre-close the session (e.g. driver paid overstay and exited before Stripe fires).
      await setSessionStatus(session.id, "COMPLETED");

      const eventId = await sendSubscriptionDeleted(request, subId, {
        cancellationReason: "payment_failed",
      });

      let stripeEventCount = 0;
      for (let i = 0; i < 10 && stripeEventCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 300));
        stripeEventCount = await countStripeEvent(eventId);
      }
      expect(stripeEventCount, "StripeEvent row must exist — proves webhook ran").toBe(1);

      const updated = await findSessionByStripeSubscriptionId(subId);
      expect(updated?.status, "session must remain COMPLETED").toBe("COMPLETED");
      expect(updated?.billingStatus, "billingStatus must not become DELINQUENT").not.toBe("DELINQUENT");
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-017: fail-closed for legacy/corrupt PAYMENT_FAILED + null billingFailedAt
// ---------------------------------------------------------------------------
test(
  "DELINQ-017: policy after_grace_days — PAYMENT_FAILED with null billingFailedAt fails closed",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    try {
      await resetDb();
      await setFailedPaymentPolicy("after_grace_days", 1);

      const { session } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: `sub_test_d17_${world.testRun.testRunId.slice(0, 8)}`,
      });

      // Simulate a legacy/corrupt row: PAYMENT_FAILED status but billingFailedAt = NULL.
      // This mirrors a row written before the column existed or a partial webhook write.
      // isAccessBlocked must fail closed — granting indefinite access is the unsafe default.
      await setBillingPaymentFailedWithNullTimestamp(session.id);

      const gateRes = await postDriverOpenGate(request, session.id, {
        driverId: session.driverId,
        direction: "ENTRANCE",
        scanContext: "fresh",
      });

      expect(gateRes.status, "open-gate must return 200").toBe(200);
      const body = gateRes.data as { ok: boolean; denial?: { code: string } };
      expect(body.ok, `Gate must block when billingFailedAt is null under after_grace_days policy: ${JSON.stringify(body)}`).toBe(false);
      expect(body.denial?.code).toBe("SUBSCRIPTION_DELINQUENT");
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-018: unknown-reason subscription.deleted writes [SUB_DEL:UNKNOWN] audit
// ---------------------------------------------------------------------------
test(
  "DELINQ-018: unknown-reason subscription.deleted writes [SUB_DEL:UNKNOWN] audit prefix",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    try {
      await resetDb();
      await setFailedPaymentPolicy("on_subscription_deleted");

      const subId = `sub_test_d18_${world.testRun.testRunId.slice(0, 8)}`;
      const { session } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      // No reason, no cancel_at, no admin flag, no billingFailedAt — classifier returns
      // "unknown". Must NOT auto-DELINQUENT but MUST emit an audit with the stable
      // [SUB_DEL:UNKNOWN] prefix so the needs-review feed can surface it.
      const eventId = await sendSubscriptionDeleted(request, subId, { cancellationReason: null });

      let stripeEventCount = 0;
      for (let i = 0; i < 10 && stripeEventCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 300));
        stripeEventCount = await countStripeEvent(eventId);
      }
      expect(stripeEventCount, "StripeEvent row must exist — proves webhook ran").toBe(1);

      const updated = await findSessionByStripeSubscriptionId(subId);
      expect(updated?.billingStatus, "billingStatus must NOT be DELINQUENT for unknown reason").not.toBe("DELINQUENT");

      const audit = await readLatestSubscriptionCanceledAudit(session.id);
      expect(audit, "SUBSCRIPTION_CANCELED audit row must exist").not.toBeNull();
      expect(audit?.details ?? "", "audit detail must start with stable [SUB_DEL:UNKNOWN] prefix").toMatch(/^\[SUB_DEL:UNKNOWN\]/);
    } finally {
      await world.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// DELINQ-019: unknown-reason deletion appears as SUBSCRIPTION_DELETION_UNKNOWN
//             item in /api/admin/reconcile/needs-review
// ---------------------------------------------------------------------------
test(
  "DELINQ-019: unknown-reason deletion appears as SUBSCRIPTION_DELETION_UNKNOWN needs-review item",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    try {
      await resetDb();
      await setFailedPaymentPolicy("on_subscription_deleted");

      const subId = `sub_test_d19_${world.testRun.testRunId.slice(0, 8)}`;
      const { session } = await seedMonthlyActiveSession({
        testRun: world.testRun,
        stripeSubscriptionId: subId,
      });

      const eventId = await sendSubscriptionDeleted(request, subId, { cancellationReason: null });

      let stripeEventCount = 0;
      for (let i = 0; i < 10 && stripeEventCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 300));
        stripeEventCount = await countStripeEvent(eventId);
      }
      expect(stripeEventCount).toBe(1);

      await authenticateAdmin(request);
      const reviewRes = await getNeedsReview(request, { severity: "critical", limit: 200 });
      expect(reviewRes.status, "needs-review must return 200").toBe(200);

      const unknownItems = (reviewRes.data?.items ?? []).filter(
        (it) => it.code === "SUBSCRIPTION_DELETION_UNKNOWN" && it.related.sessionId === session.id,
      );
      expect(unknownItems.length, `needs-review must surface SUBSCRIPTION_DELETION_UNKNOWN for session ${session.id}: ${JSON.stringify(reviewRes.data?.items)}`).toBe(1);
      expect(unknownItems[0].severity).toBe("critical");
    } finally {
      await world.cleanup();
    }
  },
);
