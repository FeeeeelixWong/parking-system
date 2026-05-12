import { expect, test } from "@playwright/test";
import { ensureQbTokens, isQbConfigured, QB_SKIP_MESSAGE, qbFetch } from "../support/quickbooks/client";

test.skip(
  !isQbConfigured(),
  QB_SKIP_MESSAGE,
);

// ---------------------------------------------------------------------------
// QB-HARNESS-001: connectivity — can reach QB sandbox and read company info
// ---------------------------------------------------------------------------

test("QB-HARNESS-001: QB sandbox client can fetch company info", async () => {
  const qb = await ensureQbTokens();
  test.skip(!qb, "QB sandbox token and refresh token are expired or invalid; reconnect QuickBooks to run QB tests.");

  type QbCompanyInfoResponse = {
    CompanyInfo: {
      CompanyName: string;
      Id: string;
    };
    time: string;
  };

  const result = await qbFetch<QbCompanyInfoResponse>(
    `/companyinfo/${qb!.realmId}`,
  );

  // ── Response contract ─────────────────────────────────────────────────────
  expect(result.CompanyInfo).toBeDefined();
  expect(typeof result.CompanyInfo.CompanyName).toBe("string");
  expect(result.CompanyInfo.CompanyName.length).toBeGreaterThan(0);
});
