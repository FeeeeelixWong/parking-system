import { test, expect } from "@playwright/test";
import { createWorld } from "../support/world";
import { disconnectDb, resetDb, seedPaymentRefundWithoutQb } from "../support/db";
import { authenticateAdmin, getNeedsReview } from "../support/app-api";
import { seedPaidDailyActiveSession } from "../support/scenarios/daily";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed reconcile action contract tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// ACTION-001: QB_RECEIPT_MISSING item carries server-authored action fields
//
// The backend must own actionPath/actionLabel/actionMethod so the UI never
// has to infer them from issue code.
// ---------------------------------------------------------------------------

test("ACTION-001: QB_RECEIPT_MISSING item has server-authored actionPath, actionLabel, actionMethod", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  const { payment } = await seedPaidDailyActiveSession(world);

  await authenticateAdmin(request);

  const result = await getNeedsReview(request, { limit: 200 });
  expect(result.ok).toBe(true);

  const item = result.data.items.find(
    (i) => i.code === "QB_RECEIPT_MISSING" && i.related.paymentId === payment.id,
  );
  expect(item, "Expected a QB_RECEIPT_MISSING item for seeded payment").toBeDefined();

  expect(item!.actionPath).toBe(`/api/admin/payments/${payment.id}/sync-receipt`);
  expect(item!.actionLabel).toBe("Sync receipt");
  expect(item!.actionMethod).toBe("POST");
  expect(item!.actionHref).toBeUndefined();

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// ACTION-002: QB_REFUND_RECEIPT_MISSING item has no action fields
//
// sync-refunds does not write a QB Refund Receipt. No actionPath must be
// returned until a real sync-qb-refund-receipt endpoint exists.
// The item must still carry a non-empty recommendedAction for the admin.
// ---------------------------------------------------------------------------

test("ACTION-002: QB_REFUND_RECEIPT_MISSING item has no actionPath, actionLabel, actionMethod, or actionHref", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  const { payment } = await seedPaidDailyActiveSession(world);
  await seedPaymentRefundWithoutQb({ paymentId: payment.id, amount: 25.0 });

  await authenticateAdmin(request);

  const result = await getNeedsReview(request, { limit: 200 });
  expect(result.ok).toBe(true);

  const item = result.data.items.find(
    (i) => i.code === "QB_REFUND_RECEIPT_MISSING" && i.related.paymentId === payment.id,
  );
  expect(item, "Expected a QB_REFUND_RECEIPT_MISSING item for seeded refund").toBeDefined();

  expect(item!.actionPath, "QB_REFUND_RECEIPT_MISSING must not have actionPath").toBeUndefined();
  expect(item!.actionMethod, "QB_REFUND_RECEIPT_MISSING must not have actionMethod").toBeUndefined();
  expect(item!.actionLabel, "QB_REFUND_RECEIPT_MISSING must not have actionLabel").toBeUndefined();
  expect(item!.actionHref, "QB_REFUND_RECEIPT_MISSING must not have actionHref").toBeUndefined();

  expect(
    item!.recommendedAction,
    "QB_REFUND_RECEIPT_MISSING must still carry a non-empty recommendedAction",
  ).toBeTruthy();

  await world.cleanup();
});
