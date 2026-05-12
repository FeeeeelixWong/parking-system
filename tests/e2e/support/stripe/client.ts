import Stripe from "stripe";
import { getE2EEnv } from "../env";

let _client: Stripe | null = null;

/**
 * Returns a Stripe test-mode client. Throws if E2E Stripe keys are not
 * configured — call `getE2EEnv().stripe !== null` to guard before using this.
 */
export function getE2EStripe(): Stripe {
  if (_client) return _client;
  const { stripe } = getE2EEnv();
  if (!stripe) {
    throw new Error(
      "Stripe E2E keys are not configured. Set E2E_STRIPE_SECRET_KEY, " +
      "and E2E_STRIPE_PUBLISHABLE_KEY in .env.e2e.local.",
    );
  }
  _client = new Stripe(stripe.secretKey, {
    apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion,
  });
  return _client;
}
