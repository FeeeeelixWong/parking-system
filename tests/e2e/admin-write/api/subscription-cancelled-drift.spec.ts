import { test } from "@playwright/test";
import { createWorld } from "../../support/world";
import {
  resetDb,
  disconnectDb,
  seedMonthlyActiveSession,
  setSessionBillingCancelledByAdmin,
  updateSessionExpectedEnd,
} from "../../support/db";
import { authenticateAdmin } from "../../support/app-api";
import {
  expectNeedsReviewCode,
  expectNoNeedsReviewCode,
} from "../../support/assertions/reconcile";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed Needs Review drift tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// DRIFT-001: billingCancelledByAdmin + expectedEnd in the past
//
// Admin initiated a Stripe cancel. The session is still ACTIVE but the
// access window has already elapsed. The Needs Review route must emit a
// SUBSCRIPTION_CANCELLED_BUT_ACCESS_ACTIVE critical item so the admin can
// close the session manually rather than discovering the drift during a
// lot walk.
// ---------------------------------------------------------------------------
test(
  "DRIFT-001: active monthly session past access end with billingCancelledByAdmin emits critical SUBSCRIPTION_CANCELLED_BUT_ACCESS_ACTIVE",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    const { session } = await seedMonthlyActiveSession({ testRun: world.testRun });

    await setSessionBillingCancelledByAdmin(session.id);
    // Backdate expectedEnd 2 days so it's clearly past now.
    const pastEnd = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await updateSessionExpectedEnd(session.id, pastEnd);

    await authenticateAdmin(request);

    await expectNeedsReviewCode(
      request,
      "SUBSCRIPTION_CANCELLED_BUT_ACCESS_ACTIVE",
      { sessionId: session.id },
    );

    await world.cleanup();
  },
);

// ---------------------------------------------------------------------------
// DRIFT-002: billingCancelledByAdmin + expectedEnd still in the future
//
// Admin initiated a Stripe cancel but the driver's paid-through date hasn't
// arrived yet. This is not an error — the driver legitimately retains access
// until expectedEnd — but the Needs Review route should surface a warning so
// admin has visibility. No critical SUBSCRIPTION_CANCELLED_BUT_ACCESS_ACTIVE
// item must appear for the same session.
// ---------------------------------------------------------------------------
test(
  "DRIFT-002: active monthly session with future access end and billingCancelledByAdmin emits warning SUBSCRIPTION_CANCELLED_ACCESS_STILL_VALID and no critical drift item",
  async ({ request }, testInfo) => {
    const world = createWorld(testInfo);
    // seedMonthlyActiveSession sets expectedEnd 30 days out by default — no backdate needed.
    const { session } = await seedMonthlyActiveSession({ testRun: world.testRun });

    await setSessionBillingCancelledByAdmin(session.id);

    await authenticateAdmin(request);

    await expectNeedsReviewCode(
      request,
      "SUBSCRIPTION_CANCELLED_ACCESS_STILL_VALID",
      { sessionId: session.id },
    );
    await expectNoNeedsReviewCode(
      request,
      "SUBSCRIPTION_CANCELLED_BUT_ACCESS_ACTIVE",
      { sessionId: session.id },
    );

    await world.cleanup();
  },
);
