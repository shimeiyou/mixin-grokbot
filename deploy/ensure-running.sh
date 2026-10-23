#!/usr/bin/env bash
# Idempotent "start the gateway if it isn't running" for hosts WITHOUT systemd (e.g. containers where PID 1 is tini).
# Safe to call every few minutes and after a reboot: does nothing if a gateway / run.sh supervisor is alive.
# Usage: deploy/ensure-running.sh [--dry-run]       (env: MIXIN_ENV_FILE, default ~/.mixin-secrets/mixin-gateway.env)
set -uo pipefail
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
. "$(dirname "$0")/lib.sh"
cd "$GW_DIR" || exit 1
# Remote-gateway marker: the gateway runs on another host (see docs/operations.md). Never start a second Blaze
# connection here while the marker exists; remove it to run the gateway locally again.
if [ -f "$GW_DIR/deploy/MIGRATED_TO_VPS" ]; then say "REFUSED: deploy/MIGRATED_TO_VPS exists (gateway runs on a remote host); not starting a local gateway"; exit 0; fi
exec 9>"$GW_DIR/.ensure-running.lock"; flock -n 9 || { say "another ensure-running is active"; exit 0; }
if [ -f supervisor.pid ] && kill -0 "$(cat supervisor.pid)" 2>/dev/null; then say "running (supervisor pid $(cat supervisor.pid))"; exit 0; fi
# Default: any "node gateway.js" on the host counts (never two Blaze listeners for one session).
# ENSURE_SCOPE=dir (tests only) counts only gateways whose cwd is this directory.
gw=""; for p in $(pgrep -fx 'node gateway.js'); do
  if [ "${ENSURE_SCOPE:-host}" != dir ] || [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$GW_DIR" ]; then gw="$gw $p"; fi; done
if [ -n "$gw" ]; then say "gateway running without supervisor (pid$gw); not starting a second Blaze"; exit 0; fi
say "gateway NOT running"
load_env || exit 78
ensure_deps || exit 1
fix_perms
if [ "${DRY_RUN:-0}" = 1 ]; then say "DRY-RUN would run: ./run.sh start"; exit 0; fi
./run.sh start 9>&-   # do not leak the lock fd into the long-lived supervisor
