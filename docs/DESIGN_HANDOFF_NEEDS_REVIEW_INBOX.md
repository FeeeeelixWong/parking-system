# Design Handoff: Needs Review Inbox

This handoff is for the design agent. It defines the first admin UI refresh slice: turn Needs Review into a clear operational inbox for a parking lot manager.

The design agent does not need repository access. This document explains the product goal, data available from the backend, required states, and constraints.

## Product Context

This is operational software for a small truck parking / gate-access business. The admin needs to quickly answer:

- Who needs attention?
- Is access currently allowed or blocked?
- Was money confirmed in Stripe?
- Was accounting mirrored into QuickBooks?
- What exact action should I take next?
- What evidence proves the issue?

The interface should feel calm, dense, and work-focused. Avoid marketing-dashboard styling, large decorative cards, oversized hero sections, or generic SaaS ornament.

## First Slice

Design **Needs Review as the admin action inbox**.

This should become the first place an admin looks when something is wrong. Advanced reconcile views can still exist, but they are evidence/supporting views, not the primary workflow.

## Audience

Primary user: parking lot manager or owner.

Likely traits:

- Not technical.
- Needs direct action labels.
- Cares about money/access/accounting being correct.
- May be using a laptop or tablet while handling phone calls.
- Should not need to understand Stripe IDs, QuickBooks IDs, or DB IDs unless viewing evidence.

## Core Mental Model

Each Needs Review card should answer:

```text
What happened?
Who/what does it affect?
Does it affect access?
Does it affect money/accounting?
What should I do next?
What evidence can I inspect?
```

## Page Structure

Recommended layout:

```text
Admin shell
└── Needs Review tab
    ├── Summary strip
    │   ├── Critical count
    │   ├── Warning count
    │   ├── Needs sync count
    │   └── Demo filter chip, if active
    ├── Filter / segment row
    │   ├── All
    │   ├── Critical
    │   ├── Billing
    │   ├── QuickBooks
    │   ├── Access
    │   └── Resolved / Snoozed, future-only if needed
    ├── Issue list
    │   └── Issue cards
    └── Evidence drawer or expandable evidence area
```

Do not bury this under a raw "Reconcile" label in the first viewport. If it remains technically inside Reconcile, visually make Needs Review the default action inbox.

## Card Anatomy

Each issue card should include:

- Severity marker: Critical / Warning / Info.
- Issue title.
- Affected entity line: driver, vehicle, spot, session, payment, refund, or subscription.
- Plain-language explanation.
- Access impact, when relevant.
- Money/accounting impact, when relevant.
- Recommended action.
- Primary action.
- Secondary evidence links.
- Timestamp / age.

Example:

```text
[Critical] Subscription delinquent
Maria Lopez · Truck 1294 · Spot T-18

Stripe subscription ended after failed payment. Gate access is blocked.

Recommended: contact the driver and resolve the outstanding balance.

[Review Session] [Open Stripe Subscription]
Evidence: Session timeline · Payment · Audit log
```

## Severity Treatment

Use restrained but unmistakable severity.

Critical:
- Access blocked.
- Money truth mismatch.
- DB says paid but Stripe proof missing.
- Subscription deletion unknown.

Warning:
- QuickBooks mirror missing.
- Payment failed but still inside grace/retry period.
- Active session past expected end.
- Refund receipt missing.

Info:
- Follow-up recorded.
- Issue snoozed.
- Sync already linked.

Do not make the page a wall of red. Reserve red for actual urgent action. Amber/yellow is appropriate for mirror/accounting warnings.

## Required Issue Types

The design must comfortably support these current issue types:

| Code | Meaning | Likely Action |
| --- | --- | --- |
| `SUBSCRIPTION_PAYMENT_FAILED` | Monthly renewal failed; Stripe may retry or hosted invoice may be available. | Open invoice / Contact driver / Review session |
| `SUBSCRIPTION_DELINQUENT` | Subscription ended or policy escalated failure; access blocked. | Review session / Contact driver |
| `SUBSCRIPTION_DELETION_UNKNOWN` | Stripe deletion could not be classified. | Review subscription evidence |
| `DB_PAYMENT_WITHOUT_STRIPE_CHARGE` | DB payment exists without Stripe charge proof. | Review payment |
| `QB_RECEIPT_MISSING` | Stripe payment exists but QuickBooks Sales Receipt is missing. | Sync receipt |
| `QB_REFUND_RECEIPT_MISSING` | Stripe refund exists but QuickBooks Refund Receipt is missing. | Sync refund receipt |
| `DB_STRIPE_AMOUNT_MISMATCH` | DB and Stripe amount disagree. | Review payment evidence |
| `QB_RECEIPT_AMOUNT_MISMATCH` | QuickBooks receipt amount differs. | Review QB receipt |
| `QB_REFUND_AMOUNT_MISMATCH` | QuickBooks refund receipt differs. | Review refund evidence |
| `REFUND_DETAIL_MISSING` | Payment says refunded but refund rows are missing. | Review refund |
| `ACTIVE_SESSION_PAST_EXPECTED_END` | Session is past expected end but active. | Review / close session |
| `CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE` | Cancelled paid session needs refund/retention disposition. | Review cancellation |
| `SUBSCRIPTION_CANCELLED_BUT_ACCESS_ACTIVE` | Subscription cancelled and expected access has elapsed, but session remains active. | Review session urgently |
| `SUBSCRIPTION_CANCELLED_ACCESS_STILL_VALID` | Subscription cancelled, but paid access window is still valid. | Monitor / review session |

The UI should not require a custom layout per issue type. Design a flexible card pattern.

## Backend Action Contract

The backend controls actions. The UI should not infer actions from issue code.

Action fields:

- `actionPath`: internal POST action.
- `actionHref`: external link.
- `actionLabel`: button/link label.

Rules:

- If `actionPath` exists, render a POST action button.
- If `actionHref` exists, render an external link with clear external affordance.
- If neither exists, render no primary action. Do not show disabled dead buttons.
- Secondary evidence links can be shown separately.

Examples:

```text
QB_RECEIPT_MISSING
Primary action: Sync receipt
After click: show external write status widget
```

When the backend finds a nearby unlinked QuickBooks receipt, the card may also include `nearbyQbMatches`.
In that case, the preferred design action is **Compare / Sync Matched Receipt** rather than blindly writing
a new QB receipt. The comparison view should show amount, date, customer name, confidence, and match reasons.

```text
SUBSCRIPTION_PAYMENT_FAILED
Primary action: Open invoice
External link to Stripe hosted invoice
```

```text
DB_PAYMENT_WITHOUT_STRIPE_CHARGE
No direct action
Show "Review payment evidence" / "Review session" secondary navigation
```

## External Write Status Widget

When an admin action writes to Stripe or QuickBooks, the UI should show a status widget immediately after completion.

For this first slice, the important actions are:

- Sync QuickBooks Sales Receipt.
- Sync QuickBooks Refund Receipt.

Widget intent:

```text
Show which systems confirmed the action:
- Stripe read confirmed
- QuickBooks receipt written or already linked
- DB payment updated
- Audit logged
```

Step statuses:

- pending
- working
- confirmed
- skipped
- warning
- failed

The widget should not feel celebratory. It should feel like an operational receipt.

Example:

```text
Receipt sync complete

[✓] Stripe charge read       ch_...
[✓] QuickBooks receipt       1234
[✓] DB payment updated       payment UUID
[✓] Audit logged
```

Partial failure example:

```text
Receipt sync partially completed

[✓] Stripe charge read
[!] QuickBooks write failed
[-] DB payment unchanged

Next: this item will remain in Needs Review. Do not retry blindly if money moved.
```

## Demo Mode

The app supports demo runs with a URL query:

```text
/admin?demoId=demo_admin-refresh_YYYYMMDD_HHmmss_ab12
```

When demo mode is active:

- Show a small persistent demo chip/banner.
- Make it clear the list is filtered to a single demo run.
- Provide a clear "Clear filter" control.
- Do not let the demo banner dominate the page.

Example chip:

```text
Demo run: demo_admin-refresh_20260513_143200_ab12  [Clear]
```

## Empty States

No issues:

```text
No items need review
Stripe, QuickBooks, sessions, and access checks are currently clean.
```

Filtered demo with no issues:

```text
No review items in this demo run
Clear the demo filter to see all current review items.
```

Provider disconnected:

```text
QuickBooks is disconnected
Receipts cannot sync until the connection is restored.
```

## Evidence Pattern

Cards should support an evidence area without forcing it into the primary reading path.

Evidence may include:

- Stripe charge ID.
- Stripe refund ID.
- Stripe invoice/subscription link.
- QuickBooks Sales Receipt ID.
- QuickBooks Refund Receipt ID.
- DB payment ID.
- DB refund ID.
- Session ID.
- Audit events.
- Nearby unlinked QuickBooks receipt/refund receipt candidates.

Recommended pattern:

- Primary card stays plain-language.
- "View evidence" expands a compact details area or opens a side drawer.
- IDs are monospace and copyable.
- External IDs can link out when safe.

## Nearby QuickBooks Match Candidates

Backend may attach a `nearbyQbMatches` array to `QB_RECEIPT_MISSING` and `QB_REFUND_RECEIPT_MISSING` items.

Each match includes:

- `kind`: sales receipt or refund receipt.
- `qbId`.
- `docNumber`.
- `txnDate`.
- `totalAmount`.
- `customerName`.
- `score`.
- `confidence`: high / medium / low.
- `reasons`: examples such as amount exact, date within 1 day, customer name partial match.
- `amountDelta`.
- `dayDelta`.
- `nameSimilarity`.
- `linkActionPath`, `linkActionMethod`, and `linkActionBody` for the eventual sync/link action.

Design implication:

```text
QuickBooks receipt not synced
Possible existing receipt found

QB Receipt #1234 · $30.00 · May 15 · Maria Lopez
High confidence: amount exact, date within 1 day, customer name strong match

[Compare / Sync Matched Receipt] [Write New Receipt]
```

Do not auto-link a nearby match in the UI. The admin should compare first, because nearby matching is intentionally fuzzy.

## Contact / Resolution Actions

These may be future additions, but design should leave room:

- Mark Contacted.
- Snooze until date.
- Resolve with reason.
- Mark manual collection started.
- Mark intentional retained payment.

Avoid vague button text like:

- Resolve
- Fix
- Done

Prefer explicit labels:

- Mark Driver Contacted
- Snooze Until Date
- Record Manual Collection
- Mark Retained Payment Intentional
- Sync QuickBooks Receipt

## Visual Direction

Use a dense operational layout:

- Compact list/table hybrid.
- Strong alignment.
- Clear status markers.
- Minimal decoration.
- Cards are okay for individual issue items, but avoid nested cards.
- Avoid large rounded marketing tiles.
- Avoid a one-note color palette.
- Text should fit in card/action containers at mobile and desktop widths.

Suggested visual language:

- Neutral background.
- White or near-white issue rows/cards.
- 1px borders.
- 4-8px radius.
- Severity color used as a marker/strip/badge, not full-card fill.
- Icons only where they help scanning.

## Mobile / Tablet

Needs Review should work on tablet/mobile:

- Cards stack vertically.
- Primary action remains visible.
- Evidence can collapse.
- Long IDs wrap or truncate with copy affordance.
- No horizontal scroll for basic card content.

## Non-Goals For First Slice

Do not redesign:

- Entire admin shell.
- Full Sessions ledger.
- Full Payments ledger.
- Full Stripe vs QuickBooks reconcile table.
- Driver-facing pages.
- Settings page.

Do not invent backend state:

- The UI should not decide an item is resolved unless backend says so.
- The UI should not invent money/access conclusions from provider IDs.

## Design Deliverables

Please produce:

1. Desktop Needs Review page.
2. Mobile/tablet Needs Review page.
3. Issue card variants:
   - Critical delinquency.
   - Payment failed with invoice link.
   - Missing QB receipt with sync action.
   - DB/Stripe mismatch with no direct action.
   - Clean empty state.
4. External write status widget variants:
   - Success.
   - Already linked/skipped.
   - Partial failure.
5. Evidence expanded/drawer state.
6. Demo filter active state.

## Implementation Notes For Engineering

Existing pieces likely available:

- Needs Review API returns issue code, severity, title/detail/action fields.
- UI already has a `NeedsReviewTab`.
- UI already has `AdminExternalWriteStatus`.
- Demo filtering uses `demoId` query parameter.
- Sync receipt and sync refund receipt actions are already wired or partially wired.

Engineering should preserve backend authority and use the design as presentation, not as new business logic.
