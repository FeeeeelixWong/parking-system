# Merge Readiness

Prepare a merge-readiness report for the current branch. Do not edit files.

Report:
- Dirty working tree summary grouped by feature area.
- Lint/typecheck/test status and exact commands run.
- Schema/migration status if prisma/schema.prisma changed.
- External systems touched: Stripe, QuickBooks, Neon/Postgres, Vercel cron.
- Known gaps, ordered by launch risk.
- Recommended commit split.

Scope hint from user: $ARGUMENTS
