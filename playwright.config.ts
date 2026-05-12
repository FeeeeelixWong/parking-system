import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Load app defaults plus E2E-only secrets so the Playwright web server and
// test support use the same test DB/provider accounts.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.e2e.local", override: false });

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: testDatabaseUrl
    ? {
        command: `npx next build && npx next start -p ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        env: {
          ...process.env,
          DATABASE_URL: testDatabaseUrl,
          NEXT_PUBLIC_BASE_URL: baseURL,
          STRIPE_SECRET_KEY:
            process.env.E2E_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY ?? "",
          NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
            process.env.E2E_STRIPE_PUBLISHABLE_KEY ??
            process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ??
            "",
          STRIPE_WEBHOOK_SECRET:
            process.env.E2E_STRIPE_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET ?? "",
          QB_CLIENT_ID: process.env.E2E_QB_CLIENT_ID ?? process.env.QB_CLIENT_ID ?? "",
          QB_CLIENT_SECRET:
            process.env.E2E_QB_CLIENT_SECRET ?? process.env.QB_CLIENT_SECRET ?? "",
          AUTH_SECRET:
            process.env.AUTH_SECRET ??
            "playwright-test-auth-secret-at-least-32-characters",
          ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "playwright-admin",
          PLAYWRIGHT_TEST: "true",
        },
      }
    : undefined,
});
