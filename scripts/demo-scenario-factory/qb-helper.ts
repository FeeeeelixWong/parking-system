/**
 * Lightweight QB helper for demo scenarios.
 *
 * Makes direct QB API calls using tokens stored in the demo DB Settings row.
 * Returns null when QB is not configured so scenarios can fall back to
 * synthetic receipt IDs.
 */
import { getPrisma } from "./prisma-client.js";

const QB_SANDBOX_BASE = "https://sandbox-quickbooks.api.intuit.com";
const QB_PROD_BASE = "https://quickbooks.api.intuit.com";

function qbBase(): string {
  const isProd = process.env.NODE_ENV === "production" && !process.env.PLAYWRIGHT_TEST;
  return isProd ? QB_PROD_BASE : QB_SANDBOX_BASE;
}

type QbTokens = { accessToken: string; realmId: string };

async function getQbTokens(): Promise<QbTokens | null> {
  const prisma = await getPrisma();
  const settings = await prisma.settings.findUnique({ where: { id: "default" } });
  if (!settings?.qbAccessToken || !settings?.qbRealmId) return null;
  return { accessToken: settings.qbAccessToken, realmId: settings.qbRealmId };
}

async function qbFetch<T>(
  tokens: QbTokens,
  path: string,
  opts?: RequestInit,
): Promise<T> {
  const url = `${qbBase()}/v3/company/${tokens.realmId}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${tokens.accessToken}`,
      "Accept": "application/json",
      ...(opts?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `QB API error (${res.status})`;
    try {
      const body = await res.json() as { Fault?: { Error?: Array<{ Detail?: string }> } };
      if (body.Fault?.Error?.[0]?.Detail) msg = body.Fault.Error[0].Detail;
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

type QBCustomer = { Id: string; DisplayName: string };

async function findOrCreateQbCustomer(
  tokens: QbTokens,
  name: string,
  phone: string,
): Promise<string> {
  const displayName = `${name} (${phone})`;
  const escaped = displayName.replace(/'/g, "''");
  const searchRes = await qbFetch<{ QueryResponse: { Customer?: QBCustomer[] } }>(
    tokens,
    `/query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${escaped}' MAXRESULTS 1`)}`,
  );
  if (searchRes.QueryResponse.Customer?.length) {
    return searchRes.QueryResponse.Customer[0].Id;
  }
  const createRes = await qbFetch<{ Customer: QBCustomer }>(tokens, "/customer", {
    method: "POST",
    body: JSON.stringify({ DisplayName: displayName, PrimaryPhone: { FreeFormNumber: phone } }),
  });
  return createRes.Customer.Id;
}

async function getServiceItemId(tokens: QbTokens): Promise<string> {
  const itemRes = await qbFetch<{ QueryResponse: { Item?: Array<{ Id: string }> } }>(
    tokens,
    `/query?query=${encodeURIComponent("SELECT Id FROM Item WHERE Type = 'Service' MAXRESULTS 1")}`,
  );
  if (itemRes.QueryResponse.Item?.length) return itemRes.QueryResponse.Item[0].Id;

  const acctRes = await qbFetch<{ QueryResponse: { Account?: Array<{ Id: string }> } }>(
    tokens,
    `/query?query=${encodeURIComponent("SELECT Id FROM Account WHERE AccountType = 'Income' MAXRESULTS 1")}`,
  );
  const incomeAccountId = acctRes.QueryResponse.Account?.[0]?.Id;
  if (!incomeAccountId) throw new Error("No income account in QB sandbox.");
  const createRes = await qbFetch<{ Item: { Id: string } }>(tokens, "/item", {
    method: "POST",
    body: JSON.stringify({
      Name: "Parking Services",
      Type: "Service",
      IncomeAccountRef: { value: incomeAccountId },
    }),
  });
  return createRes.Item.Id;
}

async function getDepositAccountId(tokens: QbTokens): Promise<string> {
  const bankRes = await qbFetch<{ QueryResponse: { Account?: Array<{ Id: string }> } }>(
    tokens,
    `/query?query=${encodeURIComponent("SELECT Id FROM Account WHERE AccountType = 'Bank' MAXRESULTS 1")}`,
  );
  if (bankRes.QueryResponse.Account?.length) return bankRes.QueryResponse.Account[0].Id;

  const ufRes = await qbFetch<{ QueryResponse: { Account?: Array<{ Id: string; Name: string }> } }>(
    tokens,
    `/query?query=${encodeURIComponent("SELECT Id, Name FROM Account WHERE AccountType = 'Other Current Asset' MAXRESULTS 5")}`,
  );
  const uf = ufRes.QueryResponse.Account?.find(
    (a) => a.Name.toLowerCase().includes("undeposited") || a.Name.toLowerCase().includes("funds"),
  ) ?? ufRes.QueryResponse.Account?.[0];
  if (uf) return uf.Id;
  throw new Error("No Bank or Undeposited Funds account in QB sandbox.");
}

export type QbSalesReceiptResult = { qbSalesReceiptId: string; qbCustomerId: string };

/**
 * Write a QB Sales Receipt. Returns null if QB is not configured (tokens absent).
 */
export async function qbWriteSalesReceipt(opts: {
  driverName: string;
  driverPhone: string;
  amount: number;
  testRunId: string;
  scenario: string;
  stripeChargeId: string;
}): Promise<QbSalesReceiptResult | null> {
  const tokens = await getQbTokens();
  if (!tokens) return null;

  const customerId = await findOrCreateQbCustomer(tokens, opts.driverName, opts.driverPhone);
  const [itemId, depositId] = await Promise.all([
    getServiceItemId(tokens),
    getDepositAccountId(tokens),
  ]);

  const privateNote = `charge:${opts.stripeChargeId} demo:${opts.testRunId} scenario:${opts.scenario}`;
  const res = await qbFetch<{ SalesReceipt: { Id: string } }>(tokens, "/salesreceipt", {
    method: "POST",
    body: JSON.stringify({
      CustomerRef: { value: customerId },
      DepositToAccountRef: { value: depositId },
      Line: [
        {
          Amount: opts.amount,
          DetailType: "SalesItemLineDetail",
          Description: `Parking Services — demo:${opts.testRunId} scenario:${opts.scenario}`,
          SalesItemLineDetail: {
            ItemRef: { value: itemId },
            UnitPrice: opts.amount,
            Qty: 1,
          },
        },
      ],
      PrivateNote: privateNote,
    }),
  });
  return { qbSalesReceiptId: res.SalesReceipt.Id, qbCustomerId: customerId };
}

export async function isQbConfigured(): Promise<boolean> {
  return (await getQbTokens()) !== null;
}

export async function pingQbCompanyInfo(): Promise<boolean> {
  const tokens = await getQbTokens();
  if (!tokens) return false;
  try {
    await qbFetch(tokens, `/companyinfo/${tokens.realmId}`);
    return true;
  } catch {
    return false;
  }
}
