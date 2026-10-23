# Shared helpers for deploy/*.sh (sourced). Never prints secret values.
GW_DIR="${GW_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
MIXIN_ENV_FILE="${MIXIN_ENV_FILE:-$HOME/.mixin-secrets/mixin-gateway.env}"
REQUIRED_VARS=(MIXIN_KEYSTORE_JSON MIXIN_WEBHOOK_URL MIXIN_WEBHOOK_KEY)
say() { echo "[$(date -Is)] $*"; }
# Load KEY=VALUE exports from the env file (0600). Permissions are re-applied in case a backup restore reset them.
load_env() {
  if [ -f "$MIXIN_ENV_FILE" ]; then
    if [ "$(stat -c %u "$MIXIN_ENV_FILE")" != "$(id -u)" ]; then say "ERROR $MIXIN_ENV_FILE not owned by $(id -un)"; return 1; fi
    local m; m=$(stat -c %a "$MIXIN_ENV_FILE")
    if [ "$m" != "600" ]; then chmod 600 "$MIXIN_ENV_FILE"; say "WARN env file mode was $m, reset to 600"; fi
    chmod 700 "$(dirname "$MIXIN_ENV_FILE")" 2>/dev/null || true
    set -a; # shellcheck disable=SC1090
    . "$MIXIN_ENV_FILE"; set +a
    say "env loaded from $MIXIN_ENV_FILE"
  else
    say "env file $MIXIN_ENV_FILE not found; using the current environment"
  fi
  local v missing=0
  for v in "${REQUIRED_VARS[@]}"; do if [ -z "${!v:-}" ]; then say "ERROR $v is not set"; missing=1; else say "$v is set (value not shown)"; fi; done
  return $missing
}
# node_modules may be missing (fresh checkout / restore): reinstall from package-lock.json when deps don't resolve.
ensure_deps() {
  if (cd "$GW_DIR" && node -e "require('pako');require('@mixin.dev/mixin-node-sdk');require('ws');require('uuid')" >/dev/null 2>&1); then say "deps ok"; return 0; fi
  if [ "${DRY_RUN:-0}" = 1 ]; then say "DRY-RUN would run: (cd $GW_DIR && npm ci --no-audit --no-fund)"; return 0; fi
  say "deps missing -> npm ci"
  (cd "$GW_DIR" && flock "$GW_DIR/.npm-ci.lock" npm ci --no-audit --no-fund) || { say "ERROR npm ci failed"; return 1; }
}
fix_perms() { # private dirs written by the gateway (restore resets them to 0755)
  local d; for d in "${MIXIN_CONTEXT_DIR:-$GW_DIR/context}" "${MIXIN_QUEUE_DIR:-$GW_DIR/queue}" "${MIXIN_MEDIA_DIR:-$(cd "$GW_DIR/.." && pwd)/mixin-media}"; do
    [ -d "$d" ] && chmod 700 "$d" 2>/dev/null || true; done
}
