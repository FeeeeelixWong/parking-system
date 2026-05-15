# Manual Cross-System Stress Checklist

Purpose: run a small number of broad manual checks that touch driver access, admin session management, Stripe, QuickBooks, and Neon DB state at the same time.

This checklist is not a proof that "nothing I can do will make e2e fail." Manual edits in Stripe, QB, or Neon can always create states outside normal app contracts. The goal is narrower and useful: if e2e passes and this checklist passes, the app is likely robust against realistic operator mistakes, provider drift, and reconciliation noise.

Use only sandbox/test resources.

## Ground Rules

- Run this against `TEST_DATABASE_URL`, Stripe test mode, and QuickBooks sandbox.
- Start with a fresh test DB or a known demo seed.
- Record the test run timestamp and any manually created Stripe/QB IDs.
- Do not run manual checks against live production keys.
- After each scenario, check:
  - Driver UI state
  - Admin Sessions state
  - Needs Review
  - Advanced Reconcile, if relevant
  - Audit Log
  - Stripe dashboard object
  - QuickBooks sandbox object
  - Neon DB rows

## Quick Baseline

Before manual mutation:

- [ ] Full e2e suite passes.
- [ ] Admin login works.
- [ ] Needs Review loads.
- [ ] Settings loads and shows subscription delinquency policy.
- [ ] Stripe test dashboard shows recent test objects.
- [ ] QuickBooks sandbox token is valid.
- [ ] Neon test DB is reachable.

Suggested baseline query:

```sql
select status, "billingStatus", count(*)
from "Session"
group by status, "billingStatus"
order by status, "billingStatus";
```

## Scenario 1: Healthy Daily Session, Then Admin Cancel With No Refund

Max coverage: driver session health, admin cancel flow, retained payment disposition, spot freeing, Needs Review suppression.

Setup:

- Create or seed one paid daily active session.
- Ensure it has a `CHECKIN` payment with Stripe IDs and no refunds.

Actions:

- [ ] Driver opens `/entry`; gate opens once.
- [ ] Refresh `/entry`; gate does not open again.
- [ ] Admin opens the session.
- [ ] Cancel session.
- [ ] Choose no refund / retain payment intentionally.
- [ ] Enter a clear reason.

Expected:

- [ ] `Session.status = CANCELLED`.
- [ ] `Session.cancellationDisposition = RETAINED_INTENTIONAL`.
- [ ] Payment remains `COMPLETED`.
- [ ] No `PaymentRefund` row is created.
- [ ] Audit includes `SPOT_FREED`.
- [ ] Needs Review does not show `CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE`.
- [ ] Stripe charge is still present.
- [ ] QB Sales Receipt is still present.

DB spot check:

```sql
select s.id, s.status, s."cancellationDisposition", p.type, p.status, p.amount, p."refundedAmount"
from "Session" s
join "Payment" p on p."sessionId" = s.id
where s.id = '<session_id>';
```

## Scenario 2: Daily Session, Partial Refund, Then Manual QB Damage

Max coverage: refund logic, over-refund protection, QB refund receipt linkage, Needs Review drift detection.

Setup:

- Use a paid daily session with a real Stripe test charge and QB Sales Receipt.

Actions:

- [ ] Admin issues a partial refund.
- [ ] Confirm Stripe Refund exists.
- [ ] Confirm DB `PaymentRefund` exists.
- [ ] Confirm QB RefundReceipt exists.
- [ ] In QuickBooks sandbox, manually delete, void, or alter the RefundReceipt amount.
- [ ] Reload Needs Review / Reconcile.

Expected:

- [ ] DB `Payment.refundedAmount` equals sum of `PaymentRefund.amount`.
- [ ] Stripe refund amount equals DB refund amount.
- [ ] If QB RefundReceipt was deleted/missing, Needs Review shows `QB_REFUND_RECEIPT_MISSING`.
- [ ] If QB amount was changed, Needs Review shows `QB_REFUND_AMOUNT_MISMATCH`.
- [ ] The app does not change Stripe or DB merely because QB was edited.

DB spot check:

```sql
select p.id, p.amount, p.status, p."refundedAmount",
       coalesce(sum(r.amount), 0) as refund_rows_total
from "Payment" p
left join "PaymentRefund" r on r."paymentId" = p.id
where p.id = '<payment_id>'
group by p.id;
```

## Scenario 3: Monthly Failed Payment, Invoice Link, Then Recovery

Max coverage: subscription billing state, hosted invoice URL, gate blocking policy, Needs Review action link, recovery behavior.

Setup:

- Use a monthly active session with a `MONTHLY_CHECKIN` payment.
- Set delinquency policy to either `immediate_on_payment_failed` or `after_grace_days` with elapsed grace.
- Trigger or simulate `invoice.payment_failed`.

Actions:

- [ ] Open Needs Review.
- [ ] Confirm `SUBSCRIPTION_PAYMENT_FAILED` appears.
- [ ] Confirm action link opens the Stripe hosted invoice URL.
- [ ] Attempt driver `/entry`.
- [ ] If policy blocks access, confirm gate denial.
- [ ] In Stripe test dashboard, pay or mark the invoice succeeded if possible.
- [ ] Trigger/replay the relevant success webhook if needed.

Expected:

- [ ] `Session.billingStatus = PAYMENT_FAILED` after failure.
- [ ] `Session.billingFailedAt` is set.
- [ ] `Payment.hostedInvoiceUrl` is set on the relevant monthly payment.
- [ ] Needs Review action label is `Open invoice`.
- [ ] Gate blocks only according to Settings policy.
- [ ] After successful payment recovery, the app should either clear the warning or expose any missing recovery behavior as a known gap. Do not silently assume it recovered.

DB spot check:

```sql
select s.id, s.status, s."billingStatus", s."billingFailedAt",
       p.type, p."stripeInvoiceId", p."hostedInvoiceUrl"
from "Session" s
join "Payment" p on p."sessionId" = s.id
where s.id = '<session_id>'
order by p."createdAt";
```

## Scenario 4: Monthly Cancellation Paths

Max coverage: planned cancellation vs delinquency, admin intent marker, Stripe subscription deletion classification, access window.

Run one monthly session through each path if time allows; otherwise run only `period_end`.

Actions:

- [ ] Cancel at period end.
- [ ] Cancel now without refund.
- [ ] Cancel at custom future date with unused-time refund.
- [ ] Trigger or simulate `customer.subscription.deleted`.

Expected for planned/admin cancellation:

- [ ] `billingCancelledByAdmin = true` before Stripe cancellation matters.
- [ ] Planned deletion does not mark `billingStatus = DELINQUENT`.
- [ ] If access window is still open, session remains `ACTIVE`.
- [ ] If access window has elapsed, session becomes `COMPLETED`.
- [ ] Audit clearly distinguishes planned cancellation from dunning/payment failure.
- [ ] Needs Review does not show subscription delinquency for planned cancellation.

Expected for payment-failure deletion:

- [ ] `cancellation_details.reason = payment_failed` results in `billingStatus = DELINQUENT`.
- [ ] Gate access is denied.
- [ ] Needs Review shows delinquency.

DB spot check:

```sql
select id, status, "billingStatus", "billingCancelledByAdmin", "expectedEnd", "endedAt"
from "Session"
where id = '<session_id>';
```

## Scenario 5: Overstay, Payment, and Cleanup

Max coverage: effective overstay, driver exit prompt, overstay checkout/payment, admin close cleanup.

Setup:

- Create an active session with `expectedEnd` in the past.

Actions:

- [ ] Driver visits `/entry`; gate is denied and overstay/payment prompt appears.
- [ ] Driver visits `/exit`; gate does not open before payment.
- [ ] Complete or simulate overstay payment.
- [ ] Admin closes the session with an end time before any stale overstay payment, if applicable.

Expected:

- [ ] Effective overstay is detected even if cron has not flipped `Session.status`.
- [ ] Gate does not open until overstay is settled.
- [ ] Overstay payment is linked to the session.
- [ ] Admin close removes overstay payments that occur after the selected close time.
- [ ] Audit includes relevant denial/open/spot-freed entries.

DB spot check:

```sql
select s.id, s.status, s."expectedEnd", p.type, p.amount, p.status, p."createdAt"
from "Session" s
left join "Payment" p on p."sessionId" = s.id
where s.id = '<session_id>'
order by p."createdAt";
```

## Scenario 6: Manual Stripe Damage

Max coverage: Stripe vs DB drift, Needs Review, dashboard link evidence.

Choose one:

- [ ] Create a DB `Payment` with no Stripe IDs.
- [ ] Remove or null a Stripe ID in Neon DB for a real paid row.
- [ ] Change a DB payment amount away from the Stripe amount.
- [ ] Refund a Stripe charge manually from Stripe dashboard without using the app, then send/replay webhook if possible.

Expected:

- [ ] No app page crashes.
- [ ] Needs Review shows the appropriate issue:
  - `DB_PAYMENT_WITHOUT_STRIPE_CHARGE`
  - `DB_STRIPE_AMOUNT_MISMATCH`
  - `REFUND_DETAIL_MISSING`
  - `QB_REFUND_RECEIPT_MISSING`
- [ ] Stripe remains payment truth; QuickBooks edits do not override Stripe/DB payment state.
- [ ] Admin has enough IDs/links to inspect the Stripe object.

DB mutation examples:

```sql
-- Force missing Stripe proof on a test payment only.
update "Payment"
set "stripeChargeId" = null,
    "stripePaymentIntentId" = null
where id = '<payment_id>';

-- Force amount drift on a test payment only.
update "Payment"
set amount = amount + 1.23
where id = '<payment_id>';
```

## Scenario 7: Manual QuickBooks Damage

Max coverage: QB as accounting mirror, receipt drift, sync actions.

Actions:

- [ ] Pick one paid row with `qbSalesReceiptId`.
- [ ] In QuickBooks sandbox, change the Sales Receipt amount or delete/void the receipt.
- [ ] Pick one refunded row with `qbRefundReceiptId`.
- [ ] Change, delete, or void the RefundReceipt.
- [ ] Reload Needs Review / Reconcile.

Expected:

- [ ] App does not treat QB as payment truth.
- [ ] Payment status and Stripe IDs remain unchanged.
- [ ] Needs Review reports missing/mismatched QB receipt/refund receipt.
- [ ] Sync action, if present, only writes the missing accounting mirror and does not alter Stripe payment state.

DB spot check:

```sql
select id, amount, "stripeChargeId", "qbSalesReceiptId", "qbSalesReceiptAmount"
from "Payment"
where id = '<payment_id>';

select id, amount, "stripeRefundId", "qbRefundReceiptId", "qbRefundReceiptAmount"
from "PaymentRefund"
where id = '<refund_id>';
```

## Scenario 8: Manual Neon DB Damage

Max coverage: corrupted local state, fail-closed access policy, reconcile surfacing.

Only run this on test DB.

Actions:

- [ ] Set a monthly active session to `billingStatus = PAYMENT_FAILED` and `billingFailedAt = null`.
- [ ] Set policy to `after_grace_days`.
- [ ] Attempt gate open.
- [ ] Set an active session `expectedEnd` far in the past.
- [ ] Set a cancelled paid session `cancellationDisposition = N_A`.
- [ ] Reload Needs Review.

Expected:

- [ ] PAYMENT_FAILED with null timestamp fails closed; gate is denied.
- [ ] Stuck active session appears as `ACTIVE_SESSION_PAST_EXPECTED_END`.
- [ ] Cancelled paid session without disposition appears as `CANCELLED_SESSION_WITH_UNRECONCILED_CHARGE`.
- [ ] The UI does not crash on corrupted-but-schema-valid rows.

DB mutation examples:

```sql
update "Session"
set "billingStatus" = 'PAYMENT_FAILED',
    "billingFailedAt" = null
where id = '<monthly_session_id>';

update "Session"
set "expectedEnd" = now() - interval '2 days'
where id = '<active_session_id>';

update "Session"
set "status" = 'CANCELLED',
    "cancellationDisposition" = 'N_A'
where id = '<paid_session_id>';
```

## Scenario 9: Unknown Stripe Subscription Deletion

Max coverage: unknown external event classification, audit, Needs Review.

Setup:

- Use a monthly active session.
- Send or simulate a `customer.subscription.deleted` event that has no clear planned-cancellation or payment-failure signal.

Expected:

- [ ] Webhook returns success and records `StripeEvent`.
- [ ] Audit contains a stable unknown-deletion marker.
- [ ] Needs Review shows `SUBSCRIPTION_DELETION_UNKNOWN`.
- [ ] The event does not silently disappear.
- [ ] Admin has enough IDs to inspect the Stripe subscription.

## Cross-System Invariants

After every scenario, these should hold:

- [ ] One Stripe event ID is processed once. Duplicate delivery should not duplicate side effects.
- [ ] `Payment.refundedAmount <= Payment.amount`.
- [ ] Sum of `PaymentRefund.amount` for a payment equals `Payment.refundedAmount`.
- [ ] A session cannot keep opening the gate when blocked by overstay or delinquency.
- [ ] QB changes never mutate Stripe/DB payment truth by themselves.
- [ ] Admin money-moving actions are audited.
- [ ] Needs Review gives either a clear action or enough evidence IDs to investigate.
- [ ] Driver pages do not recompute authority that backend denied.

Useful invariant query:

```sql
select p.id, p.amount, p."refundedAmount", coalesce(sum(r.amount), 0) as refund_rows_total
from "Payment" p
left join "PaymentRefund" r on r."paymentId" = p.id
group by p.id
having p."refundedAmount" > p.amount
   or abs(p."refundedAmount" - coalesce(sum(r.amount), 0)) > 0.01;
```

## Pass / Fail Standard

Pass:

- The app detects manual Stripe/QB/DB drift without crashing.
- Gate access is denied when backend policy says it should be denied.
- Needs Review contains the expected issue code and action/evidence.
- Stripe remains payment truth; QB remains accounting output.
- Manual corrections can restore a healthy state or produce a clear remaining Needs Review item.

Fail:

- Gate opens for a clearly delinquent or overstay-blocked session.
- Stripe/QB/DB drift silently disappears from admin view.
- Manual QB edits change app payment truth.
- Refund totals can exceed paid amount.
- A webhook failure leaves no audit, no Needs Review item, and no obvious recovery path.
- Admin UI offers a dead or misleading action.

## Practical Confidence Target

If the full e2e suite passes and these manual scenarios pass, the remaining likely failures are not "normal admin clicked the wrong thing" failures. They are mostly:

- provider outage or token expiry,
- unsupported direct dashboard mutations,
- incomplete future feature paths,
- hardware/network failures,
- or genuinely new edge cases.

That is the realistic confidence bar for a small custom system. The target is not mathematical impossibility; it is making normal mistakes visible, recoverable, and hard to turn into silent access or accounting drift.
