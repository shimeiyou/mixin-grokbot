#!/usr/bin/env bash
# Read-only external liveness check. Usage: ./check-heartbeat.sh [gateway.log]
# Exit 0 = OK (heartbeat < MAX_AGE_S old), 1 = STALE / no heartbeat yet.
cd "$(dirname "$0")"
LOG="${1:-${MIXIN_GATEWAY_LOG:-gateway.log}}"
MAX_AGE_S="${HEARTBEAT_MAX_AGE_S:-600}"
sup="none"; gw="none"
if [ -f supervisor.pid ] && kill -0 "$(cat supervisor.pid)" 2>/dev/null; then sup="pid $(cat supervisor.pid)"; fi
p=$(pgrep -fx 'node gateway.js' | tr '\n' ' ' | sed 's/ $//'); [ -n "$p" ] && gw="pid $p"
procs="gateway=$gw supervisor=$sup"
line=$(grep -E '^\[[^]]+\] heartbeat ' "$LOG" 2>/dev/null | tail -n 1)
if [ -z "$line" ]; then echo "STALE no heartbeat yet in $LOG (fix not deployed / not restarted?) $procs"; exit 1; fi
ts=$(printf '%s' "$line" | sed -E 's/^\[([^]]+)\].*/\1/')
t=$(date -d "$ts" +%s 2>/dev/null) || { echo "STALE unparseable heartbeat ts=$ts $procs"; exit 1; }
age=$(( $(date +%s) - t ))
local_ts=$(date -d "$ts" '+%Y-%m-%d %H:%M:%S %Z')
if [ "$age" -gt "$MAX_AGE_S" ]; then echo "STALE last heartbeat ${age}s ago ($local_ts) > ${MAX_AGE_S}s $procs"; exit 1; fi
echo "OK last heartbeat ${age}s ago ($local_ts) $procs"; exit 0
