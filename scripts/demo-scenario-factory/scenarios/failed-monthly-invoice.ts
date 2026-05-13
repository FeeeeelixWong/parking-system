/**
 * SCENARIO: failed-monthly-invoice
 *
 * Active monthly session with billingStatus=PAYMENT_FAILED and billingFailedAt
 * backdated 3 days ago. Real Stripe customer + subscription in test mode.
 * hostedInvoiceUrl is populated so "Open invoice" in Needs Review works.
 * Expected Needs Review code: SUBSCRIPTION_PAYMENT_FAILED.
 */
import {
  getPrisma,
  findOrCreateDemoSpot,
  makePhone,
  daysAgo,
  daysFromNow,
} from "../prisma-client.js";
import { createCustomer, createSubscription } from "../stripe-client.js";
import type { ScenarioEntry } from "../manifest.js";

const SCENARIO = "failed-monthly-invoice";

export async function run(testRunId: string): Promise<ScenarioEntry> {
  const phone = makePhone();
  const driverName = `Demo ${SCENARIO} ${testRunId.slice(-4).toUpperCase()}`;
  const email = `demo_${SCENARIO}_${testRunId}@demo.test`;
  const monthlyAmount = 400;

  const stripeCustomer = await createCustomer({
    testRunId,
    scenario: SCENARIO,
    email,
    name: driverName,
  });

  const { subscriptionId, invoiceId, hostedInvoiceUrl } = await createSubscription({
    customerId: stripeCustomer.id,
    testRunId,
    scenario: SCENARIO,
    unitAmount: monthlyAmount * 100,
  });

  const spotId = await findOrCreateDemoSpot();
  const prisma = await getPrisma();

  const driver = await prisma.driver.create({
    data: { name: driverName, phone, email },
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      driverId: driver.id,
      type: "TRUCK_TRAILER",
      unitNumber: `DMO-${testRunId.slice(-4).toUpperCase()}`,
    },
  });

  const session = await prisma.session.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      spotId,
      startedAt: daysAgo(30),
      expectedEnd: daysFromNow(0),
      status: "ACTIVE",
      billingStatus: "PAYMENT_FAILED",
      billingFailedAt: daysAgo(3),
    },
  });

  const payment = await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "MONTHLY_CHECKIN",
      amount: monthlyAmount,
      days: 30,
      status: "COMPLETED",
      stripeSubscriptionId: subscriptionId,
      stripeInvoiceId: invoiceId,
      hostedInvoiceUrl: hostedInvoiceUrl ?? undefined,
    },
  });

  return {
    scenario: SCENARIO,
    driverPhone: phone,
    driverId: driver.id,
    vehicleId: vehicle.id,
    sessionId: session.id,
    paymentId: payment.id,
    stripeCustomerId: stripeCustomer.id,
    stripeSubscriptionId: subscriptionId,
    stripeInvoiceId: invoiceId,
    expectedNeedsReviewCodes: ["SUBSCRIPTION_PAYMENT_FAILED"],
    suggestedAdminAction: "Contact driver to update payment method.",
  };
}
