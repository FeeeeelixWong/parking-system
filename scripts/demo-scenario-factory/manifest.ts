import * as fs from "node:fs";
import * as path from "node:path";

export type ScenarioEntry = {
  scenario: string;
  driverPhone: string;
  driverId: string;
  vehicleId: string;
  sessionId: string;
  paymentId?: string;
  refundId?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  stripeRefundId?: string;
  stripeInvoiceId?: string;
  qbSalesReceiptId?: string;
  qbRefundReceiptId?: string;
  expectedNeedsReviewCodes: string[];
  suggestedAdminAction: string;
};

export type DemoManifest = {
  testRunId: string;
  stateName: string;
  createdAt: string;
  scenarios: ScenarioEntry[];
};

function manifestsDir(): string {
  return path.join(process.cwd(), ".demo-manifests");
}

function manifestPath(testRunId: string): string {
  return path.join(manifestsDir(), `${testRunId}.json`);
}

export function saveManifest(manifest: DemoManifest): void {
  const dir = manifestsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(manifest.testRunId), JSON.stringify(manifest, null, 2));
}

export function loadManifest(testRunId: string): DemoManifest | null {
  const p = manifestPath(testRunId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as DemoManifest;
}

export function deleteManifest(testRunId: string): void {
  const p = manifestPath(testRunId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function listManifests(): DemoManifest[] {
  const dir = manifestsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as DemoManifest)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function printManifest(m: DemoManifest): void {
  console.log("\n── Demo State Created ─────────────────────────────────────────");
  console.log(`  TestRunId:  ${m.testRunId}`);
  console.log(`  StateName:  ${m.stateName}`);
  for (const s of m.scenarios) {
    console.log(`\n  [${s.scenario}]`);
    console.log(`    Driver:      ${s.driverPhone}  (id: ${s.driverId})`);
    console.log(`    Session:     ${s.sessionId}`);
    if (s.paymentId)            console.log(`    Payment:     ${s.paymentId}`);
    if (s.stripeCustomerId)     console.log(`    Stripe cus:  ${s.stripeCustomerId}`);
    if (s.stripeChargeId)       console.log(`    Stripe ch:   ${s.stripeChargeId}`);
    if (s.stripeRefundId)       console.log(`    Stripe re:   ${s.stripeRefundId}`);
    if (s.stripeSubscriptionId) console.log(`    Stripe sub:  ${s.stripeSubscriptionId}`);
    if (s.stripeInvoiceId)      console.log(`    Stripe inv:  ${s.stripeInvoiceId}`);
    if (s.qbSalesReceiptId)     console.log(`    QB receipt:  ${s.qbSalesReceiptId}`);
    if (s.qbRefundReceiptId)    console.log(`    QB refund:   ${s.qbRefundReceiptId}`);
    const codes = s.expectedNeedsReviewCodes.length
      ? s.expectedNeedsReviewCodes.join(", ")
      : "(clean)";
    console.log(`    NeedsReview: ${codes}`);
    console.log(`    Action:      ${s.suggestedAdminAction}`);
  }
  console.log("\n───────────────────────────────────────────────────────────────\n");
}
