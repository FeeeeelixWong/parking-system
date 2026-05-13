/**
 * SCENARIO: refund-missing-qb
 *
 * Completed daily session with a real Stripe charge + real Stripe refund.
 * QB Sales Receipt exists (or synthetic if QB not configured).
 * QB Refund Receipt is absent.
 * Expected Needs Review code: QB_REFUND_RECEIPT_MISSING.
 * The real Stripe refund ID means "Sync refund receipt" in the admin UI will work.
 */
import {
  getPrisma,
  findOrCreateDemoSpot,
  makePhone,
  daysAgo,
} from "../prisma-client.js";
import {
  createCustomer,
  createAndConfirmPaymentIntent,
  createRefund,
} from "../stripe-client.js";
import { qbWriteSalesReceipt } from "../qb-helper.js";
import type { ScenarioEntry } from "../manifest.js";

const SCENARIO = "refund-missing-qb";

export async function run(testRunId: string): Promise<ScenarioEntry> {
  const phone = makePhone();
  const driverName = `Demo ${SCENARIO} ${testRunId.slice(-4).toUpperCase()}`;
  const email = `demo_${SCENARIO}_${testRunId}@demo.test`;
  const amount = 60; // 2 days × $30
  const refundAmount = 30; // partial refund

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

  const stripeRefundId = await createRefund({
    chargeId,
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
      startedAt: daysAgo(6),
      expectedEnd: daysAgo(4),
      endedAt: daysAgo(4),
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
      status: "PARTIALLY_REFUNDED",
      stripePaymentIntentId: paymentIntentId,
      stripeChargeId: chargeId,
      qbSalesReceiptId,
      qbSalesReceiptAmount: amount,
      refundedAmount: refundAmount,
      refundedAt: daysAgo(3),
    },
  });

  const refund = await prisma.paymentRefund.create({
    data: {
      paymentId: payment.id,
      amount: refundAmount,
      stripeRefundId,
      // qbRefundReceiptId intentionally absent
    },
  });

  return {
    scenario: SCENARIO,
    driverPhone: phone,
    driverId: driver.id,
    vehicleId: vehicle.id,
    sessionId: session.id,
    paymentId: payment.id,
    refundId: refund.id,
    stripeCustomerId: stripeCustomer.id,
    stripePaymentIntentId: paymentIntentId,
    stripeChargeId: chargeId,
    stripeRefundId,
    qbSalesReceiptId,
    expectedNeedsReviewCodes: ["QB_REFUND_RECEIPT_MISSING"],
    suggestedAdminAction: "Sync refund receipt from Payments/Needs Review.",
  };
}
