# Agent Workflows

This repo uses agents best when the work is narrow, evidence-backed, and leaves durable artifacts. Prefer small prompts with explicit files, invariants, and verification commands over broad "look for bugs" requests.

## Local Claude Code

Use the project commands in `.claude/commands/`:

- `/review-branch` for code-review findings only.
- `/merge-readiness` before opening or merging a branch.
- `/e2e-contract-audit` when a test claims to prove a business invariant.
- `/bug-contract-sweep <target>` for one focused target from `docs/BUG_CONTRACT.md`.
- `/agent-prompt <goal>` to turn a loose idea into a bounded engineering prompt.

Use the project subagents in `.claude/agents/`:

- `reviewer`: general branch review.
- `provider-auditor`: Stripe, QuickBooks, webhook, refund, invoice, external-write reliability.
- `test-contract-auditor`: test assertion strength versus documented claims.
- `ui-implementer`: admin UI implementation once backend contracts exist.

The hooks in `.claude/hooks/` are guardrails, not a substitute for review. They remind agents about recurring failure modes: provider-test safety, schema migrations, API contract drift, E2E contract drift, and external-write status reporting.

## Codex Cloud / PR Review

Use Codex cloud for branch-sized implementation and review work when you want a separate workspace and a pull request. Good prompts should include:

- The target branch and files.
- Whether edits are allowed.
- Exact verification commands.
- Whether Stripe/QB/Neon live credentials may be used.
- What counts as done.

Useful patterns:

- Append `.diff` to a PR URL and ask for review of the diff only.
- Ask for a "merge-readiness report" before asking for fixes.
- Ask one Codex task to implement and a separate task to review when the change touches billing, refunds, or access.

## Remote Bug-Contract Runs

Desired recurring cadence: every 3-6 hours, alternating Claude and Codex runs against the same `docs/BUG_CONTRACT.md` process.

Run shape:

- Claude run, then Codex run, then Claude run, and so on.
- Both agents use the same mode policy, same evidence threshold, and same issue template.
- Neither agent implements fixes during a scheduled run unless a human explicitly converts a finding into an implementation task.
- Diversity comes from different model judgment, not different rules.

Mode policy:

1. Count open GitHub issues labeled `bug-contract`.
2. Compute `review_probability = min(0.9, 0.1 + 0.1 * open_bug_contract_issue_count)`.
3. Roll the mode:
   - `Explore`: inspect one stable target from `docs/BUG_CONTRACT.md` for new drift or missing coverage.
   - `Review`: refine, verify, downgrade, duplicate-check, or make fix-ready an existing bug-contract issue/finding.
4. If there are zero open bug-contract issues, Explore should usually win.
5. If there are many open issues, Review should dominate so the system helps reduce issue load instead of creating more.

Minimum remote runner behavior:

1. Check out the repo.
2. Identify agent identity: `claude` or `codex`.
3. Count open `bug-contract` issues.
4. Roll Explore or Review using the policy above.
5. Choose one bounded target or one existing issue.
6. Run the equivalent of `/bug-contract-sweep <mode> <target-or-issue>`.
7. Search existing GitHub issues by target name and key failure terms before creating anything.
8. Comment on a matching issue, create a new issue with `.github/ISSUE_TEMPLATE/bug-contract-finding.yml`, or report "nothing material."
9. Stop.

Avoid running many agents on the same broad target. Repeated independent findings are useful only when the target and invariant are stable.

Recommended stagger:

- Claude every 6 hours, starting at hour 0.
- Codex every 6 hours, starting at hour 3.
- Effective coverage: one run every 3 hours, alternating model families.

Example schedule:

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

## When To Use Which Workflow

Use local Claude Code when:

- You need fast repo navigation and small patch iterations.
- You want hooks to catch repeated local mistakes.
- You are still shaping the prompt or branch scope.

Use Codex cloud when:

- You want a separate PR or review workspace.
- The task can run independently for a while.
- You want a clean review of an existing diff.

Use scheduled bug-contract sweeps when:

- The area is stable enough to audit.
- The invariant is documented.
- The output should be an issue or evidence report, not a patch.

Do not schedule sweeps against areas under active UI refresh or feature design; they will create noisy findings against moving targets.
