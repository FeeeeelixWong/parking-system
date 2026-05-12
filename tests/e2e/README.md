# E2E Test Suites

The E2E tree is split by the system boundary being exercised:

- `driver-write/` covers driver-facing flows that mutate session, payment, audit, or gate state.
- `admin-write/` covers admin-facing mutation flows such as adjust, cancel, refund, settings, and spot overrides.
- `payments-accounting/` covers Stripe, QuickBooks, webhooks, reconciliation, and drift cases.
- `gold/` covers a small set of full business stories across browser, DB, Stripe, and QuickBooks.
- `support/` contains shared DB, browser, clock, and external-service harness utilities.

Use `ui/` subfolders for browser-driven Playwright tests. API or harness-only tests can live directly under the suite folder or in a more specific subfolder.

## Test Contracts

`TEST_CONTRACTS.md` is the implemented-test ledger. It states the strict
implication of each passing test and the nearby claims that are not proven.
Keep it narrower than the scenario matrix: the matrix describes desired
coverage, while the contract file describes what the current specs actually
assert.
