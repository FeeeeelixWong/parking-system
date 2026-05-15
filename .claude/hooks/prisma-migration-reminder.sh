#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
file_path="$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))' 2>/dev/null || true)"

case "$file_path" in
  *prisma/schema.prisma)
    cat <<'MSG' >&2
Reminder: prisma/schema.prisma changed.
- Add or update a committed migration under prisma/migrations/.
- Run `npx prisma migrate status` before claiming migration safety.
- If columns were already applied manually, document the baseline/resolve step.
MSG
    ;;
esac
