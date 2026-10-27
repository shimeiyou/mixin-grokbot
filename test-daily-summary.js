'use strict';
// deploy/daily-summary.js against crafted logs, a fake `systemctl`/`pgrep`/`ps` on PATH and temp dirs (no network).
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const { check, finish, tmpdir, uuid } = require('./test-helpers');
const HERE = __dirname; const W = tmpdir('daily-'); const BIN = path.join(W, 'bin'); fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'systemctl'), `#!/bin/sh
[ "$1" = --user ] || exit 9
case "$2" in
  is-active) case "$3" in *timer) echo "\${FAKE_TIMER:-active}";; *) echo "\${FAKE_SVC:-active}";; esac; [ "\${FAKE_SVC:-active}" = active ] || exit 3;;
  show) case "$4" in NRestarts) echo 2;; ActiveEnterTimestamp) echo "$FAKE_SINCE";; MemoryCurrent) echo 83886080;; esac;;
  *) exit 9;; esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'pgrep'), '#!/bin/sh\n[ -n "$FAKE_PID" ] && echo "$FAKE_PID" || exit 1\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'ps'), '#!/bin/sh\necho "  ${FAKE_RSS:-75000}"\n', { mode: 0o755 });
const NOW = Date.parse('2026-10-19T12:15:00Z'); // 20:15 CST
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 3600e3, M = 60e3;
const RUN = path.join(W, 'run'), Q = path.join(W, 'queue'), LOG = path.join(W, 'gateway.log'), ALOG = path.join(W, 'alert.log');
fs.mkdirSync(path.join(Q, 'dead'), { recursive: true }); fs.mkdirSync(path.join(RUN, 'daily'), { recursive: true });
const L = (ago, s) => `[${iso(ago)}] ${s}`;
const base = [
  L(30 * H, 'gateway started bot=x'), L(30 * H - 1000, 'blaze connected gen=1'),           // outside the window
  L(26 * H, 'webhook ok msg=old status=200 via=queue attempt=1'),
  L(20 * H, 'shutdown SIGTERM'), L(20 * H - 2000, 'gateway started bot=x'), L(20 * H - 1900, 'blaze connected gen=1'), // clean restart
  L(10 * H, 'recv msg=a conv=c cat=PLAIN_TEXT'), L(10 * H - 1, 'recv msg=b conv=c cat=PLAIN_TEXT'), L(10 * H - 2, 'webhook coalesce hold msg=b group=a n=2'),
  L(10 * H - 3, 'webhook filtered msg=p cat=MESSAGE_PIN reason=category'), L(10 * H - 4, 'webhook ok msg=b status=200 via=queue attempt=1 merged=2 group=a'),
  L(9 * H, 'webhook ok msg=s status=200 via=queue attempt=1'), L(9 * H - 1, 'webhook retryable status=503 msg=s2 attempt=1 via=queue'), L(9 * H - 2, 'webhook ok msg=s2 status=200 via=queue attempt=2'),
  L(8 * H, 'webhook dedupe skip msg=b (already delivered)'), L(8 * H - 1, 'blocked user=u conv=c'),
  L(5 * H, 'blaze recreate in 0ms (gen=1 periodic recycle)'), L(5 * H - 1, 'blaze closed gen=1 code=1006 msgs=0'), L(5 * H - 2, 'blaze connected gen=2'),
  L(4 * H, 'WARN seen save failed x'), L(3 * H, 'gateway reconnected after outage offline_ms=33026 since=x reason=no server ping gen=2'), L(3 * M, 'heartbeat gen=2 open=true lastFrame=1s'),
];
const run = (env = {}, args = []) => spawnSync(process.execPath, [path.join(HERE, 'deploy', 'daily-summary.js'), ...args], { encoding: 'utf8',
  env: { PATH: `${BIN}:${process.env.PATH}`, HOME: W, MIXIN_GATEWAY_LOG: LOG, MIXIN_ALERT_LOG: ALOG, MIXIN_SUMMARY_DIR: RUN, MIXIN_QUEUE_DIR: Q, MIXIN_SUMMARY_NOW: new Date(NOW).toISOString(), MIXIN_ALERT_HOST: 'vps-test',
    FAKE_PID: '4242', FAKE_SINCE: 'Mon 2026-10-19 00:15:00 UTC', HEARTBEAT_MAX_AGE_S: String(10 ** 9), ...env } });
// check-heartbeat.sh compares with the REAL clock: give it a heartbeat age that is fresh "now"
const withHb = (lines, ago = 60e3) => lines.concat(`[${new Date(Date.now() - ago).toISOString()}] heartbeat gen=2 open=true lastFrame=1s`).join('\n') + '\n';

fs.writeFileSync(LOG, withHb(base)); fs.writeFileSync(ALOG, L(2 * H, 'heartbeat-alert ok service=active') + '\n');
fs.writeFileSync(path.join(RUN, 'daily', 'daily-summary-2026-10-01.txt'), 'old'); fs.writeFileSync(path.join(RUN, 'daily', 'daily-summary-2026-10-15.txt'), 'recent');
let r = run(); const out = r.stdout; const last = out.trim().split('\n').pop();
check('healthy -> exit 0, last line exactly "OK"', r.status === 0 && last === 'OK', { st: r.status, last, err: r.stderr });
check('service line: state, uptime, NRestarts, pid, RSS, MemoryCurrent', /service: active \| uptime 0d 12h 0m .* NRestarts 2 \| pid 4242 \| RSS 73MB \| MemoryCurrent 80MB/.test(out), out.split('\n')[1]);
check('process line: 1 start in 24h (clean), connects/closes/recycles + brief 33s outage visible without ALERT', /process: starts 1 \(unclean 0\) \| blaze connects 2 closes 1 periodic recycles 1 other reconnects 0 \| outages>threshold 1 \(max 33s\)/.test(out), out.split('\n')[3]);
check('webhook stats: pushed 3, merged 1 webhook / 2 msgs, holds 1, filtered 1, dedupe 1, retried 1, failed 0', /webhooks: pushed 3 \| merged webhooks 1 carrying 2 msgs \| coalesce holds 1 \| filtered 1 \| recalled-before-push 0 \| dedupe skips 1 \| retried 1 \| failed 0 \| queue pending 0/.test(out), out.split('\n')[6]);
check('inbound + errors lines', /inbound: received 2 \| blocked \(not allowlisted\) 1/.test(out) && /errors: WARN 1 /.test(out));
check('heartbeat line: fresh, timer active, no outage, no auth pause', /heartbeat: fresh age \d+s \| heartbeat timer active \| open outage no \| auth paused no/.test(out));
check('first line: host + 20:15 CST window', /host vps-test — generated 2026-10-19 20:15:00 CST/.test(out));
const f = path.join(RUN, 'daily-summary.txt'), fd = path.join(RUN, 'daily', 'daily-summary-2026-10-19.txt');
check('writes run/daily-summary.txt + dated copy (0600), identical', fs.readFileSync(f, 'utf8') === out && fs.readFileSync(fd, 'utf8') === out && (fs.statSync(f).mode & 0o777) === 0o600);
check('dated copies older than 7 days pruned, recent kept', !fs.existsSync(path.join(RUN, 'daily', 'daily-summary-2026-10-01.txt')) && fs.existsSync(path.join(RUN, 'daily', 'daily-summary-2026-10-15.txt')));
check('no message ids/bodies or URLs echoed (counts only)', !/msg=|conv=|http/.test(out));
// problems
const bad = base.concat([L(2 * H, 'gateway started bot=x'), L(90 * M, 'webhook GAVE UP msg=z via=queue attempts=50'), L(80 * M, 'gateway reconnected after outage offline_ms=135000 since=x reason=restart gen=1'),
  L(70 * M, 'ALERT submitted kind=gateway_alert status=auth_failed outage=o msg=m failures=3'), L(70 * M, 'AUTH circuit open: 3 consecutive auth failures'), L(60 * M, 'unhandledRejection boom')]);
fs.writeFileSync(LOG, withHb(bad)); fs.writeFileSync(ALOG, L(H, 'heartbeat-alert ALERT sent kind=gateway_alert status=heartbeat_stale outage=o msg=m http=200') + '\n');
fs.writeFileSync(path.join(RUN, 'auth-alert-state.json'), '{}'); fs.writeFileSync(path.join(RUN, 'alert-state.json'), '{}');
for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(Q, `${uuid()}.json`), '{}');
r = run({ FAKE_SVC: 'failed', FAKE_TIMER: 'inactive', FAKE_RSS: '300000' }); const l2 = r.stdout.trim().split('\n').pop();
const want = ['service mixin-gateway.service is failed', 'heartbeat timer is inactive', 'open heartbeat outage', 'auth circuit open', '1 unclean restart(s)', '1 FATAL/unhandledRejection', '1 webhook(s) failed', 'webhook queue backlog 25', 'RSS 293MB', '2 gateway_alert(s) sent', '2 outage(s) > threshold (max 135s)'];
check('problems -> exit 1, last line "ALERT: <reasons>" with every reason', r.status === 1 && l2.startsWith('ALERT: ') && want.every((x) => l2.includes(x)), { l2, missing: want.filter((x) => !l2.includes(x)) });
check('alerts line counts heartbeat + auth_failed alerts', /alerts: heartbeat gateway_alert sent 1 \(delivery failures 0\) \| auth_failed alerts 1/.test(r.stdout));
fs.writeFileSync(LOG, withHb(base, 3600e3)); fs.writeFileSync(ALOG, ''); fs.rmSync(path.join(RUN, 'auth-alert-state.json')); fs.rmSync(path.join(RUN, 'alert-state.json')); for (const x of fs.readdirSync(Q)) if (x.endsWith('.json')) fs.rmSync(path.join(Q, x));
r = run({ HEARTBEAT_MAX_AGE_S: '600' });
check('stale heartbeat alone -> ALERT: heartbeat stale', r.status === 1 && /^ALERT: heartbeat stale \(\d+s\)$/.test(r.stdout.trim().split('\n').pop()), r.stdout.trim().split('\n').pop());
r = run({}, ['--stdout']); check('--stdout prints without writing a new dated copy', r.stdout.includes('Mixin gateway daily summary'));
fs.rmSync(W, { recursive: true, force: true });
finish('daily-summary');
