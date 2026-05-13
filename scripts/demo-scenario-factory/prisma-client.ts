import { PrismaPg } from "@prisma/adapter-pg";

let _prisma: import("../../src/generated/prisma/client.js").PrismaClient | null = null;

function getDbUrl(): string {
  const url = process.env.DEMO_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set DEMO_DATABASE_URL or TEST_DATABASE_URL to run demo scenarios.",
    );
  }
  return url;
}

export async function getPrisma() {
  if (_prisma) return _prisma;
  const { PrismaClient } = await import("../../src/generated/prisma/client.js");
  const adapter = new PrismaPg({ connectionString: getDbUrl() });
  _prisma = new PrismaClient({ adapter });
  return _prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

export async function findOrCreateDemoSpot(): Promise<string> {
  const prisma = await getPrisma();
  const label = "DEMO-FACTORY";
  const spot = await prisma.spot.upsert({
    where: { label },
    update: {},
    create: {
      label,
      type: "TRUCK_TRAILER",
      cx: 0,
      cy: 0,
      w: 40,
      h: 80,
      rot: 0,
    },
  });
  return spot.id;
}

// ─── Pure utilities (no DB dependency) ────────────────────────────────────────

export function makePhone(): string {
  const suffix = String(Math.floor(Math.random() * 9000000 + 1000000));
  return `555${suffix}`;
}

export function makeTestRunId(stateName: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `demo_${stateName}_${date}_${time}_${rand}`;
}

export function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 86400000);
}

export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400000);
}
