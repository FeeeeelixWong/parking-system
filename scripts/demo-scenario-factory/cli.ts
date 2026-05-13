/**
 * Demo Scenario Factory CLI
 *
 * Usage (via package.json scripts):
 *   npm run demo:create -- <scenario|bundle>
 *     Scenarios: healthy-daily | missing-qb-receipt | refund-missing-qb | failed-monthly-invoice
 *     Bundles:   admin-refresh  (all 4 Phase 1 scenarios under one testRunId)
 *   npm run demo:reset  -- <testRunId>
 *   npm run demo:list
 *
 * testRunId format: demo_<stateName>_<YYYYMMDD>_<HHmmss>_<4charRandom>
 * Filter key for admin UI: /admin?demoId=<testRunId>  (future)
 */
import "dotenv/config";
import { checkBaseGuards, checkStripeGuard } from "./guards.js";
import {
  saveManifest,
  printManifest,
  listManifests,
  type DemoManifest,
  type ScenarioEntry,
} from "./manifest.js";
import { makeTestRunId, disconnectPrisma } from "./prisma-client.js";

const SINGLE_SCENARIOS = [
  "healthy-daily",
  "missing-qb-receipt",
  "refund-missing-qb",
  "failed-monthly-invoice",
] as const;

const BUNDLES: Record<string, readonly string[]> = {
  "admin-refresh": SINGLE_SCENARIOS,
};

const ALL_NAMES = [...SINGLE_SCENARIOS, ...Object.keys(BUNDLES)];

async function runScenario(scenario: string, testRunId: string): Promise<ScenarioEntry> {
  const { run } = await import(`./scenarios/${scenario}.js`);
  return run(testRunId) as Promise<ScenarioEntry>;
}

async function runCreate(stateName: string): Promise<void> {
  const scenarios: readonly string[] = BUNDLES[stateName] ??
    (SINGLE_SCENARIOS.includes(stateName as typeof SINGLE_SCENARIOS[number]) ? [stateName] : null)
    ?? (() => {
      console.error(`Unknown scenario/bundle: "${stateName}"\nAvailable: ${ALL_NAMES.join(" | ")}`);
      process.exit(1);
    })();

  checkBaseGuards();
  checkStripeGuard(); // all Phase 1 scenarios require Stripe

  const testRunId = makeTestRunId(stateName);
  const manifest: DemoManifest = {
    testRunId,
    stateName,
    createdAt: new Date().toISOString(),
    scenarios: [],
  };

  const isBundle = scenarios.length > 1;
  console.log(`\nCreating demo state: ${stateName} (${testRunId})`);
  if (isBundle) console.log(`  Scenarios: ${scenarios.join(", ")}`);

  for (const scenario of scenarios) {
    if (isBundle) console.log(`\n  → ${scenario}`);
    const entry = await runScenario(scenario, testRunId);
    manifest.scenarios.push(entry);
  }

  saveManifest(manifest);
  printManifest(manifest);
}

async function runReset(testRunId: string): Promise<void> {
  checkBaseGuards();
  const { resetScenario } = await import("./reset.js");
  await resetScenario(testRunId);
}

function runList(): void {
  const manifests = listManifests();
  if (manifests.length === 0) {
    console.log("No demo manifests found. Run npm run demo:create -- <scenario> to create one.");
    return;
  }

  console.log();
  for (const m of manifests) {
    const ts = m.createdAt.slice(0, 19).replace("T", " ");
    console.log(`${m.testRunId}`);
    console.log(`  stateName: ${m.stateName}   created: ${ts}`);
    for (const s of m.scenarios) {
      const codes = s.expectedNeedsReviewCodes.length
        ? `[${s.expectedNeedsReviewCodes.join(", ")}]`
        : "(clean)";
      console.log(`  · ${s.scenario.padEnd(28)} ${codes}`);
    }
    console.log();
  }
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  try {
    if (command === "create") {
      if (!arg) {
        console.error(
          `Usage: npm run demo:create -- <scenario|bundle>\nAvailable: ${ALL_NAMES.join(" | ")}`,
        );
        process.exit(1);
      }
      await runCreate(arg);
    } else if (command === "reset") {
      if (!arg) {
        console.error("Usage: npm run demo:reset -- <testRunId>");
        process.exit(1);
      }
      await runReset(arg);
    } else if (command === "list") {
      runList();
    } else {
      console.error(
        "Unknown command. Use: create | reset | list\n" +
          `  npm run demo:create -- ${ALL_NAMES[0]}\n` +
          "  npm run demo:reset  -- <testRunId>\n" +
          "  npm run demo:list",
      );
      process.exit(1);
    }
  } finally {
    await disconnectPrisma();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
