#!/usr/bin/env bash
# Run on your server as the deploy user. Copies the user units, reloads, enables (does NOT start the gateway unless --start).
# Needs a working user manager: `systemctl --user is-system-running` must answer (user@1000.service running).
set -euo pipefail
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
D="$(cd "$(dirname "$0")" && pwd)"; U="$HOME/.config/systemd/user"
systemctl --user is-system-running >/dev/null 2>&1 || [ "$(systemctl --user is-system-running 2>/dev/null)" = degraded ] || { echo "ERROR no systemd --user manager (user@$(id -u).service not running)"; exit 1; }
mkdir -p "$U"
install -m 0644 "$D/mixin-gateway.service" "$D/mixin-gateway-heartbeat.service" "$D/mixin-gateway-heartbeat.timer" "$D/mixin-gateway-daily.service" "$D/mixin-gateway-daily.timer" "$U/"
systemctl --user daemon-reload
systemctl --user enable mixin-gateway.service mixin-gateway-heartbeat.timer mixin-gateway-daily.timer
systemctl --user start mixin-gateway-daily.timer   # timer only; never starts/restarts the gateway
if [ "${1:-}" = "--start" ]; then systemctl --user start mixin-gateway.service mixin-gateway-heartbeat.timer; fi
systemctl --user --no-pager status mixin-gateway.service mixin-gateway-heartbeat.timer | head -20 || true
