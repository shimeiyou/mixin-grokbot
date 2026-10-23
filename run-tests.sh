#!/usr/bin/env bash
# Runs every test. All offline (fakes) except test-crypto.js (one read-only POST /sessions/fetch with the real keystore)
# and test-lookup.js when LIVE=1 (one read-only GET /users/<bot id>). Nothing is sent to anyone.
cd "$(dirname "$0")"; rc=0
# OFFLINE=1: skip test-crypto.js (the only test that needs the real keystore and the network); used on a fresh host.
CRYPTO=test-crypto.js; [ "${OFFLINE:-0}" = 1 ] && { CRYPTO=""; echo "== test-crypto.js: SKIPPED (OFFLINE=1)"; }
for t in test-conn.js $CRYPTO test-context.js test-parse.js test-attachment-crypto.js test-queue.js test-payload-cap.js test-media.js test-lookup.js test-ack.js test-gateway.js test-reply.js test-reply-group.js test-p0.js test-receipts.js test-official-decrypt.js test-backoff.js test-builder.js test-ssh-endpoint.js test-heartbeat-alert.js test-crypto-xval.js test-attach-guard.js test-gateway-status.js test-webhook-usage.js test-daily-summary.js; do
  printf '== %s: ' "$t"; out=$(MIXIN_GATEWAY_LOG=/tmp/mixin-test-$$.log node "$t" 2>&1); c=$?
  echo "$out" | tail -1; [ $c = 0 ] || { rc=1; echo "$out" | grep -E 'FAIL' | head -5; }
done
printf '== test-ops.sh: '; out=$(./test-ops.sh 2>&1); c=$?; echo "$out" | tail -1; [ $c = 0 ] || rc=1
exit $rc
