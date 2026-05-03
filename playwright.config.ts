import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Load .env.local so TEST_DATABASE_URL is available when running via npm scripts
// without needing dotenv-cli or manual env injection.
loadEnv({ path: ".env.local" });

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
          AUTH_SECRET:
            process.env.AUTH_SECRET ??
            "playwright-test-auth-secret-at-least-32-characters",
          ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "playwright-admin",
        },
      }
    : undefined,
});
