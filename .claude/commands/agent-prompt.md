# Agent Prompt

Turn the requested work into a bounded implementation prompt for another engineering agent.

The prompt must include:
- Context and goal.
- Files likely owned by the task.
- Non-goals.
- Required tests and exact commands.
- Review traps specific to this codebase: migration drift, Stripe/QB idempotency, Needs Review action semantics, same-DB e2e invariant.
- Expected final report format.

User request: $ARGUMENTS
