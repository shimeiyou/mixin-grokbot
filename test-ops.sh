#!/usr/bin/env bash
# Step 3 ops tests. Runs ONLY in a throwaway sandbox copy with FAKE secrets and a FAKE run.sh; never touches the
# live gateway dir, never starts a real gateway, never installs anything.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; pass=0; fail=0
ok() { if [ "$1" = 0 ]; then echo "PASS $2"; pass=$((pass+1)); else echo "FAIL $2"; fail=$((fail+1)); fi; }
SB=$(mktemp -d /tmp/ops-sb-XXXX); GW="$SB/gw"; mkdir -p "$GW"
( cd "$HERE" && tar --exclude=./node_modules --exclude=./context --exclude=./queue --exclude=./seen.json --exclude='*.log' --exclude='./supervisor.*' --exclude=./lookup-cache.json --exclude='*.bak*' --exclude=./deploy/MIGRATED_TO_VPS -cf - . ) | tar -xf - -C "$GW"
cat > "$GW/run.sh" <<'FAKE'
#!/usr/bin/env bash
cd "$(dirname "$0")"; echo "fake-run.sh $1 KS_SET=${MIXIN_KEYSTORE_JSON:+yes} URL_SET=${MIXIN_WEBHOOK_URL:+yes}" >> fake-run.log
[ "$1" = start ] && { sleep 300 >/dev/null 2>&1 </dev/null & echo $! > supervisor.pid; }
FAKE
chmod +x "$GW/run.sh"
ENVF="$SB/secrets/mixin-gateway.env"
CLEAN=(env -i PATH="$PATH" HOME="$SB" MIXIN_ENV_FILE="$ENVF" ENSURE_SCOPE=dir)
FAKE_KS='{"app_id":"a b","session_private_key":"x$y`z","q":"it'"'"'s \"quoted\""}'

skip() { echo "SKIP $1"; }
if [ "$(cat /proc/1/comm 2>/dev/null)" = tini ]; then  # tini hosts only: never run install-systemd.sh on a systemd host
out=$("$HERE/deploy/install-systemd.sh" 2>&1); code=$?
echo "$out" | sed 's/^/    /'
[ $code = 3 ] && echo "$out" | grep -q "PID 1 = tini"; ok $? "install-systemd.sh: refuses on a tini host (PID 1 tini, no systemctl) exit 3"
[ ! -e /etc/systemd/system/mixin-gateway.service ]; ok $? "nothing installed in /etc/systemd/system"
else skip "install-systemd.sh test (not a tini host: PID 1 is $(cat /proc/1/comm 2>/dev/null))"; fi

"${CLEAN[@]}" MIXIN_KEYSTORE_JSON="$FAKE_KS" MIXIN_WEBHOOK_URL="https://fake.invalid/hook" MIXIN_WEBHOOK_KEY="fake-key" MIXIN_PAYLOAD_V2=1 "$GW/deploy/save-env.sh" > "$SB/save.out" 2>&1
[ "$(stat -c %a "$ENVF")" = 600 ] && [ "$(stat -c %a "$SB/secrets")" = 700 ]; ok $? "save-env.sh: file 0600, dir 0700"
! grep -q "fake-key\|fake.invalid\|session_private_key" "$SB/save.out"; ok $? "save-env.sh prints no values"
got=$(env -i bash -c "set -a; . '$ENVF'; printf '%s' \"\$MIXIN_KEYSTORE_JSON|\$MIXIN_PAYLOAD_V2\"")
[ "$got" = "$FAKE_KS|1" ]; ok $? "env file round-trips JSON with quotes/\$/backticks + flags"
"${CLEAN[@]}" "$GW/deploy/save-env.sh" >/dev/null 2>&1; [ $? != 0 ]; ok $? "save-env.sh refuses to overwrite without --force"

chmod 644 "$ENVF"
out=$("${CLEAN[@]}" "$GW/deploy/ensure-running.sh" --dry-run 2>&1)
echo "$out" | grep -q "would run: (cd $GW && npm ci" && echo "$out" | grep -q "would run: ./run.sh start" && [ ! -e "$GW/fake-run.log" ]; ok $? "dry run: plans npm ci + run.sh start, starts nothing"
[ "$(stat -c %a "$ENVF")" = 600 ] && echo "$out" | grep -q "mode was 644"; ok $? "env file perms re-applied (restore resets modes)"
echo "$out" | grep -q "MIXIN_KEYSTORE_JSON is set (value not shown)" && ! echo "$out" | grep -q "fake-key"; ok $? "dry run reports vars set, no values"

mkdir -p "$GW/context"; chmod 755 "$GW/context"
out=$("${CLEAN[@]}" "$GW/deploy/ensure-running.sh" 2>&1); echo "$out" | tail -3 | sed 's/^/    /'
[ -d "$GW/node_modules/pako" ] && grep -q "fake-run.sh start KS_SET=yes URL_SET=yes" "$GW/fake-run.log"; ok $? "node_modules missing -> npm ci, then run.sh start with env from file"
[ "$(stat -c %a "$GW/context")" = 700 ]; ok $? "private dirs reset to 0700"
out=$("${CLEAN[@]}" "$GW/deploy/ensure-running.sh" 2>&1); echo "$out" | sed "s/^/    2nd: /"
echo "$out" | grep -q "running (supervisor pid" && [ "$(grep -c start "$GW/fake-run.log")" = 1 ]; ok $? "idempotent: second call does nothing"
kill "$(cat "$GW/supervisor.pid")" 2>/dev/null
out=$(env -i PATH="$PATH" HOME="$SB" MIXIN_ENV_FILE="$SB/none.env" "$GW/deploy/start-gateway.sh" 2>&1); code=$?
[ $code = 78 ] && echo "$out" | grep -q "MIXIN_KEYSTORE_JSON is not set"; ok $? "start-gateway.sh without secrets -> exit 78 (no hot loop)"
# remote-gateway marker: ensure-running.sh and the real run.sh refuse to start a local gateway
touch "$GW/deploy/MIGRATED_TO_VPS"; n0=$(grep -c start "$GW/fake-run.log")
out=$("${CLEAN[@]}" "$GW/deploy/ensure-running.sh" 2>&1)
echo "$out" | grep -q "REFUSED: deploy/MIGRATED_TO_VPS exists" && [ "$(grep -c start "$GW/fake-run.log")" = "$n0" ]; ok $? "marker present: ensure-running.sh refuses, starts nothing"
cp "$HERE/run.sh" "$GW/run-real.sh"; out=$(cd "$GW" && env -i PATH="$PATH" ./run-real.sh start 2>&1); code=$?
[ $code = 3 ] && echo "$out" | grep -q REFUSED && [ ! -s "$GW/supervisor.out" ]; ok $? "marker present: run.sh start refuses (exit 3), no supervisor"
rm -f "$GW/deploy/MIGRATED_TO_VPS"; out=$("${CLEAN[@]}" "$GW/deploy/ensure-running.sh" --dry-run 2>&1)
echo "$out" | grep -q "would run: ./run.sh start"; ok $? "marker removed (rollback): ensure-running.sh would start again"
out=$("$HERE/deploy/ensure-running.sh" --dry-run 2>&1)  # real dir, host scope, DRY RUN: must not plan a second Blaze
if [ -f "$HERE/deploy/MIGRATED_TO_VPS" ]; then echo "$out" | grep -q "REFUSED"; ok $? "real dir has the marker: dry run refuses"
elif pgrep -fx 'node gateway.js' >/dev/null; then echo "$out" | grep -Eq "running \(supervisor pid|gateway running without supervisor"; ok $? "dry run against the live dir detects the running gateway (no second Blaze)"
else skip "real-dir dry run (no gateway on this host and no marker)"; fi
grep -q '^ExecStart=/opt/mixin-gateway/deploy/start-gateway.sh' "$HERE/deploy/mixin-gateway.service" && grep -q '^Restart=always' "$HERE/deploy/mixin-gateway.service" && grep -q '^RestartPreventExitStatus=78' "$HERE/deploy/mixin-gateway.service"; ok $? "unit file: ExecStart/Restart/RestartPreventExitStatus"
rm -rf "$SB"
echo "ops: $([ $fail = 0 ] && echo "ALL PASS ($pass)" || echo "SOME FAILED ($fail failed, $pass passed)")"; [ $fail = 0 ]
