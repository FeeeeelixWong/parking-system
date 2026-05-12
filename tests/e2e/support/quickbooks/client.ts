import { getE2EEnv } from "../env";
import fs from "node:fs";
import path from "node:path";

const QB_BASE_URL = "https://sandbox-quickbooks.api.intuit.com/v3";
const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

type QbRuntimeConfig = {
  clientId: string;
  clientSecret: string;
  realmId: string;
  accessToken: string;
  refreshToken: string;
};

let currentQbConfig: QbRuntimeConfig | null = null;

function getQbConfig(): QbRuntimeConfig | null {
  if (currentQbConfig) return currentQbConfig;
  const { qb } = getE2EEnv();
  if (!qb) return null;
  currentQbConfig = { ...qb };
  return currentQbConfig;
}

/**
 * Returns true when all three required QB runtime vars are present.
 * clientId/clientSecret alone are insufficient — the harness needs a live token.
 */
export function isQbConfigured(): boolean {
  const qb = getQbConfig();
  return !!(qb?.realmId && qb.accessToken && qb.refreshToken);
}

/**
 * Skip message shown when QB env vars are not set.
 */
export const QB_SKIP_MESSAGE =
  "Set E2E_QB_REALM_ID, E2E_QB_ACCESS_TOKEN, and E2E_QB_REFRESH_TOKEN to run QB tests.";

let qbUsable: Promise<boolean> | null = null;

export function isQbUsable(): Promise<boolean> {
  qbUsable ??= (async () => {
    if (!isQbConfigured()) return false;
    try {
      const qb = getQbConfig();
      await qbFetch(`/companyinfo/${qb!.realmId}`);
      return true;
    } catch (e) {
      if (!isQbAuthFailure(e)) return false;
      try {
        const refreshed = await refreshQbTokens();
        if (!refreshed) return false;
        const qb = getQbConfig();
        await qbFetch(`/companyinfo/${qb!.realmId}`);
        return true;
      } catch {
        return false;
      }
    }
  })();
  return qbUsable;
}

/**
 * Throw a test.skip-compatible signal when QB is not configured.
 * Call at the top of QB test files or individual tests.
 */
export function skipIfQbNotConfigured(): void {
  if (!isQbConfigured()) {
    // Playwright's test.skip() reads this thrown object
    throw { type: "skip", message: QB_SKIP_MESSAGE };
  }
}

/**
 * Returns the QB sandbox config from env. Throws if not configured.
 */
export function getE2EQb(): { fetch: typeof qbFetch; realmId: string } {
  const qb = getQbConfig();
  if (!qb?.realmId || !qb.accessToken) {
    throw new Error(QB_SKIP_MESSAGE);
  }
  return { fetch: qbFetch, realmId: qb.realmId };
}

/**
 * Returns the latest QB tokens known to the E2E process. If the access token is
 * stale but the refresh token still works, this refreshes first and persists the
 * rotated pair back into `.env.e2e.local` for the next local run.
 */
export async function ensureQbTokens(): Promise<QbRuntimeConfig | null> {
  if (!isQbConfigured()) return null;
  if (await isQbUsable()) return getQbConfig();
  return null;
}

/**
 * Minimal fetch wrapper for the QB sandbox API.
 * Uses access token from env — no Prisma DB involved.
 *
 * Returns the parsed JSON response. Throws on non-2xx.
 */
export async function qbFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const qb = getQbConfig();
  if (!qb?.realmId || !qb.accessToken) {
    throw new Error(QB_SKIP_MESSAGE);
  }

  const url = `${QB_BASE_URL}/company/${qb.realmId}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${qb.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[e2e/qb] QB API ${res.status} on ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

function isQbAuthFailure(e: unknown): boolean {
  return e instanceof Error && /\b(401|403)\b|unauthorized|invalid_token/i.test(e.message);
}

async function refreshQbTokens(): Promise<QbRuntimeConfig | null> {
  const qb = getQbConfig();
  if (!qb?.clientId || !qb.clientSecret || !qb.refreshToken) return null;

  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${qb.clientId}:${qb.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: qb.refreshToken,
    }),
  });

  if (!res.ok) return null;

  const data = await res.json() as {
    access_token?: string;
    refresh_token?: string;
  };

  if (!data.access_token || !data.refresh_token) return null;

  currentQbConfig = {
    ...qb,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
  qbUsable = null;

  process.env.E2E_QB_ACCESS_TOKEN = data.access_token;
  process.env.E2E_QB_REFRESH_TOKEN = data.refresh_token;
  persistTokenToE2EEnv("E2E_QB_ACCESS_TOKEN", data.access_token);
  persistTokenToE2EEnv("E2E_QB_REFRESH_TOKEN", data.refresh_token);

  return currentQbConfig;
}

function persistTokenToE2EEnv(key: "E2E_QB_ACCESS_TOKEN" | "E2E_QB_REFRESH_TOKEN", value: string): void {
  const envPath = path.resolve(process.cwd(), ".env.e2e.local");
  if (!fs.existsSync(envPath)) return;

  const original = fs.readFileSync(envPath, "utf8");
  const escapedValue = value.replace(/\\/g, "\\\\").replace(/\n/g, "");
  const line = `${key}=${escapedValue}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(original)
    ? original.replace(pattern, line)
    : `${original.replace(/\s*$/, "")}\n${line}\n`;

  if (next !== original) {
    fs.writeFileSync(envPath, next);
  }
}
