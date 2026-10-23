#!/usr/bin/env bash
# Write the three secrets from the CURRENT environment into the persistent env file (dir 0700, file 0600).
# Values are never printed. Refuses to overwrite unless --force. Run it once by hand.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
[ -e "$MIXIN_ENV_FILE" ] && [ "${1:-}" != "--force" ] && { say "exists: $MIXIN_ENV_FILE (use --force to overwrite)"; exit 1; }
for v in "${REQUIRED_VARS[@]}"; do [ -n "${!v:-}" ] || { say "ERROR $v not set in this shell"; exit 1; }; done
umask 077; mkdir -p "$(dirname "$MIXIN_ENV_FILE")"; chmod 700 "$(dirname "$MIXIN_ENV_FILE")"
tmp="$MIXIN_ENV_FILE.tmp.$$"
{ echo "# mixin-gateway secrets ($(date -Is)); bash-sourceable; keep 0600"
  for v in "${REQUIRED_VARS[@]}"; do printf '%s=%q\n' "$v" "${!v}"; done
  for v in $(compgen -e | grep -E '^MIXIN_(PAYLOAD|MEDIA|FORWARD|WEBHOOK_QUEUE|WEBHOOK_CONTEXT|QUEUE|LOOKUP|ALLOWLIST)' || true); do printf '%s=%q\n' "$v" "${!v}"; done
} > "$tmp"
chmod 600 "$tmp"; mv "$tmp" "$MIXIN_ENV_FILE"
say "wrote $MIXIN_ENV_FILE ($(wc -l < "$MIXIN_ENV_FILE") lines, mode $(stat -c %a "$MIXIN_ENV_FILE")); values not shown"
