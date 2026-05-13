import { getPrisma } from "./prisma-client.js";
import { loadManifest, deleteManifest, type ScenarioEntry } from "./manifest.js";
import { cancelSubscription, deleteCustomer } from "./stripe-client.js";

async function resetEntry(entry: ScenarioEntry): Promise<void> {
  const prisma = await getPrisma();
  const driver = await prisma.driver.findUnique({ where: { id: entry.driverId } });

  if (driver) {
    const sessions = await prisma.session.findMany({ where: { driverId: driver.id } });
    const sessionIds = sessions.map((s) => s.id);

    if (sessionIds.length > 0) {
      const payments = await prisma.payment.findMany({ where: { sessionId: { in: sessionIds } } });
      const paymentIds = payments.map((p) => p.id);

      if (paymentIds.length > 0) {
        const deleted = await prisma.paymentRefund.deleteMany({
          where: { paymentId: { in: paymentIds } },
        });
        if (deleted.count > 0) console.log(`    Deleted ${deleted.count} PaymentRefund row(s).`);
        await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
        console.log(`    Deleted ${paymentIds.length} Payment row(s).`);
      }

      await prisma.auditLog.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
      console.log(`    Deleted ${sessionIds.length} Session row(s).`);
    }

    await prisma.vehicle.deleteMany({ where: { driverId: driver.id } });
    await prisma.auditLog.deleteMany({ where: { driverId: driver.id } });
    await prisma.driver.delete({ where: { id: driver.id } });
    console.log(`    Deleted Driver: ${driver.name} (${driver.phone}).`);
  } else {
    console.log("    Driver not found in DB — may have already been deleted.");
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey?.startsWith("sk_test_") && entry.stripeCustomerId) {
    if (entry.stripeSubscriptionId) {
      await cancelSubscription(entry.stripeSubscriptionId);
      console.log(`    Stripe subscription cancelled: ${entry.stripeSubscriptionId}`);
    }
    await deleteCustomer(entry.stripeCustomerId);
    console.log(`    Stripe customer deleted: ${entry.stripeCustomerId}`);
    console.log(
      "    Note: Stripe charges/refunds remain in test history (Stripe does not allow deleting them).",
    );
  } else if (entry.stripeCustomerId) {
    console.log("    Skipping Stripe cleanup — STRIPE_SECRET_KEY not set or not a test key.");
  }

  if (entry.qbSalesReceiptId && !entry.qbSalesReceiptId.startsWith("qb_demo_")) {
    console.log(`    QB Sales Receipt: ${entry.qbSalesReceiptId} — delete manually in QB sandbox.`);
  }
  if (entry.qbRefundReceiptId && !entry.qbRefundReceiptId.startsWith("qb_demo_")) {
    console.log(`    QB Refund Receipt: ${entry.qbRefundReceiptId} — delete manually in QB sandbox.`);
  }
}

export async function resetScenario(testRunId: string): Promise<void> {
  const manifest = loadManifest(testRunId);
  if (!manifest) {
    console.error(`No manifest found for testRunId: ${testRunId}`);
    process.exit(1);
  }

  console.log(`\nResetting demo state: ${manifest.stateName} (${testRunId})`);
  console.log(`  ${manifest.scenarios.length} scenario(s): ${manifest.scenarios.map((s) => s.scenario).join(", ")}`);

  for (const entry of manifest.scenarios) {
    console.log(`\n  [${entry.scenario}]`);
    await resetEntry(entry);
  }

  deleteManifest(testRunId);
  console.log(`\n  Manifest deleted: ${testRunId}.json`);
  console.log("Reset complete.\n");
}
