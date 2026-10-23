'use strict';
// deploy/heartbeat-alert.js against a MOCK webhook (local http server), a fake `systemctl` on PATH and crafted gateway
// logs. Never posts to the real webhook (MIXIN_ALERT_URL = mock; clean env).
const fs = require('fs'); const path = require('path'); const os = require('os'); const { spawn } = require('child_process');
const { check, finish, uuid, tmpdir, httpServer } = require('./test-helpers');
const { uniqueConversationId } = require('./conversation-target');
const HERE = __dirname; const W = tmpdir('hb-alert-');
const BIN = path.join(W, 'bin'); fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'systemctl'), '#!/bin/sh\n[ "$1" = --user ] || exit 9\nif [ "$2" = show ]; then [ -n "$FAKE_ACTIVE_SINCE" ] || exit 9; echo "$FAKE_ACTIVE_SINCE"; exit 0; fi\n[ "$2" = is-active ] || exit 9\necho "${FAKE_SVC:-active}"\n[ "${FAKE_SVC:-active}" = active ] && exit 0 || exit 3\n', { mode: 0o755 });
const LOG = path.join(W, 'gateway.log'), STATE = path.join(W, 'run', 'alert-state.json');
const BOT = uuid(), OWNER = uuid(), KEY = 'fake-alert-key-123';
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const writeLog = (msAgo) => fs.writeFileSync(LOG, `[${iso(msAgo + 1000)}] gateway started\n[${iso(msAgo)}] heartbeat gen=1 open=true lastFrame=1s\n`);

(async () => {
  let status = 200; const hits = [];
  const srv = await httpServer((r) => { hits.push(r); return { status, json: { ok: status < 300 } }; });
  const run = (args = [], env = {}) => {
    const c = spawn(process.execPath, [path.join(HERE, 'deploy', 'heartbeat-alert.js'), ...args], { env: {
      PATH: `${BIN}:${process.env.PATH}`, HOME: W, MIXIN_GATEWAY_LOG: LOG, MIXIN_ALERT_STATE_FILE: STATE, MIXIN_ALERT_URL: `${srv.url}/hook`,
      MIXIN_WEBHOOK_KEY: KEY, MIXIN_KEYSTORE_JSON: JSON.stringify({ app_id: BOT, session_id: uuid(), session_private_key: 'ab'.repeat(32) }), MIXIN_ALERT_USER: OWNER,
      MIXIN_ALERT_HOST: 'vps-test', MIXIN_PAYLOAD_V2: '1', ...env } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    return new Promise((res) => c.on('close', (code) => res({ code, out })));
  };
  const body = (h) => JSON.parse(h.body.toString());

  writeLog(30000);
  { const r = await run(); check('fresh heartbeat + service active -> exit 0, nothing posted', r.code === 0 && hits.length === 0 && /ok service=active OK last heartbeat/.test(r.out), r.out); }
  writeLog(900000);
  { const r = await run(); const h = hits[0]; const b = h && body(h);
    check('stale heartbeat -> ONE POST, exit 1', r.code === 1 && hits.length === 1 && /ALERT sent kind=gateway_alert status=heartbeat_stale/.test(r.out), r.out);
    check('auth headers like gateway.js (Authorization: Bearer key, X-Webhook-Key: key), JSON body', h && h.headers.authorization === `Bearer ${KEY}` && h.headers['x-webhook-key'] === KEY && /json/.test(h.headers['content-type']));
    check('payload: base fields + kind:"gateway_alert" + gateway_alert{status,host,service,service_state,check,heartbeat_age_s,outage_id,outage_since,detected_at}', b && b.kind === 'gateway_alert' && b.category === 'SYSTEM_GATEWAY_ALERT' && b.original_category === 'SYSTEM_GATEWAY_ALERT' && b.encrypted === false && /^\[网关告警\]/.test(b.text) && b.display_text === b.text && /^[0-9a-f-]{36}$/.test(b.message_id) && b.user_id === OWNER && b.conversation_id === uniqueConversationId(BOT, OWNER) && b.gateway_alert.status === 'heartbeat_stale' && b.gateway_alert.host === 'vps-test' && b.gateway_alert.service === 'mixin-gateway.service' && b.gateway_alert.service_state === 'active' && b.gateway_alert.heartbeat_age_s >= 899 && /^STALE/.test(b.gateway_alert.check) && b.gateway_alert.outage_id && b.gateway_alert.outage_since && b.gateway_alert.bot_id === BOT, b);
    check('state file 0600 with alerted_at', (fs.statSync(STATE).mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(STATE, 'utf8')).alerted_at);
    check('stdout never shows the key or the URL', !r.out.includes(KEY) && !r.out.includes(srv.url)); }
  let firstId = body(hits[0]).message_id;
  { const r = await run(); check('same outage, next run -> no second POST (alert once per outage)', r.code === 1 && hits.length === 1 && /already alerted/.test(r.out), r.out); }
  { const r = await run([], { FAKE_SVC: 'inactive' }); check('service goes inactive during the same outage -> still no second POST', r.code === 1 && hits.length === 1); }
  writeLog(10000);
  { const r = await run(); check('recovery -> state cleared, nothing posted, exit 0', r.code === 0 && hits.length === 1 && !fs.existsSync(STATE) && /recovered outage=/.test(r.out), r.out); }
  { const r = await run([], { FAKE_SVC: 'failed' }); const b = hits[1] && body(hits[1]);
    check('new outage (service failed, heartbeat still fresh) -> new POST status=service_inactive, new message_id', r.code === 1 && hits.length === 2 && b.gateway_alert.status === 'service_inactive' && b.gateway_alert.service_state === 'failed' && b.message_id !== firstId && /服务未运行/.test(b.text), r.out); }
  await run(); fs.rmSync(STATE, { force: true });
  writeLog(900000); status = 500;
  { const r = await run(); check('webhook 500 -> exit 2, not marked alerted (retried next run)', r.code === 2 && hits.length === 3 && !JSON.parse(fs.readFileSync(STATE, 'utf8')).alerted_at && /delivery FAILED/.test(r.out), r.out); }
  status = 200;
  { const r = await run(); const a = body(hits[2]), b = body(hits[3]);
    check('next run after a failed POST -> delivered, same outage id/message_id (dedupe-able)', r.code === 1 && hits.length === 4 && a.message_id === b.message_id, r.out); }
  fs.rmSync(STATE, { force: true });
  { const n = hits.length; const r = await run(['--dry-run']);
    check('--dry-run: prints the payload, POSTs nothing, writes no state', r.code === 1 && hits.length === n && !fs.existsSync(STATE) && /"kind": "gateway_alert"/.test(r.out) && !r.out.includes(KEY), r.out.slice(0, 300)); }
  { const r = await run([], { MIXIN_ALERT_SERVICE: '' }); check('MIXIN_ALERT_SERVICE="" skips the systemctl check (heartbeat only)', r.code === 1 && body(hits[hits.length - 1]).gateway_alert.service_state === 'skipped'); }
  fs.rmSync(STATE, { force: true });
  { const sd = (sAgo) => require('child_process').execFileSync('date', ['-d', `@${Math.floor(Date.now() / 1000) - sAgo}`, '+%a %Y-%m-%d %H:%M:%S %Z'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(LOG, `[${iso(30000)}] gateway started\n`); const n = hits.length;
    let r = await run([], { FAKE_ACTIVE_SINCE: sd(60) });
    check('startup grace: service active 60s, no heartbeat yet -> "starting", exit 0, nothing posted, no state', r.code === 0 && hits.length === n && !fs.existsSync(STATE) && /starting service=active active_for=\d+s/.test(r.out), r.out);
    r = await run([], { FAKE_ACTIVE_SINCE: sd(1000) });
    check('past the grace (active 1000s, still no heartbeat) -> heartbeat_stale POST', r.code === 1 && hits.length === n + 1 && body(hits[hits.length - 1]).gateway_alert.status === 'heartbeat_stale', r.out);
    r = await run([], { FAKE_ACTIVE_SINCE: sd(30) });
    check('restart inside an alerted outage -> "starting", outage state kept (no duplicate alert later)', r.code === 0 && hits.length === n + 1 && fs.existsSync(STATE), r.out);
    fs.rmSync(STATE, { force: true }); }
  { // 2026-10-19: gateway auth circuit open (run/auth-alert-state.json): the gateway already alerted -> no POST here
    const AUTH = path.join(W, 'run', 'auth-alert-state.json'); fs.mkdirSync(path.dirname(AUTH), { recursive: true });
    fs.writeFileSync(AUTH, JSON.stringify({ outage_id: uuid(), since: iso(60000), status: 'auth_failed', alerted_at: iso(50000) })); fs.rmSync(STATE, { force: true });
    writeLog(30000); const n = hits.length;
    let r = await run([], { MIXIN_AUTH_STATE_FILE: AUTH });
    check('auth paused + fresh heartbeat -> exit 1, "auth_failed paused", nothing posted, no own outage state', r.code === 1 && hits.length === n && /auth_failed paused outage=/.test(r.out) && !fs.existsSync(STATE), r.out);
    writeLog(900000); r = await run([], { MIXIN_AUTH_STATE_FILE: AUTH });
    check('auth paused + stale heartbeat -> still no POST (no duplicate of the gateway alert)', r.code === 1 && hits.length === n && !fs.existsSync(STATE), r.out);
    r = await run([], { MIXIN_AUTH_STATE_FILE: AUTH, FAKE_SVC: 'inactive' });
    check('auth state but service inactive -> normal service_inactive alert', r.code === 1 && hits.length === n + 1 && body(hits[n]).gateway_alert.status === 'service_inactive', r.out);
    fs.rmSync(AUTH, { force: true }); fs.rmSync(STATE, { force: true }); }
  { const r = await run([], { MIXIN_ALERT_URL: '', MIXIN_WEBHOOK_URL: '' }); check('no webhook URL -> exit 78 (config error)', r.code === 78, r.out); }
  await srv.close(); fs.rmSync(W, { recursive: true, force: true });
  finish('heartbeat-alert');
})().catch((e) => { console.error('FAIL crash', e); process.exit(1); });
