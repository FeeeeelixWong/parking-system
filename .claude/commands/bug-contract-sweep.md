# Bug Contract Sweep

Run one focused bug-contract pass from `docs/BUG_CONTRACT.md`. Do not broaden scope.

Input: $ARGUMENTS

Interpret input as either:
- `explore <target>`: inspect one stable target for new drift.
- `review <issue-or-finding>`: verify, refine, downgrade, duplicate-check, or make an existing finding fix-ready.
- `<target>`: default to explore mode.

Process:
1. State mode and target/issue.
2. State repository, branch, commit SHA, and whether the working tree is clean.
3. For explore: read only the selected target section, listed files, and directly relevant tests.
4. For review: read the selected issue/finding plus only the files needed to verify or refine it.
5. State the expected invariant or claim in plain English before reviewing.
6. Search for code paths that prove, weaken, or disprove the claim.
7. Classify the result as runtime-bug, policy-question, stale-branch-note, test-gap, or nothing-material.
8. If findings exist, check existing GitHub issues by title/label if GitHub access is available.
9. Make at most one GitHub write: create one issue, comment on one issue, or do nothing; then stop.
10. Report one of: new finding, strengthened finding, downgraded finding, duplicate, fix-ready proposal, missing test, architecture implication, or nothing material.
11. Do not implement fixes unless explicitly asked.
