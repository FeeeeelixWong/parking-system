# Needs Review Actionability Plan

**Branch**: `planning/needs-review-actionability`  
**Status**: Planning only — no runtime code changed.

---

## Summary

Needs Review detects 16 issue codes. Two have concrete fix actions today.
The other 14 leave the admin with vague "Review X" text and no button. Before
the UI refresh proceeds, the backend contract needs to:

1. Move `actionPath` from the UI into the API response.
2. Fix the mislabeled action on `QB_REFUND_RECEIPT_MISSING`.
3. Define a durable disposition model so resolved/snoozed/manually-handled
   items have an audit trail.
4. Expose secondary evidence links (Stripe/QB URLs) server-side for every
   code that references external systems.
5. Provide classification actions for `SUBSCRIPTION_DELETION_UNKNOWN`.

---

## Current Actionability Matrix

Every `NeedsReviewCode`, its current action type, and the gap.

| Code | Severity | Current Action | Action Type | Gap |
|------|----------|---------------|-------------|-----|
| `QB_RECEIPT_MISSING` | warning | POST `sync-receipt` | **Concrete fix** | `actionPath` is UI-hardcoded by code, not API-returned |
| `QB_REFUND_RECEIPT_MISSING` | warning | POST `sync-refunds` | **Mislabeled** | `sync-refunds` re-fetches Stripe charge and updates DB refund rows — it does NOT write a QB refund receipt. The button says "Sync refund receipt" but doesn't do that. |
| `SUBSCRIPTION_PAYMENT_FAILED` | warning | External link (optional) | **Partial** | Invoice URL only present if stored; no secondary Stripe subscription link; no "Mark Contacted" disposition |
| `COMPLETED_SESSION_WITHOUT_PAYMENT` | critical | None | **Vague** | "Review session" text, no button, no session link, no disposition |
| `DB_PAYMENT_WITHOUT_STRIPE_CHARGE` | critical | None | **Vague** | "Review payment" text; no Stripe dashboard link; no manual-reconcile action |
| `DB_STRIPE_AMOUNT_MISMATCH` | critical | None | **Evidence-only (intentional)** | "View details" — correct to not auto-fix; needs Stripe charge link in `secondaryActions` |
| `QB_RECEIPT_AMOUNT_MISMATCH` | warning | None | **Evidence-only** | "View details" — correct to not auto-fix; needs QB/Stripe links |
| `QB_REFUND_AMOUNT_MISMATCH` | warning | None | **Evidence-only** | Same as above for refund receipts |
| `REFUND_DETAIL_MISSING` | warning | None | **Missing concrete fix** | `sync-refunds` IS the right action here (re-fetches Stripe charge refunds, updates DB), but it is not wired to this code |
| `STRIPE_INVOICE_WITHOUT_DB_PAYMENT` | warning | None | **Vague** | "Review subscription"; Stripe subscription/invoice link missing |
| `SUBSCRIPTION_DELINQUENT` | critical | None | **Vague** | "Review subscription"; no Stripe link; no "Mark Contacted" or "Mark Manual Collection" disposition |
| `SUBSCRIPTION_DELETION_UNKNOWN` | critical | None | **Vague** | "Review subscription"; requires a classification decision — admin must choose between DELINQUENT, expected expiry, or unknown-acknowledged |
| `ACTIVE_SESSION_PAST_EXPECTED_END` | warning | None | **Vague** | "Review session"; no link to admin Sessions tab; no "Close Session" or "Trigger Cron" action |
| `CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE` | warning | None | **Vague** | "Review cancellation"; needs "Issue Refund" (high-risk, needs confirmation) and "Mark Retained Payment Intentional" disposition |
| `SUBSCRIPTION_CANCELLED_BUT_ACCESS_ACTIVE` | critical | None | **Vague** | "Review session"; access is past expectedEnd; needs link to admin Sessions/Manage |
| `SUBSCRIPTION_CANCELLED_ACCESS_STILL_VALID` | warning | None | **Vague** | "Review session"; no information on expiry deadline; no "Snooze until expiry" option |

---

## The Biggest Single Contract Violation

`NeedsReviewItem` has `actionHref` and `actionLabel` but no `actionPath`. The
design handoff (`docs/DESIGN_HANDOFF_NEEDS_REVIEW_INBOX.md`) states:

> "The backend controls actions. The UI should not infer actions from issue code."
> "If `actionPath` exists, render a POST action button."

But `NeedsReviewTab.tsx:106–113` does exactly what the handoff forbids:

```typescript
function actionPath(item: NeedsReviewItem) {
  if (item.code === "QB_RECEIPT_MISSING" && item.related.paymentId)
    return `/api/admin/payments/${item.related.paymentId}/sync-receipt`;
  if (item.code === "QB_REFUND_RECEIPT_MISSING" && item.related.paymentId)
    return `/api/admin/payments/${item.related.paymentId}/sync-refunds`;
  return null;
}
```

Consequences:
- Every new code that needs a button requires a UI code change.
- `QB_REFUND_RECEIPT_MISSING` is wired to the wrong endpoint (`sync-refunds` ≠
  "write QB refund receipt").
- The design agent is handed a contract that the codebase does not implement.

---

## Proposed `NeedsReviewItem` Shape Changes

Add to the existing type (non-breaking — new optional fields only):

```typescript
type NeedsReviewItem = {
  // ── Existing fields (unchanged) ──────────────────────────────────────────
  id: string;
  code: NeedsReviewCode;
  severity: NeedsReviewSeverity;
  title: string;
  detail: string;
  recommendedAction: string;
  actionLabel?: string;
  actionHref?: string;           // external link — keep as-is
  related: { ... };
  nearbyQbMatches?: [...];
  occurredAt?: string;

  // ── New fields ────────────────────────────────────────────────────────────
  actionPath?: string;           // internal POST endpoint (moves from UI to API)
  actionMethod?: "POST";         // always POST for now; explicit for future PATCH
  actionBody?: Record<string, string>; // body payload for link-* actions

  secondaryActions?: {
    label: string;
    href?: string;               // external link
    path?: string;               // internal navigation (admin Sessions tab etc.)
  }[];

  accessStatus?: {
    blocked: boolean;            // is gate access currently blocked?
    reason?: string;             // plain-language reason
    unblockedUntil?: string;     // ISO date — when does grace period expire?
  };

  dispositionOptions?: (
    | "contacted"
    | "snoozed"
    | "manual_collection"
    | "retained_payment_intentional"
    | "classified_delinquent"
    | "classified_expected_expiry"
    | "acknowledged"
  )[];

  currentDisposition?: {
    disposition: string;
    reason: string;
    actor: string;               // "admin" or future user identifier
    createdAt: string;
    snoozedUntil?: string;
  };
};
```

### What each new field does

| Field | Purpose |
|-------|---------|
| `actionPath` | Replaces the UI `actionPath()` function. API returns the exact path. |
| `actionMethod` | Always `"POST"`. Explicit so the UI never needs to guess. |
| `actionBody` | For `link-qb-receipt` and `link-qb-refund-receipt`, body is `{ qbSalesReceiptId }` or `{ refundId, qbRefundReceiptId }`. Currently only in `nearbyQbMatches[].linkActionBody`; promote to top-level for primary action. |
| `secondaryActions` | Evidence links and navigation: Stripe dashboard, QB receipt, Sessions tab. Never money-moving. |
| `accessStatus` | Tells the UI whether access is currently blocked. UI should show this plainly without computing it from `billingStatus`. |
| `dispositionOptions` | Tells the UI which disposition buttons to show. UI never infers from code. |
| `currentDisposition` | If a disposition exists, the item may be hidden from the default inbox or shown as "snoozed." |

---

## Proposed Disposition Data Model

A new table. No FK to sessions or payments — Needs Review items are computed,
not stored; the disposition is the durable record.

```prisma
model NeedsReviewDisposition {
  id           String    @id @default(uuid())
  // Stable item ID: same hash as NeedsReviewItem.id (code:sessionId:paymentId:refundId)
  itemId       String
  code         String    // NeedsReviewCode — denormalized for queries
  disposition  String    // one of the disposition option strings above
  createdBy    String    // actor — "admin" for now; extensible to user ID later
  reason       String    // required, non-empty — "contacted via SMS", "Stripe says payment expected", etc.
  notes        String?   // optional free text
  snoozedUntil DateTime? // required when disposition = "snoozed"
  createdAt    DateTime  @default(now())
  // No updatedAt — dispositions are immutable records. Create a new one to supersede.

  @@index([itemId])
  @@index([code])
}
```

Rules:
- Every disposition requires a non-empty `reason`. UI must enforce this; API
  must validate it.
- Dispositions do not delete or hide issues from reconcile evidence. They only
  affect Needs Review inbox visibility.
- "Resolve" is never silent. The word "Resolve" should not appear in UI copy
  without also showing the reason field and an explicit consequence description.
- Multiple dispositions on the same `itemId` are allowed. The newest one wins
  for inbox visibility.

### Inbox visibility rules

| Disposition | Inbox visibility |
|-------------|-----------------|
| `contacted` | Still visible — issue is not closed |
| `snoozed` | Hidden from inbox until `snoozedUntil` |
| `manual_collection` | Hidden — admin has taken responsibility |
| `retained_payment_intentional` | Hidden — conscious decision recorded |
| `classified_delinquent` | Drives DB state change; the original item disappears, replaced by `SUBSCRIPTION_DELINQUENT` |
| `classified_expected_expiry` | Drives DB state change; item disappears |
| `acknowledged` | Hidden for 7 days; reappears if underlying data is still present |

---

## Proposed API Endpoints

### 1. `POST /api/admin/needs-review/:itemId/disposition`

Create or supersede a disposition for a Needs Review item.

**Request body**:
```json
{
  "disposition": "snoozed",
  "reason": "Stripe says retry scheduled for May 20",
  "notes": "Called driver, left voicemail",
  "snoozedUntil": "2026-05-20T00:00:00Z"
}
```

**Validation**:
- `disposition` must be in `dispositionOptions` for the item's code (server validates, not just client).
- `reason` required and non-empty for all dispositions.
- `snoozedUntil` required when `disposition = "snoozed"`.
- `snoozedUntil` must be in the future.
- Financial dispositions (`retained_payment_intentional`, `manual_collection`) write an `AuditLog` entry.

**Response**:
```json
{
  "ok": true,
  "dispositionId": "uuid",
  "hiddenFromInbox": true,
  "snoozedUntil": "2026-05-20T00:00:00Z"
}
```

### 2. `DELETE /api/admin/needs-review/:itemId/disposition/:dispositionId`

Remove a disposition (un-snooze, retract an acknowledged state). Does not
delete the audit record — marks it superseded.

### 3. `POST /api/admin/payments/:id/sync-refund-receipt`

**New endpoint** — writes the actual QB Refund Receipt for a payment's Stripe
refund. Distinct from `sync-refunds`, which only updates DB refund state.

**What it does**:
1. Fetch `PaymentRefund` rows for the payment.
2. For each refund without `qbRefundReceiptId`, call `writeRefundReceipt()`.
3. Update `PaymentRefund.qbRefundReceiptId`.
4. Write audit log.

**Response shape** mirrors `sync-receipt`:
```json
{
  "ok": true,
  "refundId": "uuid",
  "qbRefundReceiptId": "qb_id",
  "alreadySynced": false
}
```

This endpoint becomes the `actionPath` for `QB_REFUND_RECEIPT_MISSING` in the
needs-review route. `sync-refunds` becomes the `actionPath` for
`REFUND_DETAIL_MISSING` only.

### 4. `POST /api/admin/sessions/:id/classify-subscription-deletion`

Resolves `SUBSCRIPTION_DELETION_UNKNOWN` by making an explicit classification.

**Request body**:
```json
{
  "classification": "delinquent",
  "reason": "Driver stopped responding; Stripe shows 4 failed invoices"
}
```

`classification` options:
- `"delinquent"` — sets `billingStatus = DELINQUENT`, `billingDelinquentAt = now()`.
- `"expected_expiry"` — sets `cancellationDisposition = "ADMIN_CANCELLED"` (or equivalent); removes the audit flag.
- `"acknowledged"` — records that admin reviewed and could not classify; snoozes the item for 30 days.

Writes `AuditLog` in all cases.

---

## Per-Code Action Recommendations

### QB accounting mirror codes

| Code | Recommended `actionPath` | Notes |
|------|--------------------------|-------|
| `QB_RECEIPT_MISSING` | `POST /api/admin/payments/:id/sync-receipt` | Already exists. Move from UI to API response. |
| `QB_REFUND_RECEIPT_MISSING` | `POST /api/admin/payments/:id/sync-refund-receipt` | New endpoint needed. Current `sync-refunds` is wrong. |
| `REFUND_DETAIL_MISSING` | `POST /api/admin/payments/:id/sync-refunds` | Correct action; not currently wired to this code. |
| `QB_RECEIPT_AMOUNT_MISMATCH` | None — evidence-only | Add `secondaryActions`: QB receipt link, Stripe charge link. Add `acknowledged` disposition. |
| `QB_REFUND_AMOUNT_MISMATCH` | None — evidence-only | Same pattern. |

### Amount mismatch / missing proof codes

| Code | Action | Reasoning |
|------|--------|-----------|
| `DB_STRIPE_AMOUNT_MISMATCH` | Evidence-only | Could indicate webhook bug or fraud. Admin must investigate Stripe manually. Add Stripe charge link as `secondaryActions`. Add `acknowledged` disposition. |
| `DB_PAYMENT_WITHOUT_STRIPE_CHARGE` | Evidence-only | DB shows payment but no Stripe proof. Admin must look up Stripe manually. Add Stripe dashboard link. Add `manual_collection` disposition option. |
| `COMPLETED_SESSION_WITHOUT_PAYMENT` | Evidence-only | Could be cash payment, waived session, or data error. Add `manual_collection` disposition with required reason. |

### Subscription lifecycle codes

| Code | Action | Notes |
|------|--------|-------|
| `SUBSCRIPTION_PAYMENT_FAILED` | `actionHref`: Stripe invoice URL (existing). Add `secondaryActions` with Stripe subscription link always present. Add `contacted` disposition option. Show `accessStatus` with grace period deadline. | Invoice URL already works when present; make it always present when a subscriptionId exists. |
| `SUBSCRIPTION_DELINQUENT` | No direct fix — evidence + disposition. `secondaryActions`: Stripe subscription link, admin Sessions tab link. `dispositionOptions`: `["contacted", "manual_collection"]`. Show `accessStatus.blocked = true`. | Access is blocked. Admin must contact driver. Manual resolution options. |
| `SUBSCRIPTION_DELETION_UNKNOWN` | `actionPath`: `POST /api/admin/sessions/:id/classify-subscription-deletion` (new). `actionLabel`: "Classify Deletion". Required classification decision. | This is the only code where the primary action changes DB state in a non-reversible way. Confirmation modal required. |
| `STRIPE_INVOICE_WITHOUT_DB_PAYMENT` | No direct fix — evidence. `secondaryActions`: Stripe subscription link. `dispositionOptions`: `["acknowledged"]`. | Recovery would require creating a payment row from invoice data — too risky to automate. |
| `SUBSCRIPTION_CANCELLED_BUT_ACCESS_ACTIVE` | No direct fix. `secondaryActions`: Admin Sessions tab with session pre-selected. `accessStatus.blocked = false` (anomalous — access should be blocked). | Admin should close/cancel via Session Management modal, not a one-click Needs Review action. |
| `SUBSCRIPTION_CANCELLED_ACCESS_STILL_VALID` | No action needed immediately. Show `accessStatus.unblockedUntil = expectedEnd`. `dispositionOptions`: `["snoozed"]` with suggested `snoozedUntil = expectedEnd`. | Admin should monitor. Snoozed until paid access expires is the natural resolution. |

### Session lifecycle codes

| Code | Action | Notes |
|------|--------|-------|
| `ACTIVE_SESSION_PAST_EXPECTED_END` | No direct fix. `secondaryActions`: Admin Sessions tab link (or Run Session Check trigger if the cron endpoint is safe to expose). `dispositionOptions`: `["acknowledged"]`. | Cron should handle this. If cron is stuck, admin may need to trigger it. Consider a `POST /api/admin/cron/check-sessions` endpoint. |
| `CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE` | No direct fix — high-risk. `secondaryActions`: Admin Sessions tab link, Stripe charge link. `dispositionOptions`: `["retained_payment_intentional"]`. A future "Issue Refund" action could be added but requires a confirmation modal with full consequence summary. | Do not add a one-click "Issue Refund" to Needs Review without a multi-step confirmation flow. This moves money. |

---

## Codes That Should Remain Evidence-Only

The following codes should never have a primary `actionPath` because automatic
resolution would be unsafe or require human judgment:

| Code | Why evidence-only |
|------|-------------------|
| `DB_STRIPE_AMOUNT_MISMATCH` | Amount difference could be fraud, partial refund, or webhook bug. Admin must investigate Stripe and decide whether to correct DB or issue adjustment. |
| `QB_RECEIPT_AMOUNT_MISMATCH` | Fixing requires voiding and re-writing a QB receipt. QB API does not support safe atomic void+rewrite. Admin must handle in QB directly. |
| `QB_REFUND_AMOUNT_MISMATCH` | Same as above for refund receipts. |
| `DB_PAYMENT_WITHOUT_STRIPE_CHARGE` | DB says paid, Stripe proof missing. Automated fix risks acknowledging a payment that never happened. Admin must find the Stripe charge first. |
| `COMPLETED_SESSION_WITHOUT_PAYMENT` | Could be legitimate (cash, waived), data error, or fraud. No safe auto-resolution. |
| `STRIPE_INVOICE_WITHOUT_DB_PAYMENT` | Creating DB payment rows from invoice data is risky without human review of what each invoice represents. |
| `CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE` | Issuing a Stripe refund from Needs Review requires a full confirmation flow, not a one-click action. |

---

## Risks and Non-Goals

### Risks

- **Disposition hiding real issues**: A snoozed item might remain snoozed past
  its relevance. Mitigation: always re-surface if underlying data changes (e.g.,
  a snoozed `SUBSCRIPTION_PAYMENT_FAILED` should re-appear if `billingStatus`
  escalates to `DELINQUENT`).

- **`classify-subscription-deletion` race**: If the admin classifies a deletion
  as "expected expiry" but Stripe later fires another event, the classification
  may be wrong. Mitigation: only `acknowledged` and `expected_expiry` hide the
  item; write an audit log on any subsequent Stripe event.

- **`sync-refund-receipt` and duplicate QB receipts**: QB does not prevent
  duplicate receipts by Stripe refund ID. The endpoint must check for an
  existing QB refund receipt by `stripeRefundId` in `PrivateNote` before
  writing a new one. Same idempotency pattern as `sync-receipt`.

- **Disposition table and stale `itemId` hashes**: If session/payment IDs
  change (migration, re-seed), `itemId` hashes become orphaned. The table
  should be treated as advisory, not authoritative.

### Non-Goals

- Do not redesign the UI.
- Do not modify Stripe payment processing.
- Do not treat QB as payment truth.
- Do not add a bulk "Resolve all" action.
- Do not allow disposition without reason. Silent resolution is not allowed.
- Do not add a "Fix" button to amount mismatch codes.
- Do not implement `classify-subscription-deletion` without a confirmation
  modal showing the exact DB and access consequence.

---

## Proposed Implementation Phases

### Phase 1 — Move `actionPath` to API (no schema change, no new endpoints)

**Scope**: `src/types/reconcile.ts`, `src/app/api/admin/reconcile/needs-review/route.ts`, `src/app/admin/NeedsReviewTab.tsx`

Changes:
1. Add `actionPath`, `actionMethod`, `secondaryActions` to `NeedsReviewItem` type.
2. Populate `actionPath` server-side in the needs-review route for `QB_RECEIPT_MISSING` and `REFUND_DETAIL_MISSING`.
3. Add Stripe subscription/invoice `secondaryActions` to subscription codes whenever a `stripeSubscriptionId` is available.
4. Remove the `actionPath()` function from `NeedsReviewTab.tsx`. Use `item.actionPath` directly.
5. Add `accessStatus` to `SUBSCRIPTION_DELINQUENT`, `SUBSCRIPTION_CANCELLED_BUT_ACCESS_ACTIVE`.

**Tests**: Extend `tests/e2e/admin-write/api/demo-filter.spec.ts` to assert that `QB_RECEIPT_MISSING` items include `actionPath` in the API response.

**Value**: Unblocks design agent with a correct contract. Fixes the `actionPath`-in-UI violation. Zero schema or money risk.

---

### Phase 2 — Fix `QB_REFUND_RECEIPT_MISSING` action

**Scope**: New file `src/app/api/admin/payments/[id]/sync-refund-receipt/route.ts`

Changes:
1. Create `POST .../sync-refund-receipt`: resolves Stripe refund IDs, calls `writeRefundReceipt()`, updates `PaymentRefund.qbRefundReceiptId`, writes audit log.
2. Update needs-review route: `QB_REFUND_RECEIPT_MISSING` → `actionPath: .../sync-refund-receipt`.
3. Update `NeedsReviewTab.tsx` write widget to show correct steps for new endpoint.

**Tests**: Unit-level test asserting `sync-refund-receipt` calls `writeRefundReceipt` and updates `PaymentRefund`; E2E test in `tests/e2e/admin-write/api/` asserting `QB_REFUND_RECEIPT_MISSING` item after payment seeding.

**Value**: Fixes the mislabeled action. QB refund receipts actually get synced.

---

### Phase 3 — Disposition model

**Scope**: `prisma/schema.prisma`, new migration, `src/app/api/admin/needs-review/[itemId]/disposition/route.ts`, `src/app/admin/NeedsReviewTab.tsx`

Changes:
1. Add `NeedsReviewDisposition` model to schema + migration.
2. Create disposition endpoint with full validation.
3. Update needs-review route to query existing dispositions and attach `currentDisposition` and filter snoozed items.
4. Add `dispositionOptions` to subscription codes and `CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE`.
5. UI: render disposition buttons based on `item.dispositionOptions`. Modal with required reason field.

**Tests**: `tests/e2e/admin-write/api/needs-review-disposition.spec.ts` — create disposition, assert item hidden, assert audit log written.

**Value**: Admins can record "contacted", "snoozed", "retained payment" without silent resolution.

---

### Phase 4 — Subscription deletion classification

**Scope**: `src/app/api/admin/sessions/[id]/classify-subscription-deletion/route.ts`

Changes:
1. New endpoint: validates `classification` enum, updates session `billingStatus` / `cancellationDisposition`, writes audit log.
2. Update needs-review route: `SUBSCRIPTION_DELETION_UNKNOWN` gets `actionPath` pointing to new endpoint, `dispositionOptions: ["classified_delinquent", "classified_expected_expiry", "acknowledged"]`.
3. UI: classification action requires a confirmation modal explaining consequences.

**Tests**: E2E test seeding an unknown-deletion audit log entry, asserting classification changes DB state and removes item from Needs Review.

**Value**: Resolves the only code that currently has zero safe next step.

---

### Phase 5 — Access management and remaining evidence links

**Scope**: Needs-review route, existing admin sessions route, `src/app/admin/NeedsReviewTab.tsx`

Changes:
1. Add `secondaryActions` with deep links to Sessions tab (using `?sessionId=xxx` or equivalent) for `ACTIVE_SESSION_PAST_EXPECTED_END`, `SUBSCRIPTION_CANCELLED_BUT_ACCESS_ACTIVE`, `CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE`.
2. Add Stripe charge/receipt/subscription `secondaryActions` for all remaining codes.
3. Consider `POST /api/admin/cron/check-sessions` as admin-triggerable action for `ACTIVE_SESSION_PAST_EXPECTED_END` if cron is reliably idempotent.

**Tests**: Assert `secondaryActions` shape in E2E API tests.

**Value**: Removes the "Review X" dead ends. Every item now tells admin where to go next.

---

## Tests Needed Per Phase

| Phase | Test file | Assertions |
|-------|-----------|------------|
| 1 | Extend `demo-filter.spec.ts` | `QB_RECEIPT_MISSING` items include `actionPath`, `actionMethod`, `secondaryActions` |
| 1 | New `needs-review-contract.spec.ts` | Assert `actionPath` appears only in server response; UI no longer derives it |
| 2 | New `sync-refund-receipt.spec.ts` | POST `sync-refund-receipt` writes QB refund receipt; `QB_REFUND_RECEIPT_MISSING` uses new path |
| 3 | New `needs-review-disposition.spec.ts` | Create snoozed disposition → item hidden; create `retained_payment_intentional` → audit log written; reason required |
| 4 | New `classify-subscription-deletion.spec.ts` | Classification changes `billingStatus`; item removed from Needs Review; audit log written |
| 5 | Extend `needs-review-contract.spec.ts` | All codes have `secondaryActions`; no code returns only vague text with no links |

---

## Recommended First Phase

**Phase 1** is the highest-value, lowest-risk change. It:

- Corrects the design contract violation immediately.
- Requires no schema change.
- Requires no new endpoints.
- Unblocks the design agent with an accurate API contract.
- Removes the `actionPath()` function from the UI, which is the root cause of
  the "UI hardcodes business logic" problem.

After Phase 1, the design agent can work against a stable contract where
`item.actionPath`, `item.actionHref`, and `item.secondaryActions` are all
server-authoritative.

Phase 2 should follow immediately: the mislabeled `QB_REFUND_RECEIPT_MISSING`
action is a visible functional bug (the button does something different from
what the label says), and it involves a code path the UI refresh will feature
prominently.

Phase 3 (dispositions) is the biggest scope and should be its own branch with
a schema migration review before merging.
