/**
 * SCENARIO: missing-qb-receipt
 *
 * Completed daily session with a real Stripe charge but no QB Sales Receipt.
 * Expected Needs Review code: QB_RECEIPT_MISSING.
 * The real Stripe charge ID means "Sync QB receipt" in the admin UI will work.
 */
import {
  getPrisma,
  findOrCreateDemoSpot,
  makePhone,
  daysAgo,
} from "../prisma-client.js";
import { createCustomer, createAndConfirmPaymentIntent } from "../stripe-client.js";
import type { ScenarioEntry } from "../manifest.js";

const SCENARIO = "missing-qb-receipt";

export async function run(testRunId: string): Promise<ScenarioEntry> {
  const phone = makePhone();
  const driverName = `Demo ${SCENARIO} ${testRunId.slice(-4).toUpperCase()}`;
  const email = `demo_${SCENARIO}_${testRunId}@demo.test`;
  const amount = 90; // 3 days × $30

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
      startedAt: daysAgo(5),
      expectedEnd: daysAgo(2),
      endedAt: daysAgo(2),
      status: "COMPLETED",
      billingStatus: "CURRENT",
    },
  });

  const payment = await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "CHECKIN",
      amount,
      days: 3,
      status: "COMPLETED",
      stripePaymentIntentId: paymentIntentId,
      stripeChargeId: chargeId,
      // qbSalesReceiptId intentionally absent
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
    expectedNeedsReviewCodes: ["QB_RECEIPT_MISSING"],
    suggestedAdminAction: "Sync QB receipts from the Payments tab.",
  };
}
