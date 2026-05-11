# E2E Support Infrastructure

## Philosophy

Each test owns its data. Tests seed the DB rows they need, read them back via
audit count helpers, and never depend on order-of-execution or shared state.
`resetDb()` in `beforeEach` keeps tests isolated even when they all hit the
same real test database.

## Files

| File | Purpose |
|------|---------|
| `env.ts` | Load `.env.local` + `.env.e2e.local`; export `getE2EEnv()` with guards |
| `test-run.ts` | `createTestRun(testInfo?)` — per-test unique IDs, phone/email/metadata helpers |
| `db.ts` | DB seed, reset, disconnect, and read helpers (pg direct, no Prisma) |
| `stripe/client.ts` | Stripe test-mode client, test clocks, customer create, subscription cleanup |
| `driver-ui.ts` | Playwright helpers for driver-side UI (localStorage setup) |

## Environment Setup

Copy `.env.e2e.local.example` (if present) or create `.env.e2e.local`:

```
TEST_DATABASE_URL=postgres://...test-branch...
E2E_STRIPE_SECRET_KEY=sk_test_...
E2E_STRIPE_PUBLISHABLE_KEY=pk_test_...
E2E_STRIPE_WEBHOOK_SECRET=whsec_...
```

`TEST_DATABASE_URL` is required. Stripe keys are optional — tests that need them
will skip or fail with a clear message when they are absent.

## TestRun IDs

Every test should call `createTestRun(testInfo)` to get scoped helpers:

```typescript
test("my test", async ({ page }, testInfo) => {
  const testRun = createTestRun(testInfo);
  const { driver, session } = await seedActiveDriverSession({ testRun });
  // ...
});
```

The `testRunId` (`e2e_<timestamp>_<8hex>`) is embedded in:
- `Driver.email` — `driver+e2e_...<id>@example.test`
- `Payment.legacyQbReference` — `free_test:e2e_...<id>`

This lets you find and clean up a run's rows manually:
```sql
SELECT * FROM "Driver" WHERE email LIKE '%e2e_1746554400000_550e8400%';
```

## Phone Numbers

`testRun.driverPhone(index)` produces a 10-digit number unique to this run:
`555` + 4-digit hash of run ID + 3-digit index. Parallel workers won't collide
on the unique-phone DB constraint.

## Adding New Test Categories

- **DB-only tests** (no UI): import from `db.ts` only.
- **Stripe integration tests**: import `getE2EStripe()` from `stripe/client.ts`;
  guard the test with `test.skip(!getE2EEnv().stripe, "Stripe not configured")`.
- **QB integration tests**: not yet supported — do not add QB-touching tests until
  the QB support layer is built here.

## What NOT to do

- Do not use production `DATABASE_URL` — `requireTestDatabaseUrl()` enforces this.
- Do not use live Stripe keys — `getE2EEnv()` enforces `sk_test_` / `pk_test_` prefixes.
- Do not import from `src/` app code in support files — support layer is standalone.
- Do not add shared fixtures that tests mutate — shared state breaks parallel runs.
