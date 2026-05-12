import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { getNeedsReview } from "../app-api";
import type { NeedsReviewCode } from "../../../../src/types/reconcile";

type Related = {
  sessionId?: string;
  paymentId?: string;
  refundId?: string;
};

function matchesRelated(
  item: { related: Related },
  related?: Related,
): boolean {
  if (!related) return true;
  if (related.sessionId && item.related.sessionId !== related.sessionId) return false;
  if (related.paymentId && item.related.paymentId !== related.paymentId) return false;
  if (related.refundId && item.related.refundId !== related.refundId) return false;
  return true;
}

/**
 * Assert that at least one NeedsReview item exists with the given `code`.
 * Optionally narrow by `related` IDs.
 *
 * Calls GET /api/admin/reconcile/needs-review — requires admin auth on
 * the request context (call authenticateAdmin first).
 *
 * Does NOT recompute reconcile rules — asserts only on what the app returns.
 */
export async function expectNeedsReviewCode(
  request: APIRequestContext,
  code: NeedsReviewCode,
  related?: Related,
): Promise<void> {
  const result = await getNeedsReview(request, { limit: 200 });
  if (!result.ok) {
    throw new Error(
      `[assertions/reconcile] getNeedsReview returned ${result.status}`,
    );
  }
  const matches = result.data.items.filter(
    (item) => item.code === code && matchesRelated(item, related),
  );
  expect(
    matches.length,
    `Expected at least one NeedsReview item with code="${code}"${related ? ` related=${JSON.stringify(related)}` : ""}. ` +
    `Got codes: [${result.data.items.map((i) => i.code).join(", ")}]`,
  ).toBeGreaterThan(0);
}

/**
 * Assert that NO NeedsReview item exists with the given `code`.
 * Optionally narrow by `related` IDs.
 *
 * Calls GET /api/admin/reconcile/needs-review — requires admin auth.
 */
export async function expectNoNeedsReviewCode(
  request: APIRequestContext,
  code: NeedsReviewCode,
  related?: Related,
): Promise<void> {
  const result = await getNeedsReview(request, { limit: 200 });
  if (!result.ok) {
    throw new Error(
      `[assertions/reconcile] getNeedsReview returned ${result.status}`,
    );
  }
  const matches = result.data.items.filter(
    (item) => item.code === code && matchesRelated(item, related),
  );
  expect(
    matches.length,
    `Expected no NeedsReview item with code="${code}"${related ? ` related=${JSON.stringify(related)}` : ""}`,
  ).toBe(0);
}
