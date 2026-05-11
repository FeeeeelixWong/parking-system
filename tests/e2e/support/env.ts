import { config as loadDotenv } from "dotenv";
import path from "node:path";

// Load in priority order: system env wins, then .env.local, then .env.e2e.local.
// playwright.config.ts already loads .env.local before tests run, so the
// repeated call below is a safe no-op for vars already in process.env.
// .env.e2e.local carries test-only secrets (Stripe test keys, test DB URL).
loadDotenv({ path: path.resolve(process.cwd(), ".env.local"), override: false });
loadDotenv({ path: path.resolve(process.cwd(), ".env.e2e.local"), override: false });

type StripeE2EConfig = {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string | null;
};

type QbE2EConfig = {
  clientId: string;
  clientSecret: string;
  realmId: string;
  accessToken: string;
  refreshToken: string;
};

export type E2EEnv = {
  testDatabaseUrl: string;
  baseUrl: string;
  stripe: StripeE2EConfig | null;
  qb: QbE2EConfig | null;
  testRunPrefix: string | null;
  appTimeOverride: string | null;
};

let _cached: E2EEnv | null = null;

/**
 * Returns validated E2E environment config. Lazy + memoized — safe to import
 * in any support module without crashing tests that don't need Stripe/QB.
 * Validation runs once on first call.
 */
export function getE2EEnv(): E2EEnv {
  if (_cached) return _cached;

  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is required for E2E tests. Set it in .env.e2e.local.",
    );
  }

  const stripeSecret = process.env.E2E_STRIPE_SECRET_KEY ?? null;
  const stripePublishable = process.env.E2E_STRIPE_PUBLISHABLE_KEY ?? null;
  const stripeWebhook = process.env.E2E_STRIPE_WEBHOOK_SECRET ?? null;

  if (stripeSecret && !stripeSecret.startsWith("sk_test_")) {
    throw new Error(
      "E2E_STRIPE_SECRET_KEY must start with 'sk_test_'. Never use live Stripe keys in tests.",
    );
  }
  if (stripePublishable && !stripePublishable.startsWith("pk_test_")) {
    throw new Error(
      "E2E_STRIPE_PUBLISHABLE_KEY must start with 'pk_test_'. Never use live Stripe keys in tests.",
    );
  }

  const stripe: StripeE2EConfig | null =
    stripeSecret && stripePublishable
      ? { secretKey: stripeSecret, publishableKey: stripePublishable, webhookSecret: stripeWebhook }
      : null;

  const qbClientId = process.env.E2E_QB_CLIENT_ID ?? null;
  const qbClientSecret = process.env.E2E_QB_CLIENT_SECRET ?? null;
  const qbRealmId = process.env.E2E_QB_REALM_ID ?? null;
  const qbAccessToken = process.env.E2E_QB_ACCESS_TOKEN ?? null;
  const qbRefreshToken = process.env.E2E_QB_REFRESH_TOKEN ?? null;

  const qb: QbE2EConfig | null =
    qbClientId && qbClientSecret && qbRealmId && qbAccessToken && qbRefreshToken
      ? { clientId: qbClientId, clientSecret: qbClientSecret, realmId: qbRealmId, accessToken: qbAccessToken, refreshToken: qbRefreshToken }
      : null;

  _cached = {
    testDatabaseUrl,
    baseUrl: process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3100"}`,
    stripe,
    qb,
    testRunPrefix: process.env.E2E_TEST_RUN_PREFIX ?? null,
    appTimeOverride: process.env.APP_TIME_OVERRIDE ?? null,
  };

  return _cached;
}
