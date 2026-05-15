# Bug Contract Schedule

This runbook defines how to run alternating Claude and Codex maintenance passes against `docs/BUG_CONTRACT.md`.

The goal is not to maximize issue creation. The goal is slow, bounded pressure on stable parts of the system: discover new drift when the queue is light, and refine or close existing findings when the queue grows.

## Cadence

Run one agent every 3 hours, alternating model families:

```text
00:00 Claude
03:00 Codex
06:00 Claude
09:00 Codex
12:00 Claude
15:00 Codex
18:00 Claude
21:00 Codex
```

Equivalent setup:

- Claude routine: every 6 hours at `00:00, 06:00, 12:00, 18:00`.
- Codex automation: every 6 hours at `03:00, 09:00, 15:00, 21:00`.

Use the same repository, same branch policy, same issue label, and same evidence threshold for both.

## Required Repo Access

Minimum GitHub permissions:

- Read repository contents.
- Read open issues.
- Comment on issues.
- Create issues.

Do not grant branch push/write permissions for scheduled bug-contract runs unless you intentionally want the run to open fix PRs. The default scheduled pass should not edit code.

Recommended labels:

- `bug-contract`
- `needs-triage`
- `runtime-bug`
- `policy-question`
- `stale-branch-note`
- `verified`
- `needs-provider-check`
- `fix-ready`
- `duplicate`
- `stale-or-rejected`

## Shared Mode Policy

Each run starts by counting open GitHub issues labeled `bug-contract`.

```text
open_bug_contract_issue_count = N
review_probability = min(0.9, 0.1 + 0.1 * N)
explore_probability = 1 - review_probability
```

Examples:

```text
0 open issues -> 10% Review, 90% Explore
3 open issues -> 40% Review, 60% Explore
6 open issues -> 70% Review, 30% Explore
8+ open issues -> 90% Review, 10% Explore
```

Interpretation:

- Explore creates pressure to discover new risk.
- Review creates pressure to reduce, refine, verify, duplicate-link, downgrade, or make existing work fix-ready.
- As the issue queue grows, the system should spend more time handling existing work instead of creating more.

## Claude Setup

Preferred path: Claude Code cloud Routine.

Create from Claude Code:

```text
/schedule every 6 hours run the parking-system bug-contract maintenance prompt
```

Then edit the routine schedule so it runs at:

```text
0 0,6,12,18 * * *
```

Use local timezone unless the routine UI requires UTC. If the UI stores UTC, convert from America/New_York before saving.

Claude routine prompt:

```text
You are running a scheduled bug-contract maintenance pass for /Users/thomasesayas/Documents/parking-system.

Agent identity: claude.

Rules:
1. Use the repository's docs/BUG_CONTRACT.md and docs/AGENT_WORKFLOWS.md as the source of truth.
2. State the exact repository, branch, commit SHA, and whether the working tree is clean before reviewing.
3. Check open GitHub issues labeled bug-contract.
4. Let N = open bug-contract issue count.
5. Compute review_probability = min(0.9, 0.1 + 0.1 * N).
6. Roll Explore vs Review using that probability. State the roll result.
7. If Explore, choose one stable target from docs/BUG_CONTRACT.md.
8. If Review, choose one existing bug-contract issue/finding that needs verification, de-duplication, severity adjustment, missing-test planning, architectural nuance, or fix planning.
9. Do not implement code. Do not open a PR. Do not modify files.
10. Search existing issues before creating a new one.
11. Classify any result as exactly one primary category:
   - runtime-bug: current code appears to violate an invariant.
   - policy-question: code is coherent, but the desired product/security policy is unclear.
   - stale-branch-note: the finding depends on branch/ref drift or outdated tests/docs.
   - test-gap: code may be fine, but the stated guarantee is not proven.
   - nothing-material: no issue worth tracking.
12. Perform at most one GitHub write per scheduled run:
   - either create one issue,
   - or comment on one existing issue,
   - or do nothing.
   After that write, stop immediately.
13. New issues must include labels: bug-contract, needs-triage, and one primary category label.
14. Output exactly one of:
   - new finding
   - strengthened finding
   - downgraded/rejected finding
   - duplicate
   - fix-ready proposal
   - missing test
   - architecture implication
   - nothing material
15. If evidence is concrete, comment on an existing issue or create one using the bug-contract issue template.
16. If evidence is not concrete, report "nothing material" or add a non-issue note only in the run summary.
17. Stop after one bounded target or one issue.

Evidence threshold:
- File/line references required for code findings.
- A reproduction path or exact missing assertion is required for test-contract findings.
- Provider claims must cite provider docs or be marked needs-provider-check.
- Speculation must not become a GitHub issue.
- If local state differs from GitHub main or the target branch, say which ref the evidence came from.
- Do not cite old file paths or old test counts without verifying them on the reviewed ref.
```

## Codex Setup

Preferred path: Codex Automation.

Create a recurring automation from Codex with a 6-hour cadence offset by 3 hours from Claude:

```text
03:00, 09:00, 15:00, 21:00
```

Codex automation prompt:

```text
You are running a scheduled bug-contract maintenance pass for /Users/thomasesayas/Documents/parking-system.

Agent identity: codex.

Rules:
1. Use the repository's docs/BUG_CONTRACT.md and docs/AGENT_WORKFLOWS.md as the source of truth.
2. State the exact repository, branch, commit SHA, and whether the working tree is clean before reviewing.
3. Check open GitHub issues labeled bug-contract.
4. Let N = open bug-contract issue count.
5. Compute review_probability = min(0.9, 0.1 + 0.1 * N).
6. Roll Explore vs Review using that probability. State the roll result.
7. If Explore, choose one stable target from docs/BUG_CONTRACT.md.
8. If Review, choose one existing bug-contract issue/finding that needs verification, de-duplication, severity adjustment, missing-test planning, architectural nuance, or fix planning.
9. Do not implement code. Do not open a PR. Do not modify files.
10. Search existing issues before creating a new one.
11. Classify any result as exactly one primary category:
   - runtime-bug: current code appears to violate an invariant.
   - policy-question: code is coherent, but the desired product/security policy is unclear.
   - stale-branch-note: the finding depends on branch/ref drift or outdated tests/docs.
   - test-gap: code may be fine, but the stated guarantee is not proven.
   - nothing-material: no issue worth tracking.
12. Perform at most one GitHub write per scheduled run:
   - either create one issue,
   - or comment on one existing issue,
   - or do nothing.
   After that write, stop immediately.
13. New issues must include labels: bug-contract, needs-triage, and one primary category label.
14. Output exactly one of:
   - new finding
   - strengthened finding
   - downgraded/rejected finding
   - duplicate
   - fix-ready proposal
   - missing test
   - architecture implication
   - nothing material
15. If evidence is concrete, comment on an existing issue or create one using the bug-contract issue template.
16. If evidence is not concrete, report "nothing material" or add a non-issue note only in the run summary.
17. Stop after one bounded target or one issue.

Evidence threshold:
- File/line references required for code findings.
- A reproduction path or exact missing assertion is required for test-contract findings.
- Provider claims must cite provider docs or be marked needs-provider-check.
- Speculation must not become a GitHub issue.
- If local state differs from GitHub main or the target branch, say which ref the evidence came from.
- Do not cite old file paths or old test counts without verifying them on the reviewed ref.
```

## Optional GitHub Actions Variant

Use this only if you want the schedule to live entirely in the repo.

Claude can run through Claude Code GitHub Actions on a cron trigger if `ANTHROPIC_API_KEY` is configured as a GitHub Actions secret. The scheduled workflow should use the same prompt above and grant only issue/comment permissions unless implementation is explicitly desired.

Codex should remain a Codex Automation unless a dedicated repo-owned Codex action/API trigger is configured. Do not fake Codex alternation with a different model and call it Codex; the value is model-family diversity.

## Output Contract

Every scheduled run should produce a short run summary:

```text
Agent: claude | codex
Reviewed ref: repo, branch, commit SHA, working-tree clean/dirty
Mode roll: Explore | Review
Open bug-contract issues: N
Target or issue:
Primary category: runtime-bug | policy-question | stale-branch-note | test-gap | nothing-material
Result type:
GitHub action taken: none | commented issue #123 | created issue #456
Evidence:
Next suggested human action:
```

## When To Pause The Schedule

Pause both schedules when:

- The admin UI refresh is changing the same target being audited.
- A large billing/refund/access branch is unmerged and already under human review.
- The issue queue exceeds what can be triaged manually.
- Provider credentials or GitHub permissions are being rotated.

Resume once the affected branch lands or the issue queue is triaged.
