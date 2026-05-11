# Demo Seed — Admin Dashboard States

Populates 8 named personas covering the full range of Needs Review states.
No Stripe or QB network calls — all IDs are synthetic.

## Usage

```bash
# Against local DB
DATABASE_URL="postgresql://..." npx tsx scripts/seed-demo.ts

# Against Neon test DB (same DB used by E2E tests)
TEST_DATABASE_URL="postgresql://..." DATABASE_URL="$TEST_DATABASE_URL" npx tsx scripts/seed-demo.ts
```

The script is **idempotent**: re-running it deletes previous demo data and re-seeds from scratch.

## Prerequisites

Run the lot seed first if spots have never been seeded (scenarios 6-8 borrow any
existing spot as a completed/cancelled session placeholder):

```bash
DATABASE_URL="..." npx tsx scripts/seed.ts
```

## Personas

| # | Name | Phone | Session | Billing | Expected NR |
|---|------|-------|---------|---------|-------------|
| 1 | Marco Rivera | 555-010-0011 | ACTIVE daily | CURRENT | None |
| 2 | Teresa Kim | 555-010-0021 | ACTIVE monthly | CURRENT | None |
| 3 | David Chen | 555-010-0031 | ACTIVE monthly | PAYMENT_FAILED | `SUBSCRIPTION_PAYMENT_FAILED` (actionHref) |
| 4 | Sandra Ortiz | 555-010-0041 | ACTIVE monthly | DELINQUENT | `SUBSCRIPTION_DELINQUENT` |
| 5 | James Washington | 555-010-0051 | ACTIVE (3h past end) | CURRENT | `ACTIVE_SESSION_PAST_EXPECTED_END` |
| 6 | Patricia Flores | 555-010-0061 | COMPLETED | CURRENT | `QB_RECEIPT_MISSING` (actionPath) |
| 7 | Robert Hughes | 555-010-0071 | CANCELLED / RETAINED | CURRENT | None |
| 8 | Angela Brooks | 555-010-0081 | COMPLETED | CURRENT | None |

## Expected Needs Review Output

After seeding, `GET /api/admin/reconcile/needs-review` returns **4 items**
(critical first, then by date descending):

```
[critical] SUBSCRIPTION_DELINQUENT          — Sandra Ortiz
[warning]  SUBSCRIPTION_PAYMENT_FAILED      — David Chen   (Open invoice ↗ — external link)
[warning]  ACTIVE_SESSION_PAST_EXPECTED_END — James Washington
[warning]  QB_RECEIPT_MISSING               — Patricia Flores  (Sync receipt — POST button)
```

## Action coverage

| Action type | Scenario | Code | UI element |
|-------------|----------|------|------------|
| External link (actionHref) | 3 — David Chen | `SUBSCRIPTION_PAYMENT_FAILED` | `<a target="_blank">Open invoice ↗</a>` |
| Internal POST (actionPath) | 6 — Patricia Flores | `QB_RECEIPT_MISSING` | `<button>Sync receipt</button>` |
| No action | 4 — Sandra Ortiz | `SUBSCRIPTION_DELINQUENT` | nothing rendered |
| No action | 5 — James Washington | `ACTIVE_SESSION_PAST_EXPECTED_END` | nothing rendered |

## Reset

```bash
# Re-run the seed — it cleans up previous demo data automatically
DATABASE_URL="..." npx tsx scripts/seed-demo.ts
```

To remove demo data without re-seeding, delete drivers with phones in the
`555-010-00XX` range directly via psql or the admin Drivers tab.
