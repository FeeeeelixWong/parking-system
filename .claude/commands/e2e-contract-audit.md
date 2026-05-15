# E2E Contract Audit

Audit the implemented tests against their claimed contract. Do not edit files unless explicitly asked.

For each relevant test:
- State the strict implication of PASS, no more.
- Identify any assertion gaps, false-pass risks, fixture shortcuts, or untested opposite cases.
- Recommend the smallest assertion that would make the implication true.
- Check `tests/e2e/TEST_CONTRACTS.md` for drift.

Scope hint from user: $ARGUMENTS
