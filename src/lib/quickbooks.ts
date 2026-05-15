/**
 * QuickBooks Online integration — accounting output only.
 *
 * After the Stripe rewrite, QB is no longer a payment processor. This module
 * keeps OAuth + customer lookup + two write functions:
 *   - writeSalesReceipt() — called from the Stripe webhook after every
 *     successful charge (one-time or subscription renewal).
 *   - writeRefundReceipt() — called from the Stripe webhook after every
 *     refund is captured.
 *
 * Payment state of record lives in our `Payment` table, driven by Stripe
 * webhooks. We never read payment state back from QB.
 *
 * QB API base URLs:
 *   Sandbox:    https://sandbox-quickbooks.api.intuit.com
 *   Production: https://quickbooks.api.intuit.com
 */

const SANDBOX_BASE = "https://sandbox-quickbooks.api.intuit.com";
const PROD_BASE = "https://quickbooks.api.intuit.com";

/**
 * Strip characters QB rejects before writing to QB fields.
 * QB accepts printable ASCII [\x20-\x7E]. Non-ASCII → space, then collapse
 * consecutive spaces and trim to maxLen.
 */
function sanitizeForQb(str: string, maxLen: number): string {
  return str
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/**
 * Thrown when QB is unreachable or tokens can't be acquired/refreshed.
 * Callers should catch this and audit SALES_RECEIPT_FAILED so the admin
 * knows to reconcile manually.
 */
export class QBAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QBAuthError";
  }
}

// Force sandbox when running under Playwright (next start sets NODE_ENV=production,
// but E2E tests should always use the QB sandbox, never the production API).
const isProd = process.env.NODE_ENV === "production" && !process.env.PLAYWRIGHT_TEST;
const API_BASE = isProd ? PROD_BASE : SANDBOX_BASE;

/**
 * Fail loud if sandbox credentials are used in production. Catastrophic
 * miss-config: Sales Receipts would be written to a sandbox company file
 * and dad's books would silently drift from reality.
 */
function validateEnvironment(realmId: string): void {
  if (!isProd) return;

  const clientId = process.env.QB_CLIENT_ID ?? "";
  if (clientId.startsWith("ABEI")) {
    throw new Error(
      "CRITICAL: QuickBooks sandbox credentials detected in production! " +
      "Update QB_CLIENT_ID and QB_CLIENT_SECRET to production keys.",
    );
  }

  if (!realmId) {
    throw new QBAuthError("QB_REALM_ID is empty. Connect QuickBooks in Admin → Settings.");
  }
}

// ---------------------------------------------------------------------------
// Auth — tokens stored in DB, refreshed automatically when expired
// ---------------------------------------------------------------------------
import { prisma } from "./prisma";

// In-flight refresh lock: if two concurrent QB calls both detect an expired
// token, only one refresh runs. The second awaits the same promise so the
// refresh token is never exchanged twice (which causes Intuit "invalid_grant").
let _refreshPromise: Promise<{ accessToken: string; realmId: string }> | null = null;

async function getTokens(): Promise<{ accessToken: string; realmId: string }> {
  const settings = await prisma.settings.findUnique({ where: { id: "default" } });
  if (!settings?.qbAccessToken || !settings?.qbRealmId) {
    throw new QBAuthError("QuickBooks not connected. Go to Admin → Settings to connect.");
  }

  validateEnvironment(settings.qbRealmId);

  if (settings.qbTokenExpiresAt && settings.qbRefreshToken) {
    const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);
    if (settings.qbTokenExpiresAt < fiveMinFromNow) {
      if (!_refreshPromise) {
        _refreshPromise = refreshAccessToken(settings.qbRefreshToken, settings.qbRealmId)
          .finally(() => { _refreshPromise = null; });
      }
      return _refreshPromise;
    }
  }

  return { accessToken: settings.qbAccessToken, realmId: settings.qbRealmId };
}

async function refreshAccessToken(
  refreshToken: string,
  realmId: string,
): Promise<{ accessToken: string; realmId: string }> {
  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new QBAuthError("QB_CLIENT_ID/QB_CLIENT_SECRET not configured");

  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    throw new QBAuthError(`QB token refresh failed (${res.status}). Reconnect in Admin → Settings.`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  await prisma.settings.update({
    where: { id: "default" },
    data: {
      qbAccessToken: data.access_token,
      qbRefreshToken: data.refresh_token,
      qbTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
    },
  });

  return { accessToken: data.access_token, realmId };
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function qbFetch<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const { accessToken, realmId } = await getTokens();
  const url = `${API_BASE}/v3/company/${realmId}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
      ...(opts?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `QuickBooks API error (${res.status})`;
    try {
      const body = await res.json();
      if (body.Fault?.Error?.[0]?.Detail) {
        message = body.Fault.Error[0].Detail;
      }
    } catch { /* not JSON */ }
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Customer lookup (used by Sales Receipt + Refund Receipt writes)
// ---------------------------------------------------------------------------
type QBCustomer = { Id: string; DisplayName: string };

/**
 * Find or create a QB customer by phone number. Cached on Driver.qbCustomerId
 * the first time we write a receipt for them, so subsequent receipts skip
 * this round-trip.
 */
export async function findOrCreateCustomer(opts: {
  name: string;
  phone: string;
  email?: string;
}): Promise<QBCustomer> {
  const digits = opts.phone.replace(/\D/g, "");
  // Sanitize name separately so we can fall back if non-ASCII chars consume it entirely.
  const sanitizedName = sanitizeForQb(opts.name, 85) || "Driver";
  const displayName = `${sanitizedName} (${digits})`;
  // QB QQL uses SQL-style single-quote escaping (double the quote, not backslash).
  const escapedForQql = displayName.replace(/'/g, "''");
  const searchRes = await qbFetch<{ QueryResponse: { Customer?: QBCustomer[] } }>(
    `/query?query=${encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${escapedForQql}' MAXRESULTS 1`)}`,
  );

  if (searchRes.QueryResponse.Customer?.length) {
    return searchRes.QueryResponse.Customer[0];
  }

  const createRes = await qbFetch<{ Customer: QBCustomer }>(
    "/customer",
    {
      method: "POST",
      body: JSON.stringify({
        DisplayName: displayName,
        PrimaryPhone: { FreeFormNumber: digits },
        PrimaryEmailAddr: opts.email ? { Address: opts.email } : undefined,
      }),
    },
  );

  return createRes.Customer;
}

// ---------------------------------------------------------------------------
// Service item lookup — required by Sales Receipt + Refund Receipt lines
// ---------------------------------------------------------------------------

let cachedServiceItemId: string | null = null;
let cachedDepositAccountId: string | undefined = undefined;

/**
 * Returns the QB Account ID to use as DepositToAccountRef on Sales Receipts
 * and Refund Receipts. Tries Bank accounts first, then falls back to
 * Undeposited Funds (Other Current Asset) which QB sandbox always has.
 * Throws if nothing is found so the caller gets a clear error instead of a
 * silent "required parameter missing" rejection from QB.
 */
async function getDepositAccountId(): Promise<string> {
  if (cachedDepositAccountId !== undefined) return cachedDepositAccountId;

  // Try bank accounts (real company setup).
  const bankRes = await qbFetch<{ QueryResponse: { Account?: Array<{ Id: string; Name: string }> } }>(
    `/query?query=${encodeURIComponent("SELECT Id, Name FROM Account WHERE AccountType = 'Bank' MAXRESULTS 1")}`,
  );
  const bankId = bankRes.QueryResponse.Account?.[0]?.Id;
  if (bankId) { cachedDepositAccountId = bankId; return bankId; }

  // Fall back to Undeposited Funds / Other Current Asset (QB sandbox default).
  const ufRes = await qbFetch<{ QueryResponse: { Account?: Array<{ Id: string; Name: string }> } }>(
    `/query?query=${encodeURIComponent("SELECT Id, Name FROM Account WHERE AccountType = 'Other Current Asset' MAXRESULTS 5")}`,
  );
  const ufAccount = ufRes.QueryResponse.Account?.find(
    (a) => a.Name.toLowerCase().includes("undeposited") || a.Name.toLowerCase().includes("funds"),
  ) ?? ufRes.QueryResponse.Account?.[0];
  if (ufAccount) {
    console.warn(
      `[QuickBooks] No Bank account found — using "${ufAccount.Name}" as the deposit account for receipts.\n` +
      `  To fix: in QuickBooks, go to Chart of Accounts and add a Bank account (e.g. "Checking").\n` +
      `  Then disconnect and reconnect QuickBooks in the admin Settings tab so the new account is picked up.`
    );
    cachedDepositAccountId = ufAccount.Id;
    return ufAccount.Id;
  }

  throw new Error(
    "No Bank or Undeposited Funds account found in QuickBooks. Create a bank account before writing receipts.",
  );
}

/**
 * Returns the QB Item ID to attach to receipt lines. Queries QB for any
 * existing Service-type item (uses the first one found), and creates a
 * "Parking Services" item backed by the first income account if none exist.
 *
 * Result is cached in memory for the process lifetime to avoid a round-trip
 * on every receipt write.
 */
async function getServiceItemId(): Promise<string> {
  if (cachedServiceItemId) return cachedServiceItemId;

  const itemRes = await qbFetch<{ QueryResponse: { Item?: Array<{ Id: string }> } }>(
    `/query?query=${encodeURIComponent("SELECT Id FROM Item WHERE Type = 'Service' MAXRESULTS 1")}`,
  );
  if (itemRes.QueryResponse.Item?.length) {
    cachedServiceItemId = itemRes.QueryResponse.Item[0].Id;
    return cachedServiceItemId;
  }

  // No service items — create one. Needs an income account reference.
  const acctRes = await qbFetch<{ QueryResponse: { Account?: Array<{ Id: string }> } }>(
    `/query?query=${encodeURIComponent("SELECT Id FROM Account WHERE AccountType = 'Income' MAXRESULTS 1")}`,
  );
  const incomeAccountId = acctRes.QueryResponse.Account?.[0]?.Id;
  if (!incomeAccountId) {
    throw new Error("No income account found in QB — create one before connecting QuickBooks.");
  }

  const createRes = await qbFetch<{ Item: { Id: string } }>(
    "/item",
    {
      method: "POST",
      body: JSON.stringify({
        Name: "Parking Services",
        Type: "Service",
        IncomeAccountRef: { value: incomeAccountId },
      }),
    },
  );

  cachedServiceItemId = createRes.Item.Id;
  return cachedServiceItemId;
}

// ---------------------------------------------------------------------------
// Sales Receipt write — called from Stripe webhook on successful charge
// ---------------------------------------------------------------------------

type QBSalesReceipt = { Id: string; DocNumber: string; TotalAmt: number };

/**
 * Write a Sales Receipt to QB. Idempotent by Stripe event ID — the event ID
 * PrivateNote format (canonical): `charge:${stripeChargeId} ref:${stripeEventId}`
 * The charge ID is always first and is the deduplication key — we query QB for
 * an existing receipt with that charge ID before creating a new one. This catches
 * duplicates regardless of which caller path (webhook vs admin sync) wrote the
 * original.
 *
 * Returns the QB Sales Receipt (existing or new) so callers can store its ID.
 */
export async function writeSalesReceipt(args: {
  customerId: string;
  amount: number;
  description: string;
  stripeEventId: string;
  stripeChargeId: string;
}): Promise<QBSalesReceipt> {
  // Pre-check: query QB for any receipt already tagged with this charge ID.
  // The LIKE query matches both the new `charge:xxx ref:yyy` format and the
  // legacy `stripe:xxx charge:xxx` format written by earlier code.
  const searchRes = await qbFetch<{ QueryResponse: { SalesReceipt?: QBSalesReceipt[] } }>(
    `/query?query=${encodeURIComponent(`SELECT * FROM SalesReceipt WHERE PrivateNote LIKE '%charge:${args.stripeChargeId}%' MAXRESULTS 1`)}`,
  ).catch(() => null);
  const existing = searchRes?.QueryResponse?.SalesReceipt?.[0];
  if (existing) return existing;

  // Canonical PrivateNote: charge ID first so it's the sortable/searchable key.
  const privateNote = `charge:${args.stripeChargeId} ref:${args.stripeEventId}`;

  const [itemId, depositAccountId] = await Promise.all([getServiceItemId(), getDepositAccountId()]);

  const createRes = await qbFetch<{ SalesReceipt: QBSalesReceipt }>(
    "/salesreceipt",
    {
      method: "POST",
      body: JSON.stringify({
        CustomerRef: { value: args.customerId },
        DepositToAccountRef: { value: depositAccountId },
        Line: [
          {
            Amount: args.amount,
            DetailType: "SalesItemLineDetail",
            Description: sanitizeForQb(args.description, 4000),
            SalesItemLineDetail: {
              ItemRef: { value: itemId },
              UnitPrice: args.amount,
              Qty: 1,
            },
          },
        ],
        PrivateNote: privateNote,
      }),
    },
  );

  return createRes.SalesReceipt;
}

export async function getSalesReceipt(id: string): Promise<QBSalesReceiptListItem> {
  const res = await qbFetch<{ SalesReceipt: QBSalesReceiptListItem }>(
    `/salesreceipt/${encodeURIComponent(id)}?minorversion=65`,
  );
  return res.SalesReceipt;
}

// ---------------------------------------------------------------------------
// Refund Receipt write — called from Stripe webhook on charge.refunded
// ---------------------------------------------------------------------------

type QBRefundReceipt = { Id: string; DocNumber: string; TotalAmt: number };

export async function writeRefundReceipt(args: {
  customerId: string;
  amount: number;
  description: string;
  stripeEventId: string;
  stripeRefundId: string;
  stripeChargeId?: string;
  linkedSalesReceiptId?: string;
}): Promise<QBRefundReceipt> {
  // Pre-check: return existing RefundReceipt if this refund ID was already written.
  const searchRes = await qbFetch<{ QueryResponse: { RefundReceipt?: QBRefundReceipt[] } }>(
    `/query?query=${encodeURIComponent(`SELECT * FROM RefundReceipt WHERE PrivateNote LIKE '%refund:${args.stripeRefundId}%' MAXRESULTS 1`)}`,
  ).catch(() => null);
  const existing = searchRes?.QueryResponse?.RefundReceipt?.[0];
  if (existing) return existing;

  // Canonical PrivateNote: refund ID first (dedup key), then charge ID, then event ref.
  const chargeRef = args.stripeChargeId ? ` charge:${args.stripeChargeId}` : "";
  const salesRef = args.linkedSalesReceiptId ? ` salesreceipt:${args.linkedSalesReceiptId}` : "";
  const privateNote = `refund:${args.stripeRefundId}${chargeRef} ref:${args.stripeEventId}${salesRef}`;

  const [itemId, depositAccountId] = await Promise.all([getServiceItemId(), getDepositAccountId()]);

  const createRes = await qbFetch<{ RefundReceipt: QBRefundReceipt }>(
    "/refundreceipt",
    {
      method: "POST",
      body: JSON.stringify({
        CustomerRef: { value: args.customerId },
        // DepositToAccountRef here means the bank account FROM which the
        // refund is paid. Must match the original SalesReceipt's account so
        // QB bank reconciliation can match both sides.
        DepositToAccountRef: { value: depositAccountId },
        Line: [
          {
            Amount: args.amount,
            DetailType: "SalesItemLineDetail",
            Description: sanitizeForQb(
              args.linkedSalesReceiptId
                ? `${args.description} (Sales Receipt #${args.linkedSalesReceiptId})`
                : args.description,
              4000,
            ),
            SalesItemLineDetail: {
              ItemRef: { value: itemId },
              UnitPrice: args.amount,
              Qty: 1,
            },
          },
        ],
        PrivateNote: privateNote,
      }),
    },
  );

  return createRes.RefundReceipt;
}

export async function getRefundReceipt(id: string): Promise<QBRefundReceiptListItem> {
  const res = await qbFetch<{ RefundReceipt: QBRefundReceiptListItem }>(
    `/refundreceipt/${encodeURIComponent(id)}?minorversion=65`,
  );
  return res.RefundReceipt;
}

// ---------------------------------------------------------------------------
// List recent Sales Receipts — used by the Charges & Receipts reconcile tab
// ---------------------------------------------------------------------------

export type QBSalesReceiptListItem = {
  Id: string;
  DocNumber: string;
  TxnDate: string;           // "YYYY-MM-DD"
  TotalAmt: number;
  CustomerRef: { value: string; name?: string } | null;
  PrivateNote: string | null; // contains "charge:ch_xxx ref:evt_xxx" for our receipts
};

export async function listRecentSalesReceipts(sinceDaysAgo: number): Promise<QBSalesReceiptListItem[]> {
  const since = new Date(Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000);
  const dateStr = since.toISOString().split("T")[0];
  const query = `SELECT * FROM SalesReceipt WHERE TxnDate >= '${dateStr}' ORDERBY TxnDate DESC MAXRESULTS 200`;
  const res = await qbFetch<{
    QueryResponse: { SalesReceipt?: QBSalesReceiptListItem[] };
  }>(`/query?query=${encodeURIComponent(query)}`);
  return res.QueryResponse.SalesReceipt ?? [];
}

export type QBRefundReceiptListItem = {
  Id: string;
  DocNumber: string;
  TxnDate: string;
  TotalAmt: number;
  CustomerRef: { value: string; name?: string } | null;
  PrivateNote: string | null; // contains "refund:re_xxx charge:ch_xxx ref:evt_xxx"
};

export async function listRecentRefundReceipts(sinceDaysAgo: number): Promise<QBRefundReceiptListItem[]> {
  const since = new Date(Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000);
  const dateStr = since.toISOString().split("T")[0];
  const query = `SELECT * FROM RefundReceipt WHERE TxnDate >= '${dateStr}' ORDERBY TxnDate DESC MAXRESULTS 200`;
  const res = await qbFetch<{
    QueryResponse: { RefundReceipt?: QBRefundReceiptListItem[] };
  }>(`/query?query=${encodeURIComponent(query)}`);
  return res.QueryResponse.RefundReceipt ?? [];
}
