# Driver E2E Contract

These Playwright tests exercise the driver browser flows that can open the gate.
They intentionally assert database/audit effects instead of only checking UI copy.

## Safety

- Tests require `TEST_DATABASE_URL`.
- The test helper refuses to run unless the URL contains `test`, `localhost`, or `127.0.0.1`.
- The helper resets all app tables before each test.
- Do not point `TEST_DATABASE_URL` at dev, staging, or production data.

## Gate Observation Rule

The authoritative signal for a successful gate command is an `AuditLog` row with
`action = GATE_OPEN` for the target `sessionId`.

Adversarial flows must assert that `GATE_OPEN` count does not increase. Where the
backend explicitly denies the request, tests may also assert `GATE_DENIED` or
`SUSPICIOUS_ENTRY`.

## Initial Driver Flows

### Fresh Entry Scan Opens Once

Given a saved driver with an active session, a fresh navigation to `/entry`
should call the backend gate command exactly once.

Expected DB state:

- existing `Session` remains `ACTIVE`
- one new `AuditLog(GATE_OPEN)` exists for the session
- no `GATE_DENIED` exists for the scan

### Refresh Does Not Open Again

After a fresh `/entry` scan opens the gate, refreshing the page must not create a
second `GATE_OPEN`.

Expected DB state:

- `GATE_OPEN` count remains unchanged after refresh
- session remains `ACTIVE`

### Second Device Is Suspicious

If one device opens entrance for a session, a second device using the same saved
driver/session should not open entrance again.

Expected DB state:

- first device creates one `GATE_OPEN`
- second device creates no additional `GATE_OPEN`
- `AuditLog(SUSPICIOUS_ENTRY)` exists

### LocalStorage Tampering / Stolen Driver Identity

Current behavior can trust a saved driver object enough to open the gate on a new
browser if the attacker knows the driver id and phone. The desired future
contract is that a new device requires PIN verification before gate access.

This test is marked expected-fail until device/PIN verification exists.

Future expected DB state:

- no `GATE_OPEN` for the new device
- a typed denial or verification-required audit/event exists

## Later Additions

- Returning-driver phone lookup should require PIN before opening an active session.
- Overstay entrance should never open and should offer overstay checkout.
- Exit flow should assert the explicit session lifecycle contract.
- Payment flows should combine Stripe webhook/reconcile tests with UI assertions.
