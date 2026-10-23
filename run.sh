#!/usr/bin/env bash
# Usage: ./run.sh start|stop|status   (env: MIXIN_KEYSTORE_JSON, MIXIN_WEBHOOK_URL, MIXIN_WEBHOOK_KEY)
cd "$(dirname "$0")"
PIDFILE=supervisor.pid
case "${1:-start}" in
  start)
    if [ -f deploy/MIGRATED_TO_VPS ]; then echo "REFUSED: deploy/MIGRATED_TO_VPS exists (gateway runs on a remote host; see docs/operations.md)"; exit 3; fi
    if [ -f $PIDFILE ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then echo "already running (pid $(cat $PIDFILE))"; exit 0; fi
    nohup bash -c '
      trap "kill \$child 2>/dev/null; exit 0" TERM INT
      while true; do
        node gateway.js & child=$!; wait $child; code=$?
        echo "[$(date -Is)] gateway exited code=$code, restarting in 5s" >> gateway.log
        sleep 5
      done' >> supervisor.out 2>&1 &
    echo $! > $PIDFILE; echo "started supervisor pid $(cat $PIDFILE)";;
  stop)
    [ -f $PIDFILE ] && kill "$(cat $PIDFILE)" 2>/dev/null; rm -f $PIDFILE; echo stopped;;
  status)
    if [ -f $PIDFILE ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then echo "running (pid $(cat $PIDFILE))"; else echo "not running"; fi;;
  *) echo "usage: $0 start|stop|status"; exit 2;;
esac
