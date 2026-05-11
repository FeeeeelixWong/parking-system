import type Stripe from "stripe";
import { getE2EStripe } from "./client";

/**
 * Reusable Stripe test payment method tokens.
 * These are Stripe's built-in test method IDs — no real card needed.
 */
export const TEST_PAYMENT_METHODS = {
  /** Visa that always succeeds. */
  VISA: "pm_card_visa",
  /** Card that always fails with a charge_failed error. */
  CHARGE_FAILS: "pm_card_chargeCustomerFail",
} as const;

/**
 * Create a Stripe Customer tagged with testRunId for cleanup.
 * Optionally attach to a test clock for time-travel scenarios.
 */
export async function createStripeCustomer(args: {
  testRunId: string;
  name: string;
  email: string;
  phone?: string;
  testClockId?: string;
}): Promise<Stripe.Customer> {
  const stripe = getE2EStripe();
  return stripe.customers.create({
    name: args.name,
    email: args.email,
    phone: args.phone,
    test_clock: args.testClockId,
    metadata: { testRunId: args.testRunId },
  });
}

/**
 * Attach a test payment method to a customer and set it as the default
 * invoice payment method. Returns the attached PaymentMethod.
 */
export async function attachTestPaymentMethod(args: {
  customerId: string;
  paymentMethodId: string;
}): Promise<Stripe.PaymentMethod> {
  const stripe = getE2EStripe();

  const pm = await stripe.paymentMethods.attach(args.paymentMethodId, {
    customer: args.customerId,
  });

  await stripe.customers.update(args.customerId, {
    invoice_settings: { default_payment_method: pm.id },
  });

  return pm;
}
