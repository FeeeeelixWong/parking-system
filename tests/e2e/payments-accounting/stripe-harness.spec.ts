import { expect, test } from "@playwright/test";
import { getE2EEnv } from "../support/env";
import { getE2EStripe } from "../support/stripe/client";
import { createStripeTestClock, deleteStripeTestClock } from "../support/stripe/test-clocks";
import { createStripeCustomer } from "../support/stripe/customers";
import { cleanupStripeTestRun } from "../support/stripe/cleanup";
import { createWorld } from "../support/world";

test.skip(
  !getE2EEnv().stripe,
  "Set E2E_STRIPE_SECRET_KEY and E2E_STRIPE_PUBLISHABLE_KEY to run Stripe harness tests.",
);

// ---------------------------------------------------------------------------
// STRIPE-HARNESS-001: connectivity — can reach Stripe test mode
// ---------------------------------------------------------------------------

test("STRIPE-HARNESS-001: Stripe test-mode client can list balance transactions", async (
  {},
  testInfo,
) => {
  const world = createWorld(testInfo);
  const stripe = getE2EStripe();

  // Balance transactions list is always available in test mode, even with no data.
  const result = await stripe.balanceTransactions.list({ limit: 1 });
  expect(result.object).toBe("list");

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// STRIPE-HARNESS-002: test clock lifecycle — create, retrieve, delete
// ---------------------------------------------------------------------------

test("STRIPE-HARNESS-002: can create and delete a test clock", async ({}, testInfo) => {
  const world = createWorld(testInfo);
  const clockIds: string[] = [];

  try {
    const frozenTime = new Date("2025-01-01T00:00:00Z");
    const clock = await createStripeTestClock({
      testRunId: world.testRun.testRunId,
      frozenTime,
    });

    clockIds.push(clock.id);

    // ── Clock contract ────────────────────────────────────────────────────────
    expect(clock.object).toBe("test_helpers.test_clock");
    expect(clock.name).toBe(`e2e-${world.testRun.testRunId}`);
    expect(clock.frozen_time).toBe(Math.floor(frozenTime.getTime() / 1000));
    expect(clock.status).toBe("ready");
  } finally {
    await cleanupStripeTestRun(world.testRun.testRunId, clockIds);
  }
});

// ---------------------------------------------------------------------------
// STRIPE-HARNESS-003: customer creation — metadata.testRunId round-trips
// ---------------------------------------------------------------------------

test("STRIPE-HARNESS-003: can create a customer with testRunId metadata", async (
  {},
  testInfo,
) => {
  const world = createWorld(testInfo);

  try {
    const customer = await createStripeCustomer({
      testRunId: world.testRun.testRunId,
      name: "E2E Test Driver",
      email: `e2e+${world.testRun.testRunId}@example.com`,
    });

    // ── Customer contract ─────────────────────────────────────────────────────
    expect(customer.object).toBe("customer");
    expect(customer.metadata.testRunId).toBe(world.testRun.testRunId);
    expect(customer.name).toBe("E2E Test Driver");
  } finally {
    await cleanupStripeTestRun(world.testRun.testRunId);
  }
});

// ---------------------------------------------------------------------------
// STRIPE-HARNESS-004: deleteStripeTestClock cascades — customer gone after delete
// ---------------------------------------------------------------------------

test("STRIPE-HARNESS-004: deleting a test clock cascades to its attached customer", async (
  {},
  testInfo,
) => {
  const world = createWorld(testInfo);
  const stripe = getE2EStripe();

  const clock = await createStripeTestClock({ testRunId: world.testRun.testRunId });

  const customer = await createStripeCustomer({
    testRunId: world.testRun.testRunId,
    name: "Cascade Test Driver",
    email: `cascade+${world.testRun.testRunId}@example.com`,
    testClockId: clock.id,
  });

  // Verify customer exists before delete
  const before = await stripe.customers.retrieve(customer.id);
  expect(before.id).toBe(customer.id);

  // Delete clock — should cascade
  await deleteStripeTestClock(clock.id);

  // Customer should now be deleted (retrieve returns deleted:true object)
  const after = await stripe.customers.retrieve(customer.id);
  // Stripe returns the deleted customer object rather than 404
  expect((after as { deleted?: boolean }).deleted).toBe(true);
});
