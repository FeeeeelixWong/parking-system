#!/usr/bin/env bash
# PreToolUse (Bash) — blocks running Stripe/QB E2E tests if live API keys are present.
# Only fires when the command looks like a playwright run touching payment/provider tests.
set -euo pipefail

INPUT=$(cat)
COMMAND=$(node -e "
  const d = JSON.parse(process.argv[1]);
  process.stdout.write(d.tool_input?.command ?? '');
" "$INPUT" 2>/dev/null || true)

[[ -z "$COMMAND" ]] && exit 0

# Only applies when running playwright tests
echo "$COMMAND" | grep -qE '(playwright.*test|npx.*playwright)' || exit 0

# Only applies when the test path touches payment/provider tests
echo "$COMMAND" | grep -qiE '(stripe|qb|payment|accounting|payments-accounting)' || exit 0

ERRORS=()

# Live Stripe secret key
STRIPE_SECRET="${STRIPE_SECRET_KEY:-}"
if [[ "$STRIPE_SECRET" == sk_live_* ]]; then
  ERRORS+=("STRIPE_SECRET_KEY is a live key (sk_live_*) — refusing to run against live Stripe")
fi

# Live Stripe publishable key
STRIPE_PUB="${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:-}"
if [[ "$STRIPE_PUB" == pk_live_* ]]; then
  ERRORS+=("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is a live key (pk_live_*)")
fi

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  REASON=$(printf ' • %s\n' "${ERRORS[@]}")
  node -e "
    const reason = 'Provider test safety check failed:\n' + process.argv[1];
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  " "$REASON"
  exit 0
fi
