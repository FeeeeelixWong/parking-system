# Scenario Support

Scenario builders create preconditions for tests. They are the only place where
direct DB seeding is acceptable as an alternative to driving the app UI.

## Rules

**Use app flows when the test is about that flow.**
If the test verifies check-in behavior, drive the UI through `/checkin`. Only use
a seed builder when setup is infrastructure, not the behavior under test.

**Use DB seeding when setup is not under test.**
A gate-access test doesn't need to verify check-in — it can seed an ACTIVE session
directly. A cancellation test doesn't need to verify payment — it can seed a paid
session via DB.

**All scenario data must include testRunId.**
Pass `world.testRun` to every seed call so rows are traceable and Stripe objects
are tagged. Never seed rows without a testRun unless in a legacy no-testRun path.

**Builders return the created rows, not world state.**
Return `{ driver, vehicle, spot, session }` (and payment when relevant). Tests
use these IDs for assertions, not world-level state.

**Do not encode business logic in builders.**
Builders create rows with known values. They do not compute rates, validate
amounts, or decide whether a session should exist. That logic lives in the app.

## Adding New Builders

Add a file per scenario domain:
- `daily.ts` — daily sessions (ACTIVE, pre-created)
- `monthly.ts` — monthly subscription sessions (add when needed)
- `payments.ts` — paid sessions with Stripe charge records (add when needed)

Each builder should be a named export like `seedXxxYyySession(world, overrides?)`.
