import type Stripe from "stripe";
import { getE2EStripe } from "./client";

/**
 * Create a Stripe Test Clock for time-travel in subscription tests.
 * TestClock has no metadata field — testRunId is encoded in the name as
 * `e2e-{testRunId}` for cleanup identification.
 */
export async function createStripeTestClock(args: {
  testRunId: string;
  frozenTime?: Date;
}): Promise<Stripe.TestHelpers.TestClock> {
  const stripe = getE2EStripe();
  return stripe.testHelpers.testClocks.create({
    frozen_time: Math.floor((args.frozenTime ?? new Date()).getTime() / 1000),
    name: `e2e-${args.testRunId}`,
  });
}

/**
 * Advance a test clock to the given time and wait for it to finish advancing
 * (status transitions from "advancing" to "ready").
 */
export async function advanceStripeTestClock(args: {
  clockId: string;
  advanceTo: Date;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<void> {
  const stripe = getE2EStripe();
  const advanceToUnix = Math.floor(args.advanceTo.getTime() / 1000);

  await stripe.testHelpers.testClocks.advance(args.clockId, {
    frozen_time: advanceToUnix,
  });

  const interval = args.pollIntervalMs ?? 500;
  const deadline = Date.now() + (args.timeoutMs ?? 30_000);

  while (Date.now() < deadline) {
    const clock = await stripe.testHelpers.testClocks.retrieve(args.clockId);
    if (clock.status === "ready") return;
    if (clock.status === "internal_failure") {
      throw new Error(`[e2e/stripe] Test clock ${args.clockId} entered internal_failure`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(
    `[e2e/stripe] Test clock ${args.clockId} did not reach "ready" within ${args.timeoutMs ?? 30_000}ms`,
  );
}

/**
 * Delete a test clock. Best-effort — errors are logged, not thrown.
 * Deleting a clock cascades to all attached customers and their subscriptions.
 */
export async function deleteStripeTestClock(clockId: string): Promise<void> {
  const stripe = getE2EStripe();
  try {
    await stripe.testHelpers.testClocks.del(clockId);
  } catch (err) {
    console.error(`[e2e/stripe] Failed to delete test clock ${clockId}:`, err);
  }
}
