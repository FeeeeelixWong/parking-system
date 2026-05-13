/**
 * Hard guards for demo scenario factory.
 * Call checkBaseGuards() at startup. Call checkStripeGuard() for Stripe scenarios.
 * Call checkQbGuard() for QB scenarios.
 */

export function checkBaseGuards(): void {
  if (process.env.ALLOW_DEMO_SCENARIOS !== "true") {
    bail(
      "ALLOW_DEMO_SCENARIOS is not set to 'true'.\n" +
      "  Add ALLOW_DEMO_SCENARIOS=true to your .env or environment before running demo scenarios.",
    );
  }

  const demoDb = process.env.DEMO_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!demoDb) {
    bail(
      "Neither DEMO_DATABASE_URL nor TEST_DATABASE_URL is set.\n" +
      "  Set one of these to point at a test/sandbox database, not your production database.",
    );
  }

  const prodDb = process.env.DATABASE_URL;
  if (
    prodDb &&
    prodDb !== demoDb &&
    !process.env.DEMO_DATABASE_URL
  ) {
    bail(
      "DATABASE_URL differs from TEST_DATABASE_URL and DEMO_DATABASE_URL is not set.\n" +
      "  Either set DEMO_DATABASE_URL explicitly, or ensure DATABASE_URL === TEST_DATABASE_URL.",
    );
  }
}

export function checkStripeGuard(): void {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    bail(
      "STRIPE_SECRET_KEY is not set.\n" +
      "  Set a Stripe test-mode secret key (sk_test_...) to run Stripe-backed scenarios.",
    );
  }
  if (!key.startsWith("sk_test_")) {
    bail(
      "STRIPE_SECRET_KEY does not start with sk_test_.\n" +
      "  Demo scenarios require a Stripe test-mode key, not a live key.",
    );
  }
}

export async function checkQbGuard(): Promise<void> {
  const { isQbConfigured, pingQbCompanyInfo } = await import("./qb-helper.js");

  if (process.env.NODE_ENV === "production" && !process.env.PLAYWRIGHT_TEST) {
    bail(
      "QB guard: NODE_ENV is 'production' without PLAYWRIGHT_TEST.\n" +
      "  Demo scenarios must run in sandbox/test mode, not production.",
    );
  }

  const configured = await isQbConfigured();
  if (!configured) {
    console.warn(
      "  [QB] QuickBooks is not configured in this database (no tokens in Settings).\n" +
      "  QB scenarios will use synthetic receipt IDs. Connect QB in Admin → Settings for real receipts.",
    );
    return;
  }

  const alive = await pingQbCompanyInfo();
  if (!alive) {
    console.warn(
      "  [QB] QuickBooks companyinfo ping failed — tokens may be expired.\n" +
      "  QB scenarios will use synthetic receipt IDs.",
    );
  }
}

function bail(message: string): never {
  console.error(`\n✗ Guard failed: ${message}\n`);
  process.exit(1);
}
