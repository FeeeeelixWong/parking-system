#!/usr/bin/env bash
# PostToolUse — fires when Edit/Write/MultiEdit touches a spec file.
# Reminds Claude to keep TEST_CONTRACTS.md and scenarios/README.md in sync.
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(node -e "
  const d = JSON.parse(process.argv[1]);
  process.stdout.write(d.tool_input?.file_path ?? '');
" "$INPUT" 2>/dev/null || true)

[[ -z "$FILE_PATH" ]] && exit 0
echo "$FILE_PATH" | grep -qE 'tests/e2e/.*\.spec\.ts$' || exit 0

echo ""
echo "=== SPEC CHANGED: sync docs ==="
echo "File: $FILE_PATH"
echo ""
echo "Check these files and update if needed:"
echo "  • tests/e2e/TEST_CONTRACTS.md  — add/update the contract entry for this test"
echo "  • tests/e2e/scenarios/README.md — update if scenario coverage changed"
echo ""
echo "Skip silently only if the spec is a trivial rename or comment-only edit."
