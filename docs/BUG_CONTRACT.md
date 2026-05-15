# Bug Contract

This document is a durable target list for focused audits. It is for code that is believed to be mostly complete, not for areas under active design churn. A sweep should pick one target, read only the listed files and adjacent tests, and report whether the invariant actually holds.

The point is not to force findings. The point is to make repeated independent audits comparable. If several focused sweeps find the same issue, that issue should be treated as more credible than a one-off broad review comment.

## Run Protocol

Each run is either Explore or Review.

Explore:
1. Pick one stable target below.
2. Restate the invariant before reading implementation details.
3. Inspect the primary files, adjacent helpers, and relevant tests.
4. Run the smallest relevant command if it is cheap and safe.
5. Check existing GitHub issues for similar findings before filing a new one.
6. Report new candidate findings with severity, evidence, reproduction path, and the smallest test that would prove a fix.
7. Do not modify code unless the user explicitly asks for implementation.

Review:
1. Pick one existing bug-contract issue, prior finding, PR comment, or test contract.
2. Restate the claim being reviewed.
3. Verify, refine, downgrade, duplicate-check, or make the claim fix-ready.
4. Add nuance only when it changes severity, implementation approach, test plan, or architectural understanding.
5. Prefer comments on existing issues over creating new issues.
6. Do not implement fixes unless the user explicitly asks for implementation.

Severity:
- P0: production emergency or data loss.
- P1: money movement, access control, provider truth, or migration defect likely to affect real users.
- P2: important drift, false-pass tests, retry/observability weakness, or admin workflow breakage.
- P3: cleanup, confusing copy, low-risk docs drift, or missing diagnostics.

## Targets

### 1. Fresh Scan Gate Authority

Invariant: A gate can open only from a fresh external navigation/scan, and reload/back/internal API calls cannot re-open it.

Primary files:
- `src/app/entry/page.tsx`
- `src/app/exit/page.tsx`
- `src/lib/navigation.ts`
- `src/app/api/sessions/[id]/open-gate/route.ts`
- `tests/e2e/driver-write/ui/gate-access.spec.ts`
- `tests/e2e/driver-write/ui/exit-gate.spec.ts`

Questions:
- Do entry and exit apply the same external-navigation guard?
- Does the API reject `scanContext: "internal"` independent of UI behavior?
- Do tests assert audit rows, not only response shape?

### 2. Subscription Deletion Classification

Invariant: `customer.subscription.deleted` is not itself a delinquency signal. The app must classify deletion as planned expiry, admin-planned cancellation, payment failure, dispute, or unknown before changing access.

Primary files:
- `src/lib/billing-access.ts`
- `src/app/api/stripe/webhook/route.ts`
- `src/app/api/admin/sessions/route.ts`
- `src/app/api/admin/reconcile/needs-review/route.ts`
- `tests/e2e/payments-accounting/subscription-delinquency-policy.spec.ts`
- `tests/e2e/payments-accounting/subscription-lifecycle-001.spec.ts`

Questions:
- Can normal monthly expiry become `DELINQUENT`?
- Can admin cancellation race its own webhook?
- Are unknown classifications surfaced in Needs Review?
- Does any branch leave access active beyond the paid/expected end?

### 3. Failed Payment Access Policy

Invariant: Stripe billing facts stay separate from access policy, and `PAYMENT_FAILED` blocks access only according to the admin setting. `after_grace_days` must work even before cron persists `DELINQUENT`.

Primary files:
- `src/lib/billing-access.ts`
- `src/app/api/sessions/[id]/open-gate/route.ts`
- `src/app/api/driver/state/route.ts`
- `src/app/api/cron/check-sessions/route.ts`
- `src/app/admin/SettingsTab.tsx`
- `tests/e2e/payments-accounting/subscription-delinquency-policy.spec.ts`

Questions:
- Does the gate compute effective billing block inline?
- Does driver state render the same access decision as open-gate?
- Does null `billingFailedAt` fail closed?
- Does cron update only rows still in the expected source state?

### 4. Refund And Monthly Adjustment Idempotency

Invariant: Retrying cancel/adjust/refund after any partial failure cannot move money twice, cannot strand the admin without a landed-state explanation, and cannot make DB access state contradict Stripe state.

Primary files:
- `src/app/api/admin/sessions/route.ts`
- `src/lib/quickbooks.ts`
- `src/app/admin/AdminExternalWriteStatus.tsx`
- `src/app/admin/NeedsReviewTab.tsx`
- `tests/e2e/admin-write/api/cancel-retry.spec.ts`
- `tests/e2e/admin-write/api/adjust-retry.spec.ts`
- `tests/e2e/payments-accounting/refund-qb-001.spec.ts`

Questions:
- Are Stripe idempotency keys stable across retries?
- Are `PaymentRefund` writes upserts by `stripeRefundId`?
- Does the response distinguish landed Stripe work from pending DB/QB recovery?
- Are misleading zero-dollar refund audits avoided?

### 5. QuickBooks Mirror Integrity

Invariant: QuickBooks is a mirror of app payment/refund state. Missing or failed QB writes must produce actionable Needs Review items without changing money truth.

Primary files:
- `src/lib/quickbooks.ts`
- `src/app/api/admin/payments/route.ts`
- `src/app/api/admin/reconcile/charges-receipts/route.ts`
- `src/app/api/admin/reconcile/needs-review/route.ts`
- `src/app/admin/ChargesReceiptsTab.tsx`
- `src/app/admin/PaymentsTab.tsx`
- `tests/e2e/payments-accounting/payment-qb-001.spec.ts`
- `tests/e2e/payments-accounting/refund-qb-001.spec.ts`

Questions:
- Can QB duplicate receipts for the same Stripe charge/refund?
- Are QB token failures surfaced clearly?
- Does sync-batch report partial failures without hiding successes?
- Does manual QB deletion show in Reconcile/Needs Review?

### 6. Needs Review Actions

Invariant: Needs Review items should be backend-authored, action-specific, and should never show vague or dead controls.

Primary files:
- `src/types/reconcile.ts`
- `src/app/api/admin/reconcile/needs-review/route.ts`
- `src/app/admin/NeedsReviewTab.tsx`
- `src/app/admin/AdminExternalWriteStatus.tsx`
- `tests/e2e/admin-write/ui/needs-review-action-link.spec.ts`
- `tests/e2e/admin-write/ui/sync-receipt-widget.spec.ts`

Questions:
- Does UI render only `actionPath` POST buttons or `actionHref` external links supplied by the API?
- Do external links use `target="_blank"` and `rel="noreferrer"`?
- Do write actions show confirmed/skipped/failed external-system steps?

### 7. Demo Scenario Isolation

Invariant: Demo scenario data is isolated by `testRunId`, safe to create/reset, and filterable across Sessions, Payments, Needs Review, Stripe vs QuickBooks, Stripe metadata, and QB private notes.

Primary files:
- `scripts/demo-scenario-factory/`
- `scripts/demo-dev.ts`
- `src/app/api/admin/payments/route.ts`
- `src/app/api/admin/payments/pending/route.ts`
- `src/app/api/admin/reconcile/charges-receipts/route.ts`
- `src/app/api/admin/reconcile/needs-review/route.ts`
- `src/app/api/sessions/history/route.ts`
- `tests/e2e/admin-write/api/demo-filter.spec.ts`

Questions:
- Does every demo charge/customer/receipt carry the shared `testRunId` and scenario name?
- Does reset delete only the intended DB rows and only test-mode Stripe artifacts?
- Does `?demoId=` suppress unrelated global rows?
- Does `demo:dev` point the app at the same DB used by `demo:create`?

### 8. Reconcile Stripe/QB/DB Drift

Invariant: Reconcile compares Stripe, QuickBooks, and DB rows by stable provider IDs and scoped filters. It should not create false drift by mixing demo runs, stale test data, or provider object types.

Primary files:
- `src/app/api/admin/reconcile/route.ts`
- `src/app/api/admin/reconcile/charges-receipts/route.ts`
- `src/app/admin/ReconcileView.tsx`
- `src/app/admin/ChargesReceiptsTab.tsx`
- `tests/e2e/payments-accounting/reconcile-basic-drift.spec.ts`
- `tests/e2e/payments-accounting/reconcile-disposition.spec.ts`

Questions:
- Are invoice IDs, PaymentIntent IDs, charge IDs, refund IDs, and QB receipt IDs kept distinct?
- Does demo filtering apply before orphan/match detection?
- Are disposition actions durable and auditable?

### 9. Schema And Migration Discipline

Invariant: A fresh clone using the committed migration path must get the same schema as the developer DBs.

Primary files:
- `prisma/schema.prisma`
- `prisma/migrations/`
- `.claude/hooks/prisma-migration-reminder.sh`
- `.github/pull_request_template.md`

Questions:
- Did schema changes land with migrations?
- Are manually applied DB changes documented or resolved?
- Does CI catch missing generated/client drift?

### 10. Admin External Write Status

Invariant: Any admin action that writes to Stripe or QuickBooks should either show an external-write status widget or have a documented reason why it does not apply.

Primary files:
- `src/app/admin/AdminExternalWriteStatus.tsx`
- `src/app/admin/NeedsReviewTab.tsx`
- `src/app/admin/PaymentsTab.tsx`
- `src/app/api/admin/sessions/route.ts`
- `src/app/api/admin/payments/route.ts`

Questions:
- Does the admin see which systems confirmed: Stripe, QuickBooks, DB, audit?
- Are skipped steps named instead of silently omitted when they matter?
- Is the retry instruction safe and specific for partial failures?

## Recurring Agent Workflow

Recommended cadence: every 3 hours overall by alternating agents:

- Claude every 6 hours.
- Codex every 6 hours.
- Offset them by 3 hours.

Both agents must follow the same contract and output shape. The value of alternating agents is diversity of judgment, not inconsistent rules.

Mode selection:

```text
open_bug_contract_issue_count = N
review_probability = min(0.9, 0.1 + 0.1 * N)
explore_probability = 1 - review_probability
```

This makes the system self-throttling. With few issues it explores more. As issue load grows it spends more runs verifying, consolidating, downgrading, or making existing issues fix-ready.

Recommended runner behavior:
- Identify whether this run is Claude or Codex.
- Count open issues labeled `bug-contract`.
- Roll Explore or Review from the formula above.
- For Explore, select the next target round-robin or choose one from recent stable files.
- For Review, choose an open bug-contract issue most in need of verification, de-duplication, or fix planning.
- Run `/bug-contract-sweep <mode> <target-or-issue>`.
- If GitHub tools are available, search existing open issues for the target and key failure terms.
- Add a comment to an existing matching issue when evidence strengthens it.
- Create a new issue using the `Bug contract finding` template only when the finding is concrete and reproducible.
- Never open issues for speculation without file/line evidence.

Escalation rule: if two independent sweeps find the same P1/P2 issue, promote it for human review even if each individual report is uncertain.
