/**
 * SCENARIO: healthy-daily
 *
 * Completed daily session with a real Stripe charge and QB Sales Receipt
 * (synthetic if QB is not configured). No Needs Review codes expected.
 * Use as a baseline to confirm a clean session chain.
 */
import {
  getPrisma,
  findOrCreateDemoSpot,
  makePhone,
  daysAgo,
} from "../prisma-client.js";
import { createCustomer, createAndConfirmPaymentIntent } from "../stripe-client.js";
import { qbWriteSalesReceipt } from "../qb-helper.js";
import type { ScenarioEntry } from "../manifest.js";

const SCENARIO = "healthy-daily";

export async function run(testRunId: string): Promise<ScenarioEntry> {
  const phone = makePhone();
  const driverName = `Demo ${SCENARIO} ${testRunId.slice(-4).toUpperCase()}`;
  const email = `demo_${SCENARIO}_${testRunId}@demo.test`;
  const amount = 60; // 2 days × $30

  const stripeCustomer = await createCustomer({
    testRunId,
    scenario: SCENARIO,
    email,
    name: driverName,
  });

  const { paymentIntentId, chargeId } = await createAndConfirmPaymentIntent({
    customerId: stripeCustomer.id,
    amount,
    testRunId,
    scenario: SCENARIO,
  });

  const qbResult = await qbWriteSalesReceipt({
    driverName,
    driverPhone: phone,
    amount,
    testRunId,
    scenario: SCENARIO,
    stripeChargeId: chargeId,
  });
  const qbSalesReceiptId = qbResult?.qbSalesReceiptId ?? `qb_demo_${testRunId}`;

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
      startedAt: daysAgo(7),
      expectedEnd: daysAgo(5),
      endedAt: daysAgo(5),
      status: "COMPLETED",
      billingStatus: "CURRENT",
    },
  });

  const payment = await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "CHECKIN",
      amount,
      days: 2,
      status: "COMPLETED",
      stripePaymentIntentId: paymentIntentId,
      stripeChargeId: chargeId,
      qbSalesReceiptId,
      qbSalesReceiptAmount: amount,
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
    stripePaymentIntentId: paymentIntentId,
    stripeChargeId: chargeId,
    qbSalesReceiptId,
    expectedNeedsReviewCodes: [],
    suggestedAdminAction: "No action needed — use as baseline.",
  };
}
