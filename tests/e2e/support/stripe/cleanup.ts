import { getE2EStripe } from "./client";
import { deleteStripeTestClock } from "./test-clocks";

/**
 * Cancel all active subscriptions whose metadata.testRunId matches.
 * Best-effort — errors are logged, not thrown.
 */
export async function cancelSubscriptionsForTestRun(testRunId: string): Promise<void> {
  const stripe = getE2EStripe();
  try {
    const result = await stripe.subscriptions.search({
      query: `metadata["testRunId"]:"${testRunId}"`,
      limit: 100,
    });
    await Promise.all(
      result.data.map((sub) =>
        stripe.subscriptions.cancel(sub.id).catch((err) => {
          console.error(`[e2e/stripe] Failed to cancel subscription ${sub.id}:`, err);
        }),
      ),
    );
  } catch (err) {
    console.error(`[e2e/stripe] cancelSubscriptionsForTestRun failed for ${testRunId}:`, err);
  }
}

/**
 * Delete all Stripe customers whose metadata.testRunId matches.
 * Best-effort — errors are logged per-customer, not thrown.
 *
 * Note: don't rely on Stripe Search to confirm deletion — the search index has
 * ~30s eventual consistency so "not found" in search ≠ actually deleted.
 */
export async function deleteCustomersForTestRun(testRunId: string): Promise<void> {
  const stripe = getE2EStripe();
  try {
    const result = await stripe.customers.search({
      query: `metadata["testRunId"]:"${testRunId}"`,
      limit: 100,
    });
    await Promise.all(
      result.data.map((customer) =>
        stripe.customers.del(customer.id).catch((err) => {
          console.error(`[e2e/stripe] Failed to delete customer ${customer.id}:`, err);
        }),
      ),
    );
  } catch (err) {
    console.error(`[e2e/stripe] deleteCustomersForTestRun failed for ${testRunId}:`, err);
  }
}

/**
 * Full Stripe cleanup for a test run.
 *
 * Order matters:
 *   1. Delete test clocks first — Stripe cascades and deletes all attached
 *      customers and their subscriptions automatically.
 *   2. Sweep any remaining customers by metadata (those not attached to a clock).
 *
 * Pass `clockIds` if the test created clocks — saves a search round-trip.
 * Best-effort — never throws, so test teardown always completes.
 */
export async function cleanupStripeTestRun(
  testRunId: string,
  clockIds?: string[],
): Promise<void> {
  if (clockIds && clockIds.length > 0) {
    await Promise.all(clockIds.map((id) => deleteStripeTestClock(id)));
  }

  // Sweep customers not attached to a clock (or if no clockIds were provided)
  await deleteCustomersForTestRun(testRunId);
}
