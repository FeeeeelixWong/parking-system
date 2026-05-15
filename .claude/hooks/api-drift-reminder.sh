#!/usr/bin/env bash
# PostToolUse — fires when Edit/Write touches an API route or reconcile types.
# Reminds Claude to keep CLAUDE.md and TEST_CONTRACTS.md from drifting.
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(node -e "
  const d = JSON.parse(process.argv[1]);
  process.stdout.write(d.tool_input?.file_path ?? '');
" "$INPUT" 2>/dev/null || true)

[[ -z "$FILE_PATH" ]] && exit 0

IS_ROUTE=$(echo "$FILE_PATH" | grep -qE 'src/app/api/.*route\.ts$' && echo yes || echo no)
IS_RECONCILE=$(echo "$FILE_PATH" | grep -qE 'src/types/reconcile\.ts$' && echo yes || echo no)

[[ "$IS_ROUTE" == "no" && "$IS_RECONCILE" == "no" ]] && exit 0

echo ""
echo "=== API/RECONCILE CHANGE: check for docs drift ==="
echo "File: $FILE_PATH"
echo ""

if [[ "$IS_ROUTE" == "yes" ]]; then
  echo "  • CLAUDE.md — does the API route table still match? (new routes, removed routes, changed methods)"
  echo "  • tests/e2e/TEST_CONTRACTS.md — are any contracts affected by this route change?"
fi

if [[ "$IS_RECONCILE" == "yes" ]]; then
  echo "  • CLAUDE.md — do the NeedsReview code descriptions still match?"
  echo "  • tests/e2e/TEST_CONTRACTS.md — update any contract referencing the changed codes"
  echo "  • src/lib/schemas.ts AuditActionSchema — if audit actions changed, keep it in sync"
fi
