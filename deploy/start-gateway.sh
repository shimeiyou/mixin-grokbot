#!/usr/bin/env bash
# Foreground launcher (systemd ExecStart, or by hand): env file -> deps -> exec node gateway.js.
# The process keeps the command line "node gateway.js" (check-heartbeat.sh relies on it).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
load_env || exit 78   # EX_CONFIG: systemd won't hot-loop on a missing secret (RestartPreventExitStatus=78)
ensure_deps || exit 1
fix_perms
cd "$GW_DIR" && exec node gateway.js
