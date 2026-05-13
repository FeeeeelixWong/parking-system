import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  if (!key.startsWith("sk_test_")) {
    throw new Error(
      "STRIPE_SECRET_KEY must start with sk_test_ for demo scenarios. Set a test-mode key.",
    );
  }
  _stripe = new Stripe(key, {
    apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion,
  });
  return _stripe;
}

export async function createCustomer(opts: {
  testRunId: string;
  scenario: string;
  email: string;
  name: string;
}): Promise<Stripe.Customer> {
  const stripe = getStripe();
  return stripe.customers.create({
    email: opts.email,
    name: opts.name,
    metadata: {
      testRunId: opts.testRunId,
      scenario: opts.scenario,
      createdBy: "demo-scenario-factory",
    },
  });
}

export async function createAndConfirmPaymentIntent(opts: {
  customerId: string;
  amount: number;
  testRunId: string;
  scenario: string;
}): Promise<{ paymentIntentId: string; chargeId: string }> {
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.create({
    amount: Math.round(opts.amount * 100),
    currency: "usd",
    customer: opts.customerId,
    payment_method: "pm_card_visa",
    confirm: true,
    off_session: true,
    metadata: {
      testRunId: opts.testRunId,
      scenario: opts.scenario,
      createdBy: "demo-scenario-factory",
    },
  });
  if (pi.status !== "succeeded" || !pi.latest_charge) {
    throw new Error(`PaymentIntent did not succeed. Status: ${pi.status}`);
  }
  return {
    paymentIntentId: pi.id,
    chargeId: pi.latest_charge as string,
  };
}

export async function createRefund(opts: {
  chargeId: string;
  testRunId: string;
  scenario: string;
}): Promise<string> {
  const stripe = getStripe();
  const refund = await stripe.refunds.create({
    charge: opts.chargeId,
    metadata: {
      testRunId: opts.testRunId,
      scenario: opts.scenario,
      createdBy: "demo-scenario-factory",
    },
  });
  return refund.id;
}

export async function createSubscription(opts: {
  customerId: string;
  testRunId: string;
  scenario: string;
  unitAmount: number;
}): Promise<{ subscriptionId: string; invoiceId: string; hostedInvoiceUrl: string | null }> {
  const stripe = getStripe();

  const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: opts.customerId });
  await stripe.customers.update(opts.customerId, {
    invoice_settings: { default_payment_method: pm.id },
  });

  const product = await stripe.products.create({ name: "Monthly Parking" });
  const price = await stripe.prices.create({
    currency: "usd",
    unit_amount: opts.unitAmount,
    recurring: { interval: "month" },
    product: product.id,
  });

  const subscription = await stripe.subscriptions.create({
    customer: opts.customerId,
    items: [{ price: price.id }],
    expand: ["latest_invoice"],
    metadata: {
      testRunId: opts.testRunId,
      scenario: opts.scenario,
      createdBy: "demo-scenario-factory",
    },
  });

  const invoice = subscription.latest_invoice as Stripe.Invoice;
  return {
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
  };
}

export async function cancelSubscription(subscriptionId: string): Promise<void> {
  const stripe = getStripe();
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("resource_missing") ||
      msg.includes("already_canceled") ||
      msg.includes("already been canceled") ||
      msg.includes("No such subscription")
    ) {
      return;
    }
    throw err;
  }
}

export async function deleteCustomer(customerId: string): Promise<void> {
  const stripe = getStripe();
  try {
    await stripe.customers.del(customerId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("resource_missing") || msg.includes("No such customer")) return;
    throw err;
  }
}
