# Admin UI Design Handoff: Existing Hooks and Surface Opportunities

This document is for a design agent working outside the codebase. It explains
what the parking admin system already knows, what is surfaced weakly today, and
what UI affordances would make admin mistakes or data drift harder to miss.

The product is operational software for a small parking/gate-access business.
It should feel practical, calm, and work-focused rather than like a marketing
SaaS dashboard. The admin uses it to answer:

- Who is parked here?
- Who has paid?
- Who can open the gate?
- What needs review before books/access drift?
- What exactly will happen if I adjust, cancel, refund, or close a session?

## Core Concepts

### Session

A parking stay. Important states:

- `ACTIVE`: currently has access.
- `OVERSTAY`: stayed past expected end and owes/needs overstay resolution.
- `COMPLETED`: closed normally.
- `CANCELLED`: cancelled by admin/system.

### Billing Status

Used mostly for monthly/subscription sessions:

- `CURRENT`: billing is current.
- `PAYMENT_FAILED`: Stripe tried to collect a renewal and failed. This is usually recoverable.
- `DELINQUENT`: subscription ended or policy escalated the failed payment. Access should be blocked.

### Needs Review

The admin-facing action queue. It is the first place non-technical admins should look. It should answer:

> "What requires attention, how serious is it, and what should I do next?"

### Advanced Reconcile Views

Developer/accounting evidence views. They are useful, but should not be the default burden for normal admins. They explain *why* an issue exists.

## Current Admin Areas

| Area | Purpose | Design Notes |
| --- | --- | --- |
| Overview | High-level lot/business state | Should show compact operational health, not marketing cards. |
| Sessions | Active/history session ledger | Main place to manage a driver/session. Needs dense but readable rows. |
| Payments | Payment ledger and Stripe/QB details | Useful for evidence and transaction lookup. Can be intimidating. |
| Reconcile / Needs Review | Admin queue plus advanced drift checks | Needs Review should be the default, advanced subtabs secondary. |
| Drivers | Driver records and vehicles | Should support quick lookup and correction. |
| Log | Audit trail | Best as searchable timeline/evidence, not primary workflow. |
| Settings | Rates, QuickBooks, policy controls | Should be grouped by operational meaning. |

## Existing Backend Hooks Worth Surfacing

These capabilities already exist or are substantially present. Design can use
them as product concepts even if the current UI is rough.

| Hook / Endpoint | Backend Fact Exposed | Current Surface | Design Opportunity | Priority |
| --- | --- | --- | --- | --- |
| `Needs Review` issue queue | Stable issue codes, severity, detail, recommended action, related session/payment/refund IDs | Reconcile -> Needs Review | Make this the admin's action inbox. Each card should have a clear next action and evidence link. | High |
| Payment-failed/delinquent subscription list | Monthly sessions with `PAYMENT_FAILED` or `DELINQUENT`; may include Stripe invoice/subscription metadata | Payments tab only, conditional "Pending Payments" section | Move or duplicate this into Needs Review. Admin should not have to discover it under Payments. | High |
| Session management command | Adjust, cancel, close, monthly cancel/access adjustment | Sessions -> Manage modal | Keep this as the central action place, but improve action summaries and confirmation wording. | High |
| QB receipt sync action | Writes missing QuickBooks Sales Receipt for a Stripe payment | Reconcile/Payments actions | Needs Review cards for missing QB receipt should offer "Sync receipt" inline. | High |
| QB refund receipt sync action | Writes missing QuickBooks Refund Receipt for Stripe refunds | Reconcile/Payments actions | Needs Review cards for missing refund receipt should offer "Sync refund receipt" inline. | High |
| Stripe charge/refund detail lookup | Stripe charge/refund evidence for a DB payment | Payment detail popup | Use as an evidence drawer, not primary UI. | Medium |
| Driver state / allowed actions | Backend-authoritative allowed actions and denial reasons for drivers | Driver pages mostly | Could power admin "why gate access is blocked" labels. | High |
| Gate command denials | Typed denial codes such as overstay, rescan required, billing suspended | Driver pages/audit | Admin session rows should show the latest access-blocking reason. | High |
| Audit log | Gate opens, denials, suspicious entry, refunds, subscription events, QB failures | Log tab | Add per-session timeline under session details. | High |
| Settings: failed payment policy | Admin policy for when failed monthly payments block access | Settings tab | Also show policy/deadline on delinquency cards. | High |
| Stripe webhook freshness | Last Stripe webhook timestamp | Settings/operational status | Add staleness banner if webhooks have not arrived recently. | Medium |
| QuickBooks token status | QB connected/expiring | Settings/Payments warnings | Add clear "QB attention needed" card if token expiring or disconnected. | Medium |
| Pricing preview | Server-computed charge preview | Driver checkout pages | Admin can use this for manual quotes/adjustment previews later. | Low |

## Needs Review: Suggested Card Model

Needs Review cards should be action-oriented. A good card answers:

- Severity: warning or critical.
- Plain title.
- Driver/session/payment context.
- What happened.
- Why it matters.
- Recommended action.
- Primary action button.
- Secondary evidence links.

Example layout:

```text
[Critical] Subscription is delinquent
Driver: Maria Lopez · Truck 1294 · Spot T-18

Stripe subscription ended unexpectedly. Gate access is blocked.

Recommended: contact the driver and resolve the outstanding balance.

[Review Session] [Open Stripe Subscription] [Mark Contacted]
Evidence: Session ID · Stripe subscription ID · Audit timeline
```

## Important Existing Issue Types

These issue codes already exist conceptually in the system.

| Code | Severity | Admin Meaning | Good Primary UI Action |
| --- | --- | --- | --- |
| `SUBSCRIPTION_PAYMENT_FAILED` | Warning | Monthly renewal failed; Stripe may retry. | Review subscription / contact driver / open Stripe invoice. |
| `SUBSCRIPTION_DELINQUENT` | Critical | Subscription ended or failed past policy; access blocked. | Review session / contact driver / resolve balance. |
| `DB_PAYMENT_WITHOUT_STRIPE_CHARGE` | Critical | System thinks paid, but no Stripe proof. | Review payment/session. |
| `QB_RECEIPT_MISSING` | Warning | Stripe payment exists but no QB Sales Receipt. | Sync receipt. |
| `DB_STRIPE_AMOUNT_MISMATCH` | Critical | DB amount and Stripe amount disagree. | Review payment evidence. |
| `QB_RECEIPT_AMOUNT_MISMATCH` | Warning | QB receipt amount differs from Stripe. | Review QB receipt. |
| `QB_REFUND_RECEIPT_MISSING` | Warning | Stripe refund exists but no QB Refund Receipt. | Sync refund receipt. |
| `QB_REFUND_AMOUNT_MISMATCH` | Warning | QB refund receipt differs from Stripe refund. | Review refund evidence. |
| `REFUND_DETAIL_MISSING` | Warning | Payment says refunded, but refund rows are missing. | Review refund. |
| `ACTIVE_SESSION_PAST_EXPECTED_END` | Warning | Session is past expected end but still active. | Review/close session or run session check. |
| `CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE` | Warning | Cancelled paid session needs refund/retention disposition. | Review cancellation. |

## Under-Surfaced Workflows

### 1. Subscription Delinquency

Current concept:

- `PAYMENT_FAILED`: recoverable warning.
- `DELINQUENT`: critical/access-blocking.

Admin needs:

- Know whether access is currently blocked.
- Know the policy deadline if grace period applies.
- See Stripe invoice/subscription link.
- Record contact/follow-up.
- Resolve or document manual collection.

Possible UI:

```text
Subscription payment failed
Access: still allowed until May 12 under 3-day grace policy
[Contact Driver] [Open Stripe Invoice] [Review Session]
```

```text
Subscription delinquent
Access: blocked
[Review Session] [Open Stripe Subscription] [Mark Manual Collection Started]
```

### 2. Session Timeline

Each session should eventually have a timeline under the expanded session row or Manage modal:

- check-in/payment
- gate opens
- gate denials
- suspicious entry
- extension
- overstay start/payment
- refunds
- QB receipt/refund receipt sync
- subscription failed/delinquent
- admin adjustments/cancellations

This helps admins understand "what happened" without opening multiple tabs.

### 3. Universal Danger Labels

Before destructive or money-moving actions, show explicit effects:

```text
This will:
- Cancel parking access now.
- Keep the existing $30.00 payment.
- Free spot B-12.
- Record retained-payment disposition.
- Leave the Stripe charge and QB receipt in place.
```

The final button should include the consequence:

```text
Cancel Session Without Refund
Cancel Session With $18.40 Refund
Adjust Time Without Refund
Close Session and Remove 1 Overstay Charge
```

### 4. Staleness / Health Banners

Useful banners:

- "No Stripe webhook received recently."
- "QuickBooks token expires soon."
- "Cron/session check has not run recently."
- "Needs Review has critical items."
- "QB is disconnected; receipts will not sync automatically."

### 5. Advanced Evidence Drawers

Do not force normal admins into raw reconcile tables. Instead:

- Needs Review card -> "View evidence"
- Evidence drawer shows Stripe IDs, QB receipt IDs, DB payment IDs, audit events.
- Advanced tabs remain available for developer/accounting investigation.

## Proposed Additions

These do not necessarily exist yet, but are good design candidates.

| Proposed Feature | Purpose | Suggested UI | Priority |
| --- | --- | --- | --- |
| Mark Contacted | Record that admin contacted driver about failed payment/delinquency. | Button on Needs Review card; small modal for method/note/follow-up date. | High |
| Snooze Needs Review | Hide a known issue until a date without deleting evidence. | "Snooze" secondary action with date picker. | Medium |
| Resolve With Reason | Close a Needs Review item only with durable disposition. | Required reason/disposition modal. Avoid silent "Done." | High |
| Open Stripe Invoice/Subscription | Jump to Stripe evidence/action page. | Secondary link button on subscription cards. | High |
| Send Update Payment Link | Let driver update card if Stripe billing portal/customer portal is added. | Primary action for `PAYMENT_FAILED`. | Medium |
| Manual Collection Started | Record that admin is handling payment outside Stripe. | Action on delinquency card; should require note. | Medium |
| Expected Subscription Cancellation Marker | Distinguish admin-expected cancellation from unexpected Stripe deletion. | Not necessarily visible, but prevents false delinquency cards. | High |
| Session Timeline Endpoint | Combine audit/payments/refunds/gate events. | Timeline panel under session card. | High |
| Admin Health Endpoint | Centralize Stripe/QB/cron/reconcile health. | Overview health strip and staleness banners. | Medium |

## Design Priorities

### High Priority

1. Needs Review as the default action inbox.
2. Clear delinquency/payment-failed cards with access status.
3. Manage Session modal with explicit consequence summaries.
4. Per-session timeline.
5. Stable, calm status language and badges.

### Medium Priority

1. Health/staleness banners.
2. Evidence drawers for Stripe/QB/DB IDs.
3. Contact/snooze/follow-up workflows.
4. Better Payments tab grouping.

### Lower Priority

1. Visual polish of advanced reconcile tables.
2. Dashboard charts.
3. Deep customization of settings layout.

## Suggested Admin Navigation

Keep the main nav simple:

```text
Overview
Needs Review
Sessions
Payments
Drivers
Log
Settings
Advanced
```

Advanced can contain:

- Stripe vs DB
- Stripe vs QuickBooks
- Session Ledger
- Raw audit/reconcile evidence

If "Reconcile" remains the nav label, make the first subtab "Needs Review" and keep advanced subtabs clearly secondary.

## UX Tone

Use plain operational language:

- "Payment failed"
- "Access blocked"
- "Receipt missing"
- "Refund receipt missing"
- "Session past expected end"
- "Cancelled session needs refund/retention decision"

Avoid overly technical-first labels in primary UI:

- Prefer "Receipt missing" over "QB_RECEIPT_MISSING"
- Prefer "Stripe charge missing" over "DB_PAYMENT_WITHOUT_STRIPE_CHARGE"
- Keep raw codes available in evidence/details for support/debugging.

## What Not To Do

- Do not hide critical money/access states in advanced tables only.
- Do not add a silent "Mark resolved" action without reason/disposition.
- Do not make admins infer consequences from raw IDs.
- Do not rely on color alone for severity.
- Do not make the UI feel like a generic SaaS landing dashboard.
- Do not treat QuickBooks as payment truth. Stripe/payment DB are payment truth; QB is accounting output.

## Shareable Summary

The admin refresh should turn the system from a set of ledgers into an
operational cockpit:

```text
Needs Review tells the admin what needs action.
Sessions tells the admin who is parked and what can be changed.
Payments tells the admin what money moved.
Advanced Reconcile explains why the system believes something is wrong.
```

The most valuable design improvement is not more data. It is making every issue
answer:

```text
What happened?
Is access affected?
Is money affected?
What should I do next?
What will happen if I click this button?
```
