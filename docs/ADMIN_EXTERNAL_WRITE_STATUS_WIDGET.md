# Admin External Write Status Widget

Purpose: define a shared admin popup/widget for actions that write to Stripe and/or QuickBooks. The widget should make it obvious which systems were touched, which confirmations landed, which steps were skipped by design, and where manual follow-up is needed.

This is a design + implementation brief. It is not a new backend feature by itself.

## Why This Exists

Some admin actions are local-only. Others call Stripe, then mirror to QuickBooks, then update our DB. The admin should never have to infer whether "success" means:

- Stripe accepted the money movement,
- the DB reflected it,
- QuickBooks receipt/refund receipt was written,
- access/session state changed,
- or reconciliation is still needed.

The UI should show this as a compact checklist of systems affected by the action.

## Mental Model

Use a step checklist, not a linear progress bar.

A progress bar implies every action has the same ordered path. That is false:

- Syncing a QB receipt touches Stripe read + QB write + DB update.
- Issuing a refund touches Stripe write + DB/refund sync + QB refund receipt.
- Cancelling a monthly session can touch Stripe refund, Stripe subscription, DB session, access, and QB refund receipt.
- Some actions intentionally skip Stripe or QuickBooks.

Each row should represent a system effect:

```text
[done] Stripe refund created
[done] DB payment marked partially refunded
[warning] QuickBooks refund receipt pending
[done] Session access ends now
[done] Audit log written
```

## Status Vocabulary

Use these exact statuses so copy remains consistent:

| Status | Meaning | UI Treatment |
| --- | --- | --- |
| `pending` | Step has not started yet. | Muted row, spinner only during active request. |
| `working` | Request is in flight. | Spinner. |
| `confirmed` | External system or DB confirmed the effect. | Green/check. |
| `skipped` | Step does not apply to this action. | Gray/dash, short reason. |
| `warning` | Non-blocking partial failure or follow-up needed. | Yellow. |
| `failed` | Action failed before completion or left partial state. | Red. |

Avoid saying "synced" unless the step really wrote/confirmed the external mirror.

## Common Step Types

| Step Key | Label Examples | Applies When |
| --- | --- | --- |
| `stripe_refund` | Stripe refund created | Any admin refund / cancel-with-refund / adjust-with-refund. |
| `stripe_subscription` | Stripe subscription cancelled / cancellation scheduled | Monthly cancel or monthly access adjustment with renewal stop. |
| `stripe_read` | Stripe charge checked | Sync-refunds, sync-batch, sync receipt charge resolution. |
| `db_payment` | Payment row updated | Refund row/status/refunded amount changed. |
| `db_session` | Session row updated | Cancel, close, adjust access/end time. |
| `qb_sales_receipt` | QuickBooks sales receipt written | Manual QB receipt sync or checkout webhook mirror. |
| `qb_refund_receipt` | QuickBooks refund receipt written | Refund processing with QB mirror. |
| `access` | Parking access ended / access remains until date | Cancel/close/adjust monthly access. |
| `audit` | Audit log written | Any admin money/access action. |
| `needs_review` | Needs Review follow-up needed | QB failed, partial failure, external confirmation missing. |

## Trigger Rules

This widget is an external-write receipt, not a generic toast.

Trigger it when the admin needs an answer to:

```text
Did Stripe do it? Did QuickBooks do it? Did our database/access state do it?
```

### Trigger It For

| Action | Variant | Why |
| --- | --- | --- |
| Sync QB Sales Receipt | Inline result | Confirms Stripe charge resolution, QB Sales Receipt, DB receipt link. |
| Sync refunds | Inline result | Confirms Stripe refund state and DB update; QB receipt may be pending. |
| Batch refund sync | Batch result | Summarizes checked/synced/skipped/failed counts. |
| Admin refund | Modal result | Stripe money movement can land before DB/QB mirror catches up. |
| Daily adjust/cancel with refund | Modal result | Stripe refund + session/access state can diverge. |
| Monthly adjust/cancel | Drawer or modal result | Refund, subscription, session, access, audit, and QB mirror can partially land. |

### Do Not Trigger It For

Use a normal toast/banner for:

- editing driver info,
- editing settings,
- adding/removing allowlist rows,
- spot layout edits,
- opening a detail drawer,
- pure read/reconcile refresh,
- driver gate open events,
- viewing Stripe/QB links,
- any action that does not write Stripe/QB or materially change session access.

### Timing

1. Admin clicks an external write action.
2. Disable the initiating button.
3. Show local `working` state while the request is in flight.
4. When the API returns, open/render the widget with final statuses.
5. If the API returns partial `landed` state, show the partial-failure variant immediately.
6. Do not auto-dismiss warning/failed states.
7. Success-only compact states may be dismissible or collapse after review.

## Current Admin Write / Sync Paths

### 1. `POST /api/admin/refund`

What it does:

- Calls Stripe Refund API.
- Audits `REFUND_ISSUED`.
- Best-effort immediately processes the Stripe charge refund through `processChargeRefund`.
- `processChargeRefund` updates DB payment/refund rows and writes QB Refund Receipts when possible.
- If synchronous processing fails, the route still returns Stripe refund success; the webhook is expected to catch up later.

Suggested checklist:

| Step | Success Signal |
| --- | --- |
| Stripe refund created | response has `refundId`, `status`, `amount` |
| DB refund rows updated | only confirmed if route can return refreshed DB state, otherwise "pending webhook/sync" |
| QuickBooks refund receipt written | only confirmed if DB `PaymentRefund.qbRefundReceiptId` exists after processing |
| Audit log written | route writes `REFUND_ISSUED` before response |
| Needs Review | warn if QB receipt missing or sync failed |

Design implication:

- The first version may need to show "Stripe confirmed; DB/QB may finish by webhook" unless the backend returns richer confirmation data.

### 2. `PUT /api/admin/sessions` with `action = "adjust"`

What it does:

- Optional Stripe refunds across refundable payments.
- Best-effort `processChargeRefund` after each refund.
- Updates session expected end/status.
- Audits `SPOT_FREED`.
- Returns `{ success, action: "adjusted", refundsIssued }`.

Suggested checklist:

| Step | Success Signal |
| --- | --- |
| Stripe refund(s) created | `refundsIssued.length > 0`; amount list returned |
| DB refund/QB mirror | not fully confirmed by response today |
| Session time updated | success response |
| Access state updated | inferred from session update; should be explicit in future response |
| Audit log written | route audits before response |

Design implication:

- For a no-refund adjustment, hide Stripe/QB rows or mark them skipped.
- For refund adjustment, show Stripe as confirmed and QB as pending/confirmed only if backend returns proof.

### 3. `PUT /api/admin/sessions` with `action = "adjust-monthly-access"`

What it does:

- Shortening can optionally refund current-period payment.
- Optional Stripe subscription cancellation when `renewalAction = "stop"`.
- Updates session `expectedEnd` / status / billing flags.
- Best-effort QB refund receipt sync.
- On later-step failure, returns structured `landed` state.

Important backend response on partial failure:

```json
{
  "error": "Session update failed after subscription action: ...",
  "landed": {
    "refund": { "amount": 10, "breakdown": ["10.00"] },
    "subscription": "cancelled",
    "session": "unchanged"
  }
}
```

Suggested checklist:

| Step | Success Signal |
| --- | --- |
| Stripe refund created | `refund.amount > 0` in success or `landed.refund` in failure |
| Stripe subscription action | `renewalAction = "stop"` success or `landed.subscription` |
| Session access updated | success response has `effectiveEnd`; failure may say `session: "unchanged"` |
| QB refund receipt | not reliably confirmed in response today |
| Audit log | success path audits; refund audit is emitted before later risky steps |

Design implication:

- This is the best candidate for a strong partial-success UI.
- If `landed` exists, the popup must not show a generic failure. It should say exactly what landed and what did not.

### 4. `PUT /api/admin/sessions` with `action = "cancel-monthly-session"`

What it does:

- Optionally refunds current-period payment.
- Sets `billingCancelledByAdmin = true` before Stripe cancellation/scheduling.
- Calls Stripe subscription update/cancel.
- Updates session depending on access mode:
  - `period_end`: no immediate session row update beyond admin-cancel flag.
  - `now`: session becomes `CANCELLED`.
  - `custom`: session stays `ACTIVE` with shortened `expectedEnd`.
- Best-effort QB refund receipt sync.
- Returns partial `landed` state on failure after refund/subscription work.

Suggested checklist:

| Step | Success Signal |
| --- | --- |
| Admin cancellation intent recorded | DB flag set before Stripe call |
| Stripe refund created | success `refund.amount` or failure `landed.refund` |
| Stripe subscription cancelled/scheduled | success `subscriptionId`, `access`; failure `landed.subscription` |
| DB session/access updated | success response; failure `landed.session` |
| QB refund receipt | not reliably confirmed in response today |
| Audit log | `SUBSCRIPTION_CANCELED`, and `SPOT_FREED` when access ends before period end |

Design implication:

- Copy must distinguish:
  - "Subscription cancellation scheduled"
  - "Subscription cancelled now"
  - "Parking access remains until DATE"
  - "Refund issued"
  - "QuickBooks receipt pending"

### 5. `POST /api/admin/payments/[id]/sync-receipt`

What it does:

- Reads Stripe to resolve a charge ID if missing.
- Finds/creates QB Customer.
- Writes QB Sales Receipt.
- Updates DB `Payment.qbSalesReceiptId` and `qbSalesReceiptAmount`.
- Audits `SALES_RECEIPT_WRITTEN`.
- Returns `{ ok, qbSalesReceiptId, alreadySynced? }`.

Suggested checklist:

| Step | Success Signal |
| --- | --- |
| Stripe charge resolved | implicit; no current response field |
| QB customer ready | implicit; may create/update Driver.qbCustomerId |
| QB sales receipt written | `qbSalesReceiptId` |
| DB payment linked to receipt | route updates before response |
| Audit log written | route audits before response |

Design implication:

- This can show a clean "QB confirmed" state today.
- If `alreadySynced`, show "Already synced" rather than "Created new receipt."

### 6. `POST /api/admin/payments/[id]/sync-refunds`

What it does:

- Reads Stripe PaymentIntent/Charge.
- Runs `processChargeRefund`.
- Updates DB refund state.
- Writes missing QB Refund Receipts when possible.
- Returns `{ ok, refundedAmount, status }`.

Suggested checklist:

| Step | Success Signal |
| --- | --- |
| Stripe charge checked | route success |
| DB refund state updated | `refundedAmount`, `status` |
| QB refund receipt written | not directly returned today |
| Needs Review | check if refund receipt remains missing |

Design implication:

- Needs richer response if the UI must claim QB confirmation.
- Until then: "Stripe checked and DB updated; verify QB receipt below."

### 7. `POST /api/admin/payments/sync-batch`

What it does:

- Reads Stripe charges for many payments.
- Runs `processChargeRefund` only when Stripe and DB refund state differ.
- Returns `{ synced, failed }`.

Suggested checklist:

| Step | Success Signal |
| --- | --- |
| Stripe charges checked | implied by route completion |
| Changed payments synced | `synced` count |
| Failures returned | `failed` array |
| QB refund receipts | not itemized today |

Design implication:

- Batch widget should summarize counts, not show every row unless expanded.

### 8. Stripe Checkout / Webhook Paths

Driver checkout routes create Stripe Checkout Sessions and then webhooks write DB/QB:

- `processCheckoutSession` creates sessions/payments.
- `writeSalesReceiptSafe` writes QB Sales Receipts.
- `processChargeRefund` writes refund rows and QB Refund Receipts.

These are not admin button actions, but their result model should inform the same component:

- Stripe payment confirmed.
- DB payment/session written.
- QB receipt written or failed.
- Needs Review if missing/mismatched.

## Widget Shapes

### Compact Inline Result

Use after a small action like "Sync receipt" or "Sync refunds":

```text
QuickBooks receipt synced
[done] Stripe charge resolved
[done] QB Sales Receipt 1234 written
[done] Payment linked to receipt
```

### Modal / Drawer Result

Use a modal after a single high-risk action like refund. Use a drawer when the result needs more detail, especially monthly cancellation/access adjustment.

```text
Monthly cancellation processed

[done] Admin cancellation intent recorded
[done] Stripe subscription cancelled now
[done] Stripe refund created: $42.19
[warning] QuickBooks refund receipt pending
[done] Parking access ends now
[done] Audit log written

Next: Needs Review will keep this item visible until QuickBooks catches up.
```

### Partial Failure Result

Never show a generic "Failed" when the backend returns partial `landed` state.

```text
Action partially completed

[done] Stripe refund created: $42.19
[done] Stripe subscription cancelled
[failed] Session row was not updated
[warning] QuickBooks refund receipt not confirmed

Do not retry blindly. Review the session and reconcile before taking another action.
```

## Minimum Backend Contract Needed

Current responses are inconsistent. To make the widget reliable, admin mutation endpoints should gradually return a shared result shape.

Proposed additive shape:

```ts
type ExternalWriteStep = {
  key:
    | "stripe_refund"
    | "stripe_subscription"
    | "stripe_read"
    | "db_payment"
    | "db_session"
    | "qb_sales_receipt"
    | "qb_refund_receipt"
    | "access"
    | "audit"
    | "needs_review";
  label: string;
  status: "pending" | "working" | "confirmed" | "skipped" | "warning" | "failed";
  detail?: string;
  externalId?: string;
  href?: string;
};

type AdminExternalWriteResult = {
  ok: boolean;
  title: string;
  summary: string;
  steps: ExternalWriteStep[];
  landed?: {
    stripe?: string[];
    quickBooks?: string[];
    db?: string[];
    access?: string[];
  };
  needsReview?: boolean;
};
```

This can live alongside existing response fields until callers are migrated.

## Design Requirements

- The widget must accept a list of steps from the caller/backend. It should not infer Stripe/QB effects from action names.
- Hide non-applicable systems rather than showing "Stripe: N/A" everywhere.
- Use "confirmed" only when the backend has proof from that system.
- Use "pending webhook" or "pending QuickBooks" when the backend only initiated an action but did not confirm the mirror.
- Support partial success prominently.
- Show external IDs and links when available.
- If a step has `externalId` but no `href`, render the ID as copyable/readable monospace text, not a fake link.
- Only render an external ID as a link when the backend/caller provides `href`.
- `Next` copy must be conditional. Do not always say "Open Needs Review":
  - QB pending/missing mirror: "Open Needs Review"
  - Stripe refund landed but session update failed: "Review session and audit log"
  - subscription cancelled but DB unchanged: "Review session and reconcile before retrying"
  - all confirmed: no next step needed
- Include useful IDs when available:
  - Stripe refund ID
  - Stripe subscription ID
  - Stripe charge / PaymentIntent
  - QB Sales Receipt ID
  - QB Refund Receipt ID
  - DB payment/session/refund ID
- Always include a final "what should admin do next?" line when any warning/failed step exists.

## First Implementation Slice

Do not start by changing every endpoint.

Recommended order:

1. Build a presentational component:
   - `AdminExternalWriteStatus`
   - input: `title`, `summary`, `steps`
   - no API calls inside the component

2. Wire it to the cleanest existing action:
   - `sync-receipt`, because it can already confirm QB Sales Receipt by ID.

3. Then wire it to:
   - `sync-refunds`
   - `admin/refund`
   - monthly cancel/adjust partial `landed` responses

4. Only after the UI shape is proven, standardize backend responses endpoint by endpoint.

## Open Gaps To Avoid Overclaiming

- `admin/refund` confirms Stripe refund immediately, but DB/QB may still depend on synchronous fallback or webhook catch-up.
- `processChargeRefund` writes QB refund receipts, but several admin endpoints do not return the written `qbRefundReceiptId`.
- `sync-refunds` returns DB refund amount/status but not QB receipt IDs.
- `sync-batch` returns counts and failed IDs, not per-payment step details.
- Monthly cancel/adjust already has useful partial `landed` response; the UI should preserve that detail.
- Existing `AdminMutationResult` in `src/types/actions.ts` is too coarse for this widget. It lists effect arrays, but not per-step status, IDs, hrefs, warnings, or partial-failure state.
