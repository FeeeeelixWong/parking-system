import type { TestInfo } from "@playwright/test";
import { createTestRun, type TestRun } from "./test-run";
import { getE2EEnv, type E2EEnv } from "./env";
import * as dbModule from "./db";
import { getE2EStripe } from "./stripe/client";
import { cleanupStripeTestRun } from "./stripe/cleanup";
import { qbFetch, isQbConfigured } from "./quickbooks/client";
import type Stripe from "stripe";

/** Typed facade over the db support module. Re-exported so callers don't need
 *  to import db.ts separately when they already have a World. */
export type DbFacade = typeof dbModule;

/** App connectivity info — base URL and helpers, no browser/Page coupling. */
export type AppInfo = {
  baseUrl: string;
};

export type World = {
  testRun: TestRun;
  env: E2EEnv;
  db: DbFacade;
  app: AppInfo;
  stripe: Stripe | null;
  qb: { fetch: typeof qbFetch; realmId: string } | null;
  cleanup: () => Promise<void>;
};

/**
 * Create a World — a single, coherent test context that carries IDs, env
 * config, and service facades for one test.
 *
 * Usage:
 *   const world = createWorld(testInfo);
 *   // ... run test ...
 *   await world.cleanup();
 *
 * Cleanup is best-effort and idempotent. DB cleanup is left to explicit
 * resetDb() calls so tests control isolation boundaries.
 */
export function createWorld(testInfo?: TestInfo): World {
  const testRun = createTestRun(testInfo);
  const env = getE2EEnv();

  const stripe: Stripe | null = env.stripe ? getE2EStripe() : null;

  const qb: World["qb"] = isQbConfigured() && env.qb
    ? { fetch: qbFetch, realmId: env.qb.realmId }
    : null;

  const app: AppInfo = {
    baseUrl: env.baseUrl,
  };

  const cleanup = async (): Promise<void> => {
    if (stripe && env.stripe) {
      await cleanupStripeTestRun(testRun.testRunId);
    }
  };

  return {
    testRun,
    env,
    db: dbModule,
    app,
    stripe,
    qb,
    cleanup,
  };
}
