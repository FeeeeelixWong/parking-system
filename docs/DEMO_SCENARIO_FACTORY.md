# Demo Scenario Factory

Creates repeatable, isolated DB + Stripe test + QB sandbox states for validating the admin UI. Each run produces a JSON manifest and can be reset cleanly.

---

## Prerequisites

Set these environment variables before running any demo command:

| Variable | Required | Purpose |
|---|---|---|
| `ALLOW_DEMO_SCENARIOS` | Always | Must be `true` |
| `TEST_DATABASE_URL` or `DEMO_DATABASE_URL` | Always | Points at a test/sandbox DB (never production) |
| `STRIPE_SECRET_KEY` | Stripe scenarios | Must start with `sk_test_` |
| QB tokens in Settings | QB scenarios (optional) | If absent, synthetic receipt IDs are used |

## Usage

```bash
# Create a scenario
ALLOW_DEMO_SCENARIOS=true npm run demo:create -- healthy-daily
ALLOW_DEMO_SCENARIOS=true npm run demo:create -- missing-qb-receipt
ALLOW_DEMO_SCENARIOS=true npm run demo:create -- refund-missing-qb
ALLOW_DEMO_SCENARIOS=true npm run demo:create -- failed-monthly-invoice

# List all created manifests
npm run demo:list

# Reset (delete) a scenario by testRunId
ALLOW_DEMO_SCENARIOS=true npm run demo:reset -- demo_healthy-daily_1715000000_abc1
```

## Phase 1 Scenarios

### `healthy-daily`
- **State**: Completed daily session, real Stripe charge, QB Sales Receipt (synthetic if QB unconfigured)
- **Needs Review codes**: _(none)_ — use as baseline
- **Verifies**: Admin UI shows a clean completed session with no alerts

### `missing-qb-receipt`
- **State**: Completed daily session, real Stripe charge, **no QB receipt**
- **Needs Review codes**: `QB_RECEIPT_MISSING`
- **Verifies**: Admin "Sync QB receipts" button works with the real Stripe charge ID

### `refund-missing-qb`
- **State**: Completed daily session, real Stripe charge + refund, QB Sales Receipt present, **no QB refund receipt**
- **Needs Review codes**: `QB_REFUND_RECEIPT_MISSING`
- **Verifies**: Admin "Sync refund receipt" flow works with the real Stripe refund ID

### `failed-monthly-invoice`
- **State**: Active monthly session, `billingStatus=PAYMENT_FAILED`, `billingFailedAt` 3 days ago, real Stripe subscription + invoice with `hostedInvoiceUrl`
- **Needs Review codes**: `SUBSCRIPTION_PAYMENT_FAILED`
- **Verifies**: Admin "Open invoice" link is functional; policy-aware detail text is shown

## Manifest Format

Each scenario creates `.demo-manifests/<testRunId>.json`:

```json
{
  "scenario": "missing-qb-receipt",
  "testRunId": "demo_missing-qb-receipt_1715000000_a3f2",
  "createdAt": "2026-05-13T10:00:00.000Z",
  "driverPhone": "5551234567",
  "driverId": "uuid",
  "vehicleId": "uuid",
  "sessionId": "uuid",
  "paymentId": "uuid",
  "stripeCustomerId": "cus_...",
  "stripePaymentIntentId": "pi_...",
  "stripeChargeId": "ch_...",
  "expectedNeedsReviewCodes": ["QB_RECEIPT_MISSING"],
  "suggestedAdminAction": "Sync QB receipts from the Payments tab."
}
```

The `.demo-manifests/` directory is gitignored.

## Reset Behavior

`demo:reset <testRunId>` deletes:
- DB: PaymentRefund → Payment → Session → Vehicle → Driver (exact by testRunId)
- Stripe: subscription cancelled (if present), customer deleted
- QB: prints receipt IDs for manual deletion in QB sandbox (QB has no delete API)
- Manifest file

**Stripe note**: Stripe charges and refunds remain in test history after customer deletion — this is a Stripe limitation and does not affect DB cleanup or future tests.

## Isolation

Each run uses a unique `testRunId` (`demo_<scenario>_<epochSeconds>_<4charRandom>`) embedded in:
- Driver email: `demo_<testRunId>@demo.test`
- Stripe customer/subscription metadata: `testRunId`, `scenario`, `createdBy`

This ensures concurrent runs don't interfere.

## Adding Phase 2 Scenarios

Phase 2 scenarios (`cancelled-retained-payment`, `delinquent-monthly`) are not yet implemented. To add them:
1. Create `scripts/demo-scenario-factory/scenarios/<name>.ts` following the Phase 1 pattern
2. Add the case to the `switch` in `cli.ts`
3. Add to `STRIPE_SCENARIOS` in `cli.ts` if Stripe-backed
