# Claude Parallel Issue Investigation Prompts

Use these as three separate Claude tasks so the investigations can run in parallel. These are review-only tasks. Do not implement fixes in these runs.

## Prompt A: Investigate Issue #9 — Month Overflow

```text
Investigate GitHub issue #9 in ThomasEsayas0100/parking-system:
"[Bug Contract] addMonths month-overflow silently grants free extra parking days on end-of-month check-ins"

Mode: review-only. Do not edit files. Do not open a PR.

Branch/ref:
- Review the current pushed branch: planning/needs-review-actionability.
- State the exact commit SHA reviewed and whether the working tree is clean.

Goal:
Determine whether #9 is credible, overstated, or stale against this branch. If credible, produce a fix-ready recommendation and the smallest tests that should prove it.

Read:
- src/lib/rates.ts
- src/app/api/sessions/route.ts
- src/app/api/admin/sessions/route.ts
- src/lib/stripe-checkout-service.ts
- src/app/admin/ManageSessionModal.tsx
- relevant tests under tests/e2e/

Questions:
1. Does the production helper still use Date.setMonth in a way that overflows end-of-month dates?
2. Are there duplicate frontend/admin helpers that would drift even if src/lib/rates.ts is fixed?
3. What should the expected business rule be for Jan 31 + 1 month: Feb 28/29 or Mar 03?
4. Which code paths create monthly expectedEnd values?
5. What is the smallest safe fix?
6. What tests should be added or updated?

Output:
- Verdict: credible / stale / overstated / false.
- Evidence with file/line references.
- Recommended fix.
- Tests to add.
- Whether to update issue #9 with a comment.

GitHub behavior:
- At most one GitHub write.
- If you comment, include only confirmed evidence and keep it concise.
```

## Prompt B: Investigate Issue #10 — Cron Auth

```text
Investigate GitHub issue #10 in ThomasEsayas0100/parking-system:
"[Bug Contract] Cron endpoint unauthenticated — notification spam and premature overstay flags"

Mode: review-only. Do not edit files. Do not open a PR.

Branch/ref:
- Review the current pushed branch: planning/needs-review-actionability.
- State the exact commit SHA reviewed and whether the working tree is clean.

Goal:
Determine whether #10 is credible, overstated, or stale against this branch. If credible, produce a fix-ready recommendation that accounts for Vercel cron and any local/test cron usage.

Read:
- src/app/api/cron/check-sessions/route.ts
- src/proxy.ts
- vercel.json
- src/lib/env.ts
- tests touching cron/session checks/delinquency
- docs/BUG_CONTRACT.md and docs/BUG_CONTRACT_SCHEDULE.md only if needed for intent

Questions:
1. Is /api/cron/check-sessions publicly callable without auth on this branch?
2. What state mutations and notifications can it trigger?
3. Does Vercel provide or expect Authorization: Bearer CRON_SECRET for cron invocations?
4. Do tests or local demo workflows call the cron endpoint without auth?
5. What should the dev/test behavior be when CRON_SECRET is missing?
6. What is the smallest safe fix and test plan?

Output:
- Verdict: credible / stale / overstated / false.
- Evidence with file/line references.
- Recommended auth contract.
- Tests to add.
- Any migration/env/config implications.
- Whether to update issue #10 with a comment.

GitHub behavior:
- At most one GitHub write.
- If you comment, include only confirmed evidence and keep it concise.
```

## Prompt C: Investigate Issue #8 — Gate / Allowlist Audit

```text
Investigate GitHub issue #8 in ThomasEsayas0100/parking-system:
"[Bug Contract] Suspicious-entry detection window cleared by exit scan; allowlist direction defaults to entrance"

Mode: review-only. Do not edit files. Do not open a PR.

Branch/ref:
- Review the current pushed branch: planning/needs-review-actionability.
- State the exact commit SHA reviewed and whether the working tree is clean.

Goal:
Separate the real bugs from policy questions in #8. The issue may contain multiple findings with different credibility.

Read:
- src/lib/gate.ts
- src/app/api/sessions/[id]/open-gate/route.ts
- src/app/api/allowlist/open-gate/route.ts
- src/lib/audit.ts
- tests/e2e/driver-write/api/
- tests/e2e/driver-write/ui/

Questions:
1. Does checkSuspiciousEntry claim to detect two consecutive ENTRANCE scans only, or a broader re-entry-after-exit pattern?
2. Is the "exit clears suspicious-entry window" finding a real runtime bug, a policy question, or overstated?
3. Is allowlist direction optional and does it default audit text to entrance?
4. Are allowlist denials audited consistently with session gate denials?
5. What are the smallest fixes and tests for the confirmed parts?
6. Should #8 be split into separate issues?

Output:
- Verdict per finding:
  - suspicious-entry window
  - allowlist direction default
  - allowlist denial audit gap
- Evidence with file/line references.
- Recommended triage: keep / split / downgrade / close.
- Tests to add.
- Whether to update issue #8 with a comment.

GitHub behavior:
- At most one GitHub write.
- If you comment, include only confirmed evidence and keep it concise.
```
