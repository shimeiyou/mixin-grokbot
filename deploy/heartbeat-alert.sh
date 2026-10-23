#!/usr/bin/env bash
# systemd --user oneshot (mixin-gateway-heartbeat.service): env file -> node deploy/heartbeat-alert.js. Prints no secrets.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
load_env >/dev/null || exit 78
cd "$GW_DIR" && exec node deploy/heartbeat-alert.js "$@"
