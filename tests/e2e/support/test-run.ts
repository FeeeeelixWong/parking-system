import { v4 as uuidv4 } from "uuid";
import type { TestInfo } from "@playwright/test";

export type TestRun = {
  /** Stable ID for this test run, embedded in queryable DB fields for cleanup. */
  testRunId: string;
  /** Unique driver name scoped to this test run. */
  driverName: (label?: string) => string;
  /** Unique driver email that embeds testRunId for DB cleanup queries. */
  driverEmail: (label?: string) => string;
  /**
   * Stable unique phone number for this test run + index.
   * Phone is derived from testRunId hash + index so parallel test runs never
   * collide on the unique-phone DB constraint.
   */
  driverPhone: (index?: number) => string;
  /** Metadata object to attach to Stripe objects and DB rows. */
  metadata: (extra?: Record<string, string>) => Record<string, string>;
  /** Stable reference string embedding testRunId — for Payment.legacyQbReference etc. */
  reference: (label: string) => string;
};

/**
 * Derive a 4-digit number from a hex string (e.g. first 8 chars of a UUID).
 * Used to build per-run phone prefixes that won't collide across parallel runs.
 */
function hashToFourDigits(hex: string): string {
  const n = parseInt(hex.slice(0, 8), 16) % 10000;
  return String(n).padStart(4, "0");
}

/**
 * Create a TestRun scoped to a single test. Call once in the test body or
 * beforeEach. Optionally pass Playwright's `testInfo` for richer naming.
 *
 * The testRunId is embedded into Driver.email and Payment.legacyQbReference
 * so cleanup queries can find all rows this run created with:
 *   WHERE email LIKE '%e2e_<id>%'
 */
export function createTestRun(testInfo?: TestInfo): TestRun {
  const uuid = uuidv4();
  const shortId = uuid.replace(/-/g, "").slice(0, 8);
  const timestamp = Date.now();
  const testRunId = `e2e_${timestamp}_${shortId}`;

  // 4-digit hash derived from the uuid hex chars — stable across the run,
  // unique enough across parallel workers to avoid phone-unique collisions.
  const phoneHash = hashToFourDigits(shortId);

  const driverName = (label?: string): string => {
    const suffix = label ? ` (${label})` : "";
    const testName = testInfo?.title ? ` — ${testInfo.title.slice(0, 30)}` : "";
    return `E2E Driver${testName}${suffix}`;
  };

  const driverEmail = (label?: string): string => {
    const tag = label ? `_${label}` : "";
    return `driver${tag}+${testRunId}@example.test`;
  };

  const driverPhone = (index = 0): string => {
    // Format: 555 + 4-digit run hash + 3-digit index = 10 digits
    const idx = String(index).padStart(3, "0");
    return `555${phoneHash}${idx}`;
  };

  const metadata = (extra?: Record<string, string>): Record<string, string> => ({
    testRunId,
    ...extra,
  });

  const reference = (label: string): string => `${label}:${testRunId}`;

  return { testRunId, driverName, driverEmail, driverPhone, metadata, reference };
}
