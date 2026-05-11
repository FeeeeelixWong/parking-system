import { expect, test } from "@playwright/test";
import { countAudit, disconnectDb, resetDb, seedAllowListEntry } from "../../support/db";
import { postAllowListOpenGate } from "../../support/app-api";
import { createWorld } from "../../support/world";

test.skip(
  !process.env.TEST_DATABASE_URL,
  "Set TEST_DATABASE_URL to run DB-backed allow-list gate tests.",
);

test.afterAll(async () => {
  await disconnectDb();
});

test.beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// NORMAL-006: allow-list fresh scan opens gate — ALLOWLIST_ENTRY logged
// ---------------------------------------------------------------------------

test("NORMAL-006: allow-list phone with scanContext=fresh opens gate, ALLOWLIST_ENTRY logged", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  // Seed: active AllowList row. No session or driver DB row required —
  // allow-list access is phone-only and bypasses the session check.
  const { entry } = await seedAllowListEntry({
    testRun: world.testRun,
    label: "Employee",
  });

  const result = await postAllowListOpenGate(request, {
    phone: entry.phone,
    direction: "ENTRANCE",
    scanContext: "fresh",
    deviceId: "test-device-normal-006",
  });

  // ── Response contract ─────────────────────────────────────────────────────
  expect(result.status).toBe(200);
  expect(result.data.ok).toBe(true);

  // ── Audit contract: ALLOWLIST_ENTRY logged (no session, so no sessionId) ──
  expect(await countAudit("ALLOWLIST_ENTRY")).toBe(1);
  // Gate was not logged separately — allow-list path emits ALLOWLIST_ENTRY only
  expect(await countAudit("GATE_OPEN")).toBe(0);

  await world.cleanup();
});

// ---------------------------------------------------------------------------
// GATE-003: allow-list non-fresh scan is denied; no ALLOWLIST_ENTRY written
// ---------------------------------------------------------------------------

test("GATE-003: allow-list phone with scanContext=internal returns RESCAN_REQUIRED, no gate opens", async ({
  request,
}, testInfo) => {
  const world = createWorld(testInfo);

  const { entry } = await seedAllowListEntry({
    testRun: world.testRun,
    label: "Contractor",
  });

  const result = await postAllowListOpenGate(request, {
    phone: entry.phone,
    direction: "ENTRANCE",
    scanContext: "internal",
    deviceId: "test-device-gate-003",
  });

  // ── Response contract ─────────────────────────────────────────────────────
  expect(result.status).toBe(200);
  expect(result.data.ok).toBe(false);
  const denial = (result.data as { ok: false; denial: { code: string } }).denial;
  expect(denial.code).toBe("RESCAN_REQUIRED");

  // ── Audit contract: scanContext check fires before allow-list lookup ───────
  // The route returns at the first guard — no ALLOWLIST_ENTRY is written.
  expect(await countAudit("ALLOWLIST_ENTRY")).toBe(0);
  expect(await countAudit("GATE_OPEN")).toBe(0);

  await world.cleanup();
});
