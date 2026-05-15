#!/usr/bin/env bash
# PreToolUse (Bash) — fires before `git add` or `git commit` commands.
# Blocks if secrets files are staged or lint/typecheck fails.
# Cheap typecheck excludes the .next/dev/types noise that's always present.
set -euo pipefail

INPUT=$(cat)
COMMAND=$(node -e "
  const d = JSON.parse(process.argv[1]);
  process.stdout.write(d.tool_input?.command ?? '');
" "$INPUT" 2>/dev/null || true)

[[ -z "$COMMAND" ]] && exit 0

# Only on git add or git commit
echo "$COMMAND" | grep -qE '^\s*git\s+(add|commit)' || exit 0

ERRORS=()
WARNINGS=()

# --- Secrets check ---
STAGED=$(git diff --cached --name-only 2>/dev/null || true)

if echo "$STAGED" | grep -qE '\.env\.e2e\.local$'; then
  ERRORS+=(".env.e2e.local is staged — this file holds QB and Stripe test secrets and must NOT be committed")
fi

# Any .env* file that isn't *.example or *.sample
STAGED_ENV=$(echo "$STAGED" | grep -E '(^|/)\.env(\.[^/]+)?$' | grep -vE '\.(example|sample)$' || true)
if [[ -n "$STAGED_ENV" ]]; then
  while IFS= read -r f; do
    ERRORS+=("Secrets file staged: $f")
  done <<< "$STAGED_ENV"
fi

# --- Lint (only on git commit, not git add) ---
if echo "$COMMAND" | grep -q 'git commit'; then
  if ! npm run lint --silent 2>/dev/null; then
    ERRORS+=("npm run lint failed — fix lint errors before committing")
  fi

  # Source-only typecheck; ignore .next/dev/types which always has framework noise.
  # tsc errors span multiple lines (header + indented continuations); awk drops the
  # entire group whose header is in .next/dev/types rather than just the header line.
  TSC_OUT=$(npx tsc --noEmit --pretty false 2>&1 \
    | awk '/^[^ ]/ { skip = /\.next\/dev\/types/ } !skip' \
    || true)
  if [[ -n "$TSC_OUT" ]]; then
    FIRST=$(echo "$TSC_OUT" | head -5)
    ERRORS+=("TypeScript errors (source files only):\n$FIRST")
  fi
fi

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  REASON=$(printf '%s\n' "${ERRORS[@]}")
  node -e "
    const lines = process.argv[1].split('\n').filter(Boolean);
    const reason = 'Pre-commit safety check failed:\n' + lines.map(l => ' • ' + l).join('\n');
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  " "$REASON"
  exit 0
fi
