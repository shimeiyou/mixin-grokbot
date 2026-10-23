#!/usr/bin/env bash
# Installs deploy/mixin-gateway.service. Default = dry run (prints the plan). Nothing is enabled/started unless asked.
#   deploy/install-systemd.sh                 -> check + print plan only
#   sudo deploy/install-systemd.sh --install [--enable] [--start]
set -uo pipefail
. "$(dirname "$0")/lib.sh"
INSTALL=0 ENABLE=0 START=0
for a in "$@"; do case "$a" in --install) INSTALL=1;; --enable) ENABLE=1;; --start) START=1;; *) echo "unknown arg $a"; exit 2;; esac; done
UNIT_SRC="$GW_DIR/deploy/mixin-gateway.service"; UNIT_DST=/etc/systemd/system/mixin-gateway.service
pid1=$(ps -o comm= -p 1 2>/dev/null)
say "PID 1 = ${pid1:-unknown}; systemctl: $(command -v systemctl || echo missing); /run/systemd/system: $([ -d /run/systemd/system ] && echo present || echo missing)"
if [ "$pid1" != systemd ] || ! command -v systemctl >/dev/null || [ ! -d /run/systemd/system ]; then
  say "systemd is NOT usable on this host -> use deploy/ensure-running.sh (see README)"; exit 3
fi
if [ -f "$GW_DIR/supervisor.pid" ] && kill -0 "$(cat "$GW_DIR/supervisor.pid")" 2>/dev/null; then
  say "run.sh supervisor is running (pid $(cat "$GW_DIR/supervisor.pid")): stop it before --start (never two Blaze listeners)"
  [ $START = 1 ] && exit 4
fi
plan=("install -m 0644 $UNIT_SRC $UNIT_DST" "systemctl daemon-reload")
[ $ENABLE = 1 ] && plan+=("systemctl enable mixin-gateway.service")
[ $START = 1 ] && plan+=("systemctl start mixin-gateway.service")
for c in "${plan[@]}"; do if [ $INSTALL = 1 ]; then say "+ $c"; $c || exit 1; else say "PLAN: $c"; fi; done
[ $INSTALL = 1 ] || say "dry run only (pass --install)"
