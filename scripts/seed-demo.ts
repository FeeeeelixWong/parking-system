/**
 * Demo seed: realistic admin dashboard states for UI review/QA.
 *
 * Produces 8 named personas with deterministic data.  No Stripe or QB
 * network calls — all IDs are synthetic.  Safe to run against any database
 * (local or test); never touches production Stripe/QB.
 *
 * Usage:
 *   DATABASE_URL="..." npx tsx scripts/seed-demo.ts
 *
 * See scripts/DEMO_SEED.md for expected Needs Review output.
 */

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

// ── Deterministic demo phones ────────────────────────────────────────────────

const DEMO_PHONES = [
  "5550100011", // Scenario 1: Marco Rivera    — healthy daily
  "5550100021", // Scenario 2: Teresa Kim      — healthy monthly
  "5550100031", // Scenario 3: David Chen      — payment failed (actionHref)
  "5550100041", // Scenario 4: Sandra Ortiz    — delinquent
  "5550100051", // Scenario 5: James Washington — past expectedEnd
  "5550100061", // Scenario 6: Patricia Flores  — QB receipt missing (actionPath)
  "5550100071", // Scenario 7: Robert Hughes    — cancelled/retained (no NR)
  "5550100081", // Scenario 8: Angela Brooks    — completed/clean (no NR)
];

const DEMO_SPOT_LABELS = ["DEMO-A", "DEMO-B", "DEMO-C", "DEMO-D", "DEMO-E"];

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 86400000);
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 3600000);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup() {
  console.log("Cleaning up previous demo data…");

  const drivers = await prisma.driver.findMany({
    where: { phone: { in: DEMO_PHONES } },
    include: { sessions: { select: { id: true } } },
  });

  const sessionIds = drivers.flatMap((d) => d.sessions.map((s) => s.id));

  if (sessionIds.length > 0) {
    // Delete child rows before sessions
    await prisma.paymentRefund.deleteMany({ where: { payment: { sessionId: { in: sessionIds } } } });
    await prisma.payment.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await prisma.auditLog.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  }

  await prisma.auditLog.deleteMany({ where: { driver: { phone: { in: DEMO_PHONES } } } });
  await prisma.driver.deleteMany({ where: { phone: { in: DEMO_PHONES } } });

  // Remove demo spots (only if no non-demo sessions reference them)
  for (const label of DEMO_SPOT_LABELS) {
    const spot = await prisma.spot.findUnique({ where: { label } });
    if (spot) {
      const linked = await prisma.session.count({ where: { spotId: spot.id } });
      if (linked === 0) await prisma.spot.delete({ where: { label } });
    }
  }

  console.log("  Cleaned.");
}

// ── Demo spots ────────────────────────────────────────────────────────────────

async function upsertDemoSpots(): Promise<Record<string, string>> {
  const spotIds: Record<string, string> = {};
  for (let i = 0; i < DEMO_SPOT_LABELS.length; i++) {
    const label = DEMO_SPOT_LABELS[i];
    const spot = await prisma.spot.upsert({
      where: { label },
      create: { label, type: "TRUCK_TRAILER", cx: 200 + i * 120, cy: 300, w: 100, h: 40, rot: 0 },
      update: {},
    });
    spotIds[label] = spot.id;
  }
  return spotIds;
}

// ── Per-persona helpers ───────────────────────────────────────────────────────

async function createPersona(name: string, phone: string) {
  const driver = await prisma.driver.create({
    data: { name, phone },
  });
  const vehicle = await prisma.vehicle.create({
    data: { driverId: driver.id, type: "TRUCK_TRAILER", unitNumber: `DEMO-${phone.slice(-2)}` },
  });
  return { driver, vehicle };
}

// ── 8 scenarios ───────────────────────────────────────────────────────────────

async function scenario1_HealthyDaily(spots: Record<string, string>) {
  // ACTIVE daily, full chain (stripeChargeId + qbSalesReceiptId) → no NR
  const { driver, vehicle } = await createPersona("Marco Rivera", "5550100011");
  const session = await prisma.session.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      spotId: spots["DEMO-A"],
      expectedEnd: daysFromNow(2),
      status: "ACTIVE",
      billingStatus: "CURRENT",
    },
  });
  await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "CHECKIN",
      amount: 60,
      days: 2,
      status: "COMPLETED",
      stripePaymentIntentId: "pi_demo_s1_001",
      stripeChargeId: "ch_demo_s1_001",
      qbSalesReceiptId: "qb_demo_s1_001",
      qbSalesReceiptAmount: 60,
    },
  });
  console.log("  ✓ Scenario 1: Marco Rivera (healthy daily — no NR)");
}

async function scenario2_HealthyMonthly(spots: Record<string, string>) {
  // ACTIVE monthly CURRENT, full chain → no NR
  const { driver, vehicle } = await createPersona("Teresa Kim", "5550100021");
  const session = await prisma.session.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      spotId: spots["DEMO-B"],
      expectedEnd: daysFromNow(25),
      status: "ACTIVE",
      billingStatus: "CURRENT",
    },
  });
  await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "MONTHLY_CHECKIN",
      amount: 400,
      days: 30,
      status: "COMPLETED",
      stripePaymentIntentId: "pi_demo_s2_001",
      stripeChargeId: "ch_demo_s2_001",
      stripeSubscriptionId: "sub_demo_s2_001",
      qbSalesReceiptId: "qb_demo_s2_001",
      qbSalesReceiptAmount: 400,
    },
  });
  console.log("  ✓ Scenario 2: Teresa Kim (healthy monthly — no NR)");
}

async function scenario3_PaymentFailed(spots: Record<string, string>) {
  // ACTIVE monthly PAYMENT_FAILED with hostedInvoiceUrl → NR: SUBSCRIPTION_PAYMENT_FAILED (actionHref)
  const { driver, vehicle } = await createPersona("David Chen", "5550100031");
  const session = await prisma.session.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      spotId: spots["DEMO-C"],
      expectedEnd: daysFromNow(15),
      status: "ACTIVE",
      billingStatus: "PAYMENT_FAILED",
      billingFailedAt: hoursAgo(36),
    },
  });
  await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "MONTHLY_CHECKIN",
      amount: 400,
      days: 30,
      status: "COMPLETED",
      stripePaymentIntentId: "pi_demo_s3_001",
      stripeChargeId: "ch_demo_s3_001",
      stripeSubscriptionId: "sub_demo_s3_001",
      qbSalesReceiptId: "qb_demo_s3_001",
      qbSalesReceiptAmount: 400,
      // This hostedInvoiceUrl causes the NR item to show "Open invoice ↗"
      hostedInvoiceUrl: "https://invoice.stripe.com/i/demo_david_chen_failed",
    },
  });
  console.log("  ✓ Scenario 3: David Chen (payment failed — NR: SUBSCRIPTION_PAYMENT_FAILED with actionHref)");
}

async function scenario4_Delinquent(spots: Record<string, string>) {
  // ACTIVE monthly DELINQUENT → NR: SUBSCRIPTION_DELINQUENT
  const { driver, vehicle } = await createPersona("Sandra Ortiz", "5550100041");
  const session = await prisma.session.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      spotId: spots["DEMO-D"],
      expectedEnd: daysFromNow(10),
      status: "ACTIVE",
      billingStatus: "DELINQUENT",
      billingFailedAt: hoursAgo(240),
      billingDelinquentAt: hoursAgo(48),
    },
  });
  await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "MONTHLY_CHECKIN",
      amount: 400,
      days: 30,
      status: "COMPLETED",
      stripePaymentIntentId: "pi_demo_s4_001",
      stripeChargeId: "ch_demo_s4_001",
      stripeSubscriptionId: "sub_demo_s4_001",
      qbSalesReceiptId: "qb_demo_s4_001",
      qbSalesReceiptAmount: 400,
    },
  });
  console.log("  ✓ Scenario 4: Sandra Ortiz (delinquent — NR: SUBSCRIPTION_DELINQUENT)");
}

async function scenario5_PastExpectedEnd(spots: Record<string, string>) {
  // ACTIVE session with expectedEnd 3 hours ago → NR: ACTIVE_SESSION_PAST_EXPECTED_END
  const { driver, vehicle } = await createPersona("James Washington", "5550100051");
  const session = await prisma.session.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      spotId: spots["DEMO-E"],
      expectedEnd: hoursAgo(3),
      status: "ACTIVE",
      billingStatus: "CURRENT",
    },
  });
  await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "CHECKIN",
      amount: 90,
      days: 3,
      status: "COMPLETED",
      stripePaymentIntentId: "pi_demo_s5_001",
      stripeChargeId: "ch_demo_s5_001",
      qbSalesReceiptId: "qb_demo_s5_001",
      qbSalesReceiptAmount: 90,
    },
  });
  console.log("  ✓ Scenario 5: James Washington (past expectedEnd — NR: ACTIVE_SESSION_PAST_EXPECTED_END)");
}

async function scenario6_QbReceiptMissing() {
  // COMPLETED session with stripeChargeId but no qbSalesReceiptId → NR: QB_RECEIPT_MISSING (actionPath)
  const { driver, vehicle } = await createPersona("Patricia Flores", "5550100061");

  // COMPLETED sessions don't need a spot
  const anySpot = await prisma.spot.findFirst({ orderBy: { label: "asc" } });
  if (!anySpot) throw new Error("No spots in DB — run `npx tsx scripts/seed.ts` first");

  const session = await prisma.session.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      spotId: anySpot.id,
      expectedEnd: hoursAgo(24),
      endedAt: hoursAgo(24),
      status: "COMPLETED",
      billingStatus: "CURRENT",
    },
  });
  await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "CHECKIN",
      amount: 30,
      days: 1,
      status: "COMPLETED",
      stripePaymentIntentId: "pi_demo_s6_001",
      stripeChargeId: "ch_demo_s6_001",
      // qbSalesReceiptId intentionally null — triggers QB_RECEIPT_MISSING
    },
  });
  console.log("  ✓ Scenario 6: Patricia Flores (QB receipt missing — NR: QB_RECEIPT_MISSING with actionPath)");
}

async function scenario7_CancelledRetained() {
  // CANCELLED with RETAINED_INTENTIONAL → no NR (disposition !== N_A skips all checks)
  const { driver, vehicle } = await createPersona("Robert Hughes", "5550100071");

  const anySpot = await prisma.spot.findFirst({ orderBy: { label: "asc" } });
  if (!anySpot) throw new Error("No spots in DB — run `npx tsx scripts/seed.ts` first");

  const session = await prisma.session.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      spotId: anySpot.id,
      expectedEnd: hoursAgo(72),
      endedAt: hoursAgo(48),
      status: "CANCELLED",
      billingStatus: "CURRENT",
      cancellationDisposition: "RETAINED_INTENTIONAL",
    },
  });
  await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "CHECKIN",
      amount: 60,
      days: 2,
      status: "COMPLETED",
      stripePaymentIntentId: "pi_demo_s7_001",
      stripeChargeId: "ch_demo_s7_001",
      qbSalesReceiptId: "qb_demo_s7_001",
      qbSalesReceiptAmount: 60,
    },
  });
  console.log("  ✓ Scenario 7: Robert Hughes (cancelled/retained — no NR)");
}

async function scenario8_CompletedClean() {
  // COMPLETED with full chain → no NR
  const { driver, vehicle } = await createPersona("Angela Brooks", "5550100081");

  const anySpot = await prisma.spot.findFirst({ orderBy: { label: "asc" } });
  if (!anySpot) throw new Error("No spots in DB — run `npx tsx scripts/seed.ts` first");

  const session = await prisma.session.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      spotId: anySpot.id,
      expectedEnd: hoursAgo(12),
      endedAt: hoursAgo(12),
      status: "COMPLETED",
      billingStatus: "CURRENT",
    },
  });
  await prisma.payment.create({
    data: {
      sessionId: session.id,
      type: "CHECKIN",
      amount: 90,
      days: 3,
      status: "COMPLETED",
      stripePaymentIntentId: "pi_demo_s8_001",
      stripeChargeId: "ch_demo_s8_001",
      qbSalesReceiptId: "qb_demo_s8_001",
      qbSalesReceiptAmount: 90,
    },
  });
  console.log("  ✓ Scenario 8: Angela Brooks (completed/clean — no NR)");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== ParkLogic Demo Seed ===\n");

  await cleanup();

  console.log("\nUpserting demo spots…");
  const spots = await upsertDemoSpots();
  console.log(`  ${DEMO_SPOT_LABELS.length} spots ready: ${DEMO_SPOT_LABELS.join(", ")}`);

  console.log("\nSeeding personas…");
  await scenario1_HealthyDaily(spots);
  await scenario2_HealthyMonthly(spots);
  await scenario3_PaymentFailed(spots);
  await scenario4_Delinquent(spots);
  await scenario5_PastExpectedEnd(spots);
  await scenario6_QbReceiptMissing();
  await scenario7_CancelledRetained();
  await scenario8_CompletedClean();

  console.log("\n=== Done ===");
  console.log("Needs Review should show 4 items:");
  console.log("  [critical] SUBSCRIPTION_DELINQUENT          — Sandra Ortiz");
  console.log("  [warning]  SUBSCRIPTION_PAYMENT_FAILED      — David Chen (actionHref: Open invoice ↗)");
  console.log("  [warning]  ACTIVE_SESSION_PAST_EXPECTED_END — James Washington");
  console.log("  [warning]  QB_RECEIPT_MISSING               — Patricia Flores (actionPath: Sync receipt)");
  console.log("\nNo items expected for: Marco Rivera, Teresa Kim, Robert Hughes, Angela Brooks.");
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
