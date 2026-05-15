#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
file_path="$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))' 2>/dev/null || true)"

case "$file_path" in
  *src/app/api/admin/sessions/route.ts|\
  *src/app/api/admin/payments/route.ts|\
  *src/app/api/admin/reconcile/needs-review/route.ts|\
  *src/app/api/admin/reconcile/charges-receipts/route.ts|\
  *src/app/api/stripe/webhook/route.ts|\
  *src/lib/quickbooks.ts|\
  *src/lib/stripe-checkout-service.ts)
    cat <<'MSG' >&2
Reminder: this file participates in Stripe/QB/DB external-write behavior.
- Confirm the response can drive AdminExternalWriteStatus when an admin action writes externally.
- Name landed/skipped/failed systems explicitly; avoid vague success booleans.
- Check idempotency keys, audit rows, Needs Review follow-up, and partial-failure retry behavior.
MSG
    ;;
esac
