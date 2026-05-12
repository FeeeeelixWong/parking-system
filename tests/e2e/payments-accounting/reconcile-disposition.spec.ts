import { expect, test } from "@playwright/test";
import { createWorld } from "../support/world";
import { resetDb, disconnectDb } from "../support/db";
import { authenticateAdmin } from "../support/app-api";
import { seedCancelledPaidDailySession } from "../support/scenarios/daily";
import {
  expectNeedsReviewCode,
  expectNoNeedsReviewCode,
} from "../support/assertions/reconcile";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed reconcile tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// CANCEL-009: cancelled paid session without disposition
// ---------------------------------------------------------------------------

test("CANCEL-009: cancelled paid session without disposition appears in Needs Review", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: cancelled session, positive Stripe charge, no disposition set (N_A)
  const { session } = await seedCancelledPaidDailySession(world, {
    cancellationDisposition: "N_A",
  });

  await authenticateAdmin(request);

  await expectNeedsReviewCode(
    request,
    "CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE",
    { sessionId: session.id },
  );

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// RECON-003: retained disposition suppresses warning
// ---------------------------------------------------------------------------

test("RECON-003: retained disposition suppresses Needs Review warning", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: same shape of cancelled session, but disposition = RETAINED_INTENTIONAL.
  // The reconcile endpoint should not emit the warning.
  const { session } = await seedCancelledPaidDailySession(world, {
    cancellationDisposition: "RETAINED_INTENTIONAL",
  });

  await authenticateAdmin(request);

  await expectNoNeedsReviewCode(
    request,
    "CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE",
    { sessionId: session.id },
  );

  // Sanity: the session was actually seeded (not accidentally skipped)
  expect(session.id).toBeTruthy();

  await world.cleanup();
});
