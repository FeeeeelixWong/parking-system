/**
 * Stripe SDK wrapper.
 *
 * Stripe is the money-movement layer: PaymentIntents for one-time charges,
 * Subscriptions for monthly recurring, Customers as the card vault, Refunds
 * for returns. QuickBooks is the accounting output only (see quickbooks.ts).
 *
 * Our DB `Payment` table is the source of truth — every event arrives via
 * a signed webhook (`/api/stripe/webhook`) and writes/updates the row. We
 * never poll Stripe for state except on the admin reconciliation path.
 */
import Stripe from "stripe";
import { prisma } from "./prisma";

export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeConfigError";
  }
}

let _client: Stripe | null = null;

/**
 * Singleton Stripe client. Lazily instantiated so routes that never touch
 * Stripe (e.g. gate, audit) don't boot the SDK.
 */
export function getStripe(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeConfigError("STRIPE_SECRET_KEY not configured");
  _client = new Stripe(key, {
    // Pin the API version so Stripe-side changes don't silently alter response
    // shapes. Bump deliberately after reviewing the changelog.
    apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion,
  });
  return _client;
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

// ---------------------------------------------------------------------------
// Customer lookup / creation
// ---------------------------------------------------------------------------

/**
 * Resolve a Stripe customer for a driver. Caches the ID on Driver.stripeCustomerId
 * so subsequent checkouts don't round-trip to Stripe. Safe to call repeatedly.
 *
 * Called from:
 *   - checkout creation (needs customer for subscription mode)
 *   - webhook handlers (after customer.created, ensure the link exists)
 */
export async function getOrCreateStripeCustomer(driver: {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  stripeCustomerId: string | null;
}): Promise<string> {
  if (driver.stripeCustomerId) return driver.stripeCustomerId;
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    name: driver.name,
    phone: driver.phone,
    email: driver.email ?? undefined,
    metadata: { driverId: driver.id },
  });
  await prisma.driver.update({
    where: { id: driver.id },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

// ---------------------------------------------------------------------------
// Checkout session creation — one route wraps both one-time and subscription
// ---------------------------------------------------------------------------

/**
 * Arguments shared by payment and subscription Checkout creation. The metadata
 * payload is echoed back on webhook events via `payment_intent.metadata` and
 * `subscription.metadata` — we rely on `driverId`, `sessionPurpose`
 * (CHECKIN | MONTHLY_CHECKIN | EXTENSION | OVERSTAY), and `vehicleId` to wire
 * the resulting Payment row to a Session.
 */
type CheckoutMetadata = {
  driverId: string;
  vehicleId?: string;
  sessionPurpose: "CHECKIN" | "MONTHLY_CHECKIN" | "EXTENSION" | "OVERSTAY";
  sessionId?: string;
  days?: string;
  months?: string;
  termsVersion?: string;
  overstayAuthorized?: string;
};

/**
 * One-time payment — check-in (hourly), extension, overstay settlement.
 *
 * Returns Checkout session URL to redirect the driver to. On successful
 * payment Stripe redirects to successUrl with `?cs={CHECKOUT_SESSION_ID}`
 * which `/payment-complete` uses to look up the Payment row written by the
 * webhook.
 */
export async function createPaymentCheckoutSession(args: {
  amount: number; // dollars
  description: string;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  metadata: CheckoutMetadata;
}): Promise<{ checkoutUrl: string; checkoutSessionId: string }> {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: args.customerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(args.amount * 100),
          product_data: { name: args.description },
        },
      },
    ],
    // Attach metadata at the PaymentIntent level so webhook handlers see it
    // on payment_intent.succeeded without needing a second Stripe fetch.
    payment_intent_data: { metadata: args.metadata },
    metadata: args.metadata,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });
  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }
  return { checkoutUrl: session.url, checkoutSessionId: session.id };
}

/**
 * Monthly subscription — MONTHLY_CHECKIN path.
 *
 * Uses price_data inline so we don't need pre-created Stripe Prices for every
 * vehicleType × rate combination. Stripe generates an invoice immediately for
 * the first month; subsequent renewals fire `invoice.payment_succeeded`
 * webhooks our handler mirrors to `Payment` rows + QB Sales Receipts.
 */
export async function createSubscriptionCheckoutSession(args: {
  monthlyAmount: number; // dollars per month
  productName: string;
  customerId: string;
  months: number;
  successUrl: string;
  cancelUrl: string;
  metadata: CheckoutMetadata;
}): Promise<{ checkoutUrl: string; checkoutSessionId: string }> {
  const stripe = getStripe();

  // Build the end date string for the custom_text message.
  const endDate = new Date();
  endDate.setMonth(endDate.getMonth() + args.months);
  const endDateStr = endDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: args.customerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(args.monthlyAmount * 100),
          recurring: { interval: "month" },
          // End date in the product name — rendered large next to the price,
          // the most prominent location Stripe's hosted Checkout exposes.
          product_data: {
            name: `${args.productName} — ${args.months} month${args.months > 1 ? "s" : ""} (ends ${endDateStr})`,
          },
        },
      },
    ],
    // Reinforce the end date in smaller print below the Subscribe button.
    custom_text: {
      submit: {
        message: `This subscription ends on ${endDateStr} and will not renew after that date.`,
      },
    } as Stripe.Checkout.SessionCreateParams["custom_text"],
    // Echo metadata onto the Subscription object itself so future renewals
    // (which fire invoice.payment_succeeded with a subscription ref) can look
    // up the original driver/vehicle without re-reading Checkout.
    subscription_data: { metadata: args.metadata },
    metadata: args.metadata,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });
  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }
  return { checkoutUrl: session.url, checkoutSessionId: session.id };
}

// ---------------------------------------------------------------------------
// Refunds — admin-initiated, webhook mirrors to QB
// ---------------------------------------------------------------------------

/**
 * Refund a Stripe PaymentIntent. Full refund if `amount` omitted. Does NOT
 * update our Payment row — the `charge.refunded` webhook handler writes the
 * `stripeRefundId` / `refundedAmount` / `refundedAt` fields and writes the
 * QB Refund Receipt. This separation keeps our DB writes idempotent and
 * driven by signed Stripe events.
 */
export async function refundPaymentIntent(args: {
  paymentIntentId: string;
  amount?: number; // dollars; omitted = full refund
  reason?: string;
  idempotencyKey?: string;
}): Promise<Stripe.Refund> {
  const stripe = getStripe();
  return stripe.refunds.create(
    {
      payment_intent: args.paymentIntentId,
      amount: args.amount != null ? Math.round(args.amount * 100) : undefined,
      reason: args.reason as Stripe.RefundCreateParams.Reason | undefined,
    },
    args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined,
  );
}

// ---------------------------------------------------------------------------
// Read helpers (reconciliation + lookup — not for state-of-record writes)
// ---------------------------------------------------------------------------

export async function retrieveCheckoutSession(sessionId: string) {
  return getStripe().checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent", "subscription"],
  });
}

export async function listRecentCharges(sinceDaysAgo: number): Promise<Stripe.Charge[]> {
  const stripe = getStripe();
  const since = Math.floor((Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000) / 1000);
  const charges: Stripe.Charge[] = [];
  // Paginate — auto-pagination is ideal but explicit is simpler and
  // bounded by the time filter.
  let startingAfter: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await stripe.charges.list({
      created: { gte: since },
      limit: 100,
      starting_after: startingAfter,
    });
    charges.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1]?.id;
  }
  return charges;
}

export async function listRecentRefunds(sinceDaysAgo: number): Promise<Stripe.Refund[]> {
  const stripe = getStripe();
  const since = Math.floor((Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000) / 1000);
  const refunds: Stripe.Refund[] = [];
  let startingAfter: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await stripe.refunds.list({
      created: { gte: since },
      limit: 100,
      starting_after: startingAfter,
    });
    refunds.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1]?.id;
  }
  return refunds;
}

/**
 * Verify a Stripe webhook signature and parse the event. Throws if signature
 * is invalid (forged or misconfigured) — caller should return 400 in that
 * case so Stripe's retry logic treats it as a client error.
 */
export function constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new StripeConfigError("STRIPE_WEBHOOK_SECRET not configured");
  return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}
