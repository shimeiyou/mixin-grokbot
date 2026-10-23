'use strict';
// 2026-10-19: (1) auth circuit breaker in blaze-conn.js, (2) outage tracking -> additive offline_ms/gateway_status on
// inbound payloads (gateway-status.js), (3) gateway_alert status:"auth_failed" once per outage, (4) gateway.js end to
// end against fake Blaze + fake webhook. Offline only (local fake servers, fake keystore, clean env).
require('./ws-shim');
const fs = require('fs'); const path = require('path'); const net = require('net');
const pako = require('pako');
const WS = require(require.resolve('ws', { paths: [require.resolve('@mixin.dev/mixin-node-sdk')] }));
const { createBlazeConn } = require('./blaze-conn');
const GS = require('./gateway-status');
const H = require('./test-helpers');
const { check, finish, uuid, fakeKeystore, ksJson, tmpdir, waitFor, sleep, fakeBlaze, blazeMsg, httpServer, fakeMixinApi, runNode } = H;
const HERE = __dirname; const W = tmpdir('gw-status-');
const ks = fakeKeystore();
const z = (o) => Buffer.from(pako.gzip(JSON.stringify(o)));

// Fake Blaze whose behaviour per connection is scripted: 'auth' = Mixin's real reply to a bad token (ERROR 401 frame,
// then close), 'http401' = upgrade refused with HTTP 401, 'ok' = normal (answers every request by id).
function scripted(script) {
  const st = { conns: 0, modes: [] };
  return new Promise((res) => {
    const srv = new WS.Server({ port: 0, verifyClient: (info, cb) => { const m = script(st.conns + 1); if (m === 'http401') { st.conns++; st.modes.push(m); return cb(false, 401, 'Unauthorized'); } cb(true); } }, () => res({ st, url: `ws://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { for (const c of srv.clients) c.terminate(); srv.close(() => r()); }) }));
    srv.on('connection', (s) => {
      st.conns++; const m = script(st.conns); st.modes.push(m);
      if (m === 'auth') { s.send(z({ id: '00000000-0000-0000-0000-000000000000', action: 'ERROR', error: { status: 202, code: 401, description: 'Unauthorized, maybe invalid token.' } })); setTimeout(() => s.terminate(), 20); return; }
      const pi = setInterval(() => { try { s.ping(); } catch (_) {} }, 200); s.on('close', () => clearInterval(pi));
      s.on('message', (d) => { const q = JSON.parse(pako.ungzip(d, { to: 'string' })); s.send(z({ id: q.id, action: q.action })); });
    });
  });
}
async function refusedUrl() { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return `ws://127.0.0.1:${p}`; }
function mk(url, extra = {}) {
  const logs = [], ev = { failed: [], ok: 0, rec: [], dead: 0 };
  const b = createBlazeConn({ keystore: ks, url, log: (...a) => { logs.push(a.join(' ')); if (process.env.V) console.log(...a); }, onDead: () => { ev.dead++; }, handler: { onMessage: () => {} },
    tickMs: 50, checkMs: 500, backoffBaseMs: 40, backoffMaxMs: 80, onAuthFailed: (i) => ev.failed.push(i), onAuthOk: () => { ev.ok++; }, onReconnect: (i) => ev.rec.push(i), ...extra });
  return { b, logs, ev };
}

(async () => {
  // ---------- 1) auth circuit breaker (blaze-conn) ----------
  { const s = await scripted(() => 'auth'); const t = mk(s.url, { deadMs: 1500, heartbeatMs: 300 });
    t.b.start(); await sleep(3500);
    check('401 ERROR frame x3 -> paused after exactly 3 connections', t.b.paused() && s.st.conns === 3 && t.b.authFailures() === 3, { conns: s.st.conns, f: t.b.authFailures() });
    check('onAuthFailed called once with {failures:3,last_error,since}', t.ev.failed.length === 1 && t.ev.failed[0].failures === 3 && /401/.test(t.ev.failed[0].last_error) && Number.isFinite(t.ev.failed[0].since));
    check('paused: no deadMs exit even after > deadMs without an OPEN socket (systemd would restart-loop)', t.ev.dead === 0);
    check('paused: heartbeat keeps being logged with paused=auth_failed', t.logs.some((l) => /^heartbeat gen=- open=false paused=auth_failed auth_failures=3/.test(l)));
    check('log: AUTH circuit open line + auth failure 1/3..3/3', t.logs.some((l) => /AUTH circuit open: 3 consecutive auth failures/.test(l)) && t.logs.filter((l) => /blaze auth failure \d\/3/.test(l)).length === 3);
    t.b._shiftClock(60000); t.b._tick(); await sleep(300);
    check('paused: a tick gap (VM resume) does not reconnect', s.st.conns === 3 && t.b.paused());
    const t0 = Date.now(); let code = null; try { await t.b.send('CREATE_MESSAGE', {}, { waitOpenMs: 5000 }); } catch (e) { code = e.code; }
    check('paused: send() fails NOT_CONNECTED at once (reply.js -> ENDPOINT_UNAVAILABLE)', code === 'NOT_CONNECTED' && Date.now() - t0 < 500);
    check('no onReconnect / onAuthOk while failing', t.ev.rec.length === 0 && t.ev.ok === 0);
    t.b.stop(); await s.close(); }
  { const s = await scripted((n) => (n <= 2 ? 'auth' : 'ok')); const t = mk(s.url);
    t.b.start(); await sleep(1200);
    check('2 auth failures then success -> not paused, counter reset, onAuthOk called', !t.b.paused() && t.b.authFailures() === 0 && t.ev.ok >= 1 && t.ev.failed.length === 0 && t.logs.some((l) => /auth failure counter 2 reset/.test(l)));
    t.b.stop(); await s.close(); }
  { const s = await scripted((n) => (n % 2 ? 'auth' : 'ok')); const t = mk(s.url, { recycleMs: 150 });
    t.b.start(); await sleep(2500);
    check('alternating auth fail / success (non-consecutive) -> never paused', !t.b.paused() && s.st.conns >= 4 && t.ev.failed.length === 0, { conns: s.st.conns }); t.b.stop(); await s.close(); }
  { const t = mk(await refusedUrl(), { deadMs: 600000 });
    t.b.start(); await sleep(1200);
    check('network errors (connection refused) do not count as auth failures; jittered backoff keeps retrying', !t.b.paused() && t.b.authFailures() === 0 && t.logs.filter((l) => /blaze recreate in/.test(l)).length >= 5);
    t.b.stop(); }
  { const s = await scripted(() => 'http401'); const t = mk(s.url, { authFailLimit: 2 });
    t.b.start(); await sleep(1500);
    check('HTTP 401 on the upgrade counts too (authFailLimit 2 -> paused after 2)', t.b.paused() && s.st.conns === 2 && t.ev.failed.length === 1 && /HTTP 401/.test(t.ev.failed[0].last_error), { conns: s.st.conns, l: t.logs.slice(-4) });
    t.b.stop(); await s.close(); }
  { const s = await scripted(() => 'ok'); const t = mk(s.url, { keystore: { ...ks, session_private_key: 12345 } });
    t.b.start(); await sleep(800);
    check('invalid keystore (JWT signing throws) counts as an auth failure -> paused, no connection made', t.b.paused() && s.st.conns === 0 && /invalid keystore/.test(t.ev.failed[0] && t.ev.failed[0].last_error), t.logs.slice(-3));
    t.b.stop(); await s.close(); }
  { const s = await scripted(() => 'auth'); const t = mk(s.url, { authFailLimit: 0 });
    t.b.start(); await sleep(900);
    check('authFailLimit 0 disables the breaker (old behaviour: keeps reconnecting)', !t.b.paused() && s.st.conns >= 4); t.b.stop(); await s.close(); }

  // ---------- 2) outage tracking (blaze-conn onReconnect) ----------
  { const s = await scripted(() => 'ok'); const t = mk(s.url, { recycleMs: 300 });
    t.b.start(); await sleep(1100);
    const r = t.ev.rec.filter((x) => x.reason === 'periodic recycle');
    check('periodic recycle -> onReconnect with a tiny offline_ms (well below 30s threshold)', r.length >= 2 && r.every((x) => x.offline_ms < 1000), t.ev.rec);
    check('first connect without initialDownSince -> no onReconnect for the start', !t.ev.rec.some((x) => x.reason === 'restart')); t.b.stop(); await s.close(); }
  { const s = await scripted(() => 'ok'); const since = Date.now() - 45000; const t = mk(s.url, { initialDownSince: since });
    t.b.start(); await sleep(500);
    const r = t.ev.rec[0];
    check('initialDownSince (last-alive of the previous process) -> onReconnect reason=restart, offline_ms ~45s', r && r.reason === 'restart' && r.offline_ms >= 45000 && r.offline_ms < 47000 && r.since === since, r); t.b.stop(); await s.close(); }
  { const s = await scripted(() => 'ok'); const t = mk(s.url);
    t.b.start(); await sleep(400); t.b._shiftClock(40000); t.b._tick(); await sleep(400);
    const r = t.ev.rec.find((x) => x.reason === 'resume after suspend');
    check('tick gap 40s (VM frozen) -> onReconnect reason="resume after suspend", offline_ms >= 40s', r && r.offline_ms >= 40000 && r.offline_ms < 42000, t.ev.rec); t.b.stop(); await s.close(); }
  { let up = true; const s = await scripted((n) => 'ok'); const t = mk(s.url, { deadMs: 600000 });
    t.b.start(); await sleep(300); await s.close(); up = false; // server gone: reconnects fail with ECONNREFUSED
    await sleep(800); const before = t.ev.rec.length;
    const s2 = new WS.Server({ port: Number(new URL(s.url).port) }); s2.on('connection', (c) => { c.on('message', (d) => { const q = JSON.parse(pako.ungzip(d, { to: 'string' })); c.send(z({ id: q.id, action: q.action })); }); });
    await waitFor(() => t.ev.rec.length > before, 5000);
    const r = t.ev.rec[t.ev.rec.length - 1];
    check('server down ~0.8s then back -> one onReconnect with offline_ms covering the whole outage (incl. failed retries)', r && r.offline_ms >= 800 && r.offline_ms < 5000, r);
    t.b.stop(); await new Promise((x) => s2.close(x)); }

  // ---------- 3) gateway-status.js units ----------
  { const logs = []; const m = GS.createOutageMarker({ log: (l) => logs.push(l), thresholdMs: 30000, windowMs: 600000 });
    const now = Date.now();
    check('marker: 200ms recycle ignored', m.mark({ offline_ms: 200, since: now - 200, at: now, reason: 'periodic recycle' }) === false && m._last() === null && logs.length === 0);
    check('marker: exactly the threshold ignored, above it marked', m.mark({ offline_ms: 30000, since: now - 30000, at: now }) === false && m.mark({ offline_ms: 95000.4, since: now - 95000, at: now, reason: 'close 1006', gen: 7 }) === true);
    check('marker: one log line (no content)', logs.length === 1 && /gateway reconnected after outage offline_ms=95000 since=\S+ reason=close 1006 gen=7/.test(logs[0]), logs);
    const backlog = { created_at: new Date(now - 60000).toISOString() }; m.annotate(backlog, now + 1000);
    check('annotate backlog message: top-level offline_ms (int) + gateway_status{offline_ms,offline_since,reconnected_at,reason}', backlog.offline_ms === 95000 && backlog.gateway_status.offline_ms === 95000 && backlog.gateway_status.reconnected_at === new Date(now).toISOString() && backlog.gateway_status.offline_since === new Date(now - 95000).toISOString() && backlog.gateway_status.reason === 'close 1006', backlog);
    const fresh = { created_at: new Date(now + 5000).toISOString() }; m.annotate(fresh, now + 6000);
    check('message written after the reconnect -> not annotated', !('offline_ms' in fresh) && !('gateway_status' in fresh));
    const late = { created_at: new Date(now - 1000).toISOString() }; m.annotate(late, now + 600001);
    check('outside the annotate window -> not annotated', !('offline_ms' in late));
    const noTs = { created_at: 'x' }; m.annotate(noTs, now + 10);
    check('unparseable created_at inside the window -> annotated', noTs.offline_ms === 95000); }
  { const f = path.join(W, 'alive.json'); GS.writeJson(f, { t: Date.now() - 5000 });
    check('readAlive: recent stamp returned, file 0600', Math.abs(GS.readAlive(f) - (Date.now() - 5000)) < 50 && (fs.statSync(f).mode & 0o777) === 0o600);
    GS.writeJson(f, { t: Date.now() - 8 * 86400e3 }); check('readAlive: >7 days old -> null', GS.readAlive(f) === null);
    check('readAlive: missing/garbage -> null', GS.readAlive(path.join(W, 'nope.json')) === null && (fs.writeFileSync(f, '{x'), GS.readAlive(f) === null)); }
  { const subs = [], logs = []; const sf = path.join(W, 'run', 'auth-alert-state.json'); const BOT = uuid(), OWNER = uuid();
    const a = GS.createAuthAlert({ log: (l) => logs.push(l), submit: (p) => subs.push(p), stateFile: sf, botId: BOT, v2: true, env: { MIXIN_ALERT_USER: OWNER, MIXIN_ALERT_HOST: 'vps-test' } });
    const p = a.onFailed({ failures: 3, last_error: 'blaze ERROR error code=401', since: Date.now() - 4000 });
    const g = p.gateway_alert;
    check('auth alert: base fields like heartbeat-alert + kind gateway_alert + category SYSTEM_GATEWAY_ALERT', p.kind === 'gateway_alert' && p.category === 'SYSTEM_GATEWAY_ALERT' && p.original_category === 'SYSTEM_GATEWAY_ALERT' && p.encrypted === false && p.user_id === OWNER && p.conversation_id === require('./conversation-target').uniqueConversationId(BOT, OWNER) && p.display_text === p.text && /鉴权失败/.test(p.text));
    check('auth alert: gateway_alert{status:auth_failed, host, service, service_state, check, heartbeat_age_s, outage_id, outage_since, detected_at, bot_id, effect, runbook, auth_failures, last_error, resume}', g.status === 'auth_failed' && g.host === 'vps-test' && g.service === 'mixin-gateway.service' && g.service_state === 'active' && g.heartbeat_age_s === null && g.bot_id === BOT && g.auth_failures === 3 && /401/.test(g.last_error) && /restart/.test(g.resume) && g.outage_id && g.outage_since && g.detected_at && g.effect && g.runbook && g.check);
    check('auth alert: message_id = UUIDv5("gateway-alert:<outage_id>") (same scheme as heartbeat alerts)', p.message_id === require('uuid').v5(`gateway-alert:${g.outage_id}`, '6ba7b811-9dad-11d1-80b4-00c04fd430c8'));
    check('auth alert: submitted once, state file 0600', subs.length === 1 && (fs.statSync(sf).mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(sf, 'utf8')).outage_id === g.outage_id);
    const b = GS.createAuthAlert({ log: (l) => logs.push(l), submit: (x) => subs.push(x), stateFile: sf, botId: BOT, env: {} });
    check('same outage after a restart (state file present) -> NOT submitted again', b.onFailed({ failures: 3 }) === null && subs.length === 1 && logs.some((l) => /already submitted/.test(l)));
    b.onOk(); check('auth ok -> state cleared + logged; next failure is a new outage', !fs.existsSync(sf) && logs.some((l) => /auth recovered outage=/.test(l)) && b.onFailed({ failures: 3 }) && subs.length === 2 && subs[1].message_id !== subs[0].message_id);
    check('auth alert log lines carry no payload text', logs.every((l) => !l.includes('鉴权'))); }

  // ---------- 4) gateway.js end to end ----------
  const U = uuid(), C = uuid();
  async function gw({ dir, blazeUrl, extraEnv = {} }) {
    fs.mkdirSync(path.join(dir, 'run'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'allow.json'), JSON.stringify([U]));
    const hooks = []; const hook = await httpServer((r) => { if (r.method === 'POST') { hooks.push(JSON.parse(r.body)); return { status: 200, body: '' }; } });
    const api = await fakeMixinApi({});
    const env = { MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_WEBHOOK_URL: hook.url + '/hook', MIXIN_WEBHOOK_KEY: 'k', MIXIN_ALLOWLIST_FILE: path.join(dir, 'allow.json'), MIXIN_SEEN_FILE: path.join(dir, 'seen.json'),
      MIXIN_GATEWAY_LOG: path.join(dir, 'gateway.log'), MIXIN_QUEUE_DIR: path.join(dir, 'queue'), MIXIN_SEND_SOCKET: path.join(dir, 'run', 'send.sock'), MIXIN_API_BASE: api.url, MIXIN_BLAZE_URL: blazeUrl,
      MIXIN_CONV_CACHE_FILE: path.join(dir, 'cc.json'), MIXIN_MEMBER_ALERT_STATE_FILE: path.join(dir, 'ma.json'), MIXIN_PAYLOAD_V2: '1', MIXIN_ALERT_USER: U, MIXIN_ALERT_HOST: 'e2e', MIXIN_ALIVE_STAMP_MS: '200', MIXIN_WEBHOOK_COALESCE_MS: '0',
      HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', ...extraEnv };
    const p = runNode(['gateway.js'], { env, cwd: HERE, timeoutMs: 60000 });
    return { p, hooks, hook, api, dir, log: () => { try { return fs.readFileSync(env.MIXIN_GATEWAY_LOG, 'utf8'); } catch (_) { return ''; } } };
  }
  const stop = async (g) => { g.p.child.kill('SIGTERM'); const r = await g.p.done; await g.hook.close(); await g.api.close(); return r; };
  { const s = await scripted(() => 'auth'); const g = await gw({ dir: path.join(W, 'e2e-auth'), blazeUrl: s.url });
    await waitFor(() => g.hooks.length >= 1, 20000); await sleep(1500);
    const a = g.hooks[0];
    check('e2e: 3 x 401 -> exactly one webhook kind=gateway_alert status=auth_failed (via the queue)', g.hooks.length === 1 && a.kind === 'gateway_alert' && a.gateway_alert.status === 'auth_failed' && a.gateway_alert.auth_failures === 3 && /via=queue/.test(g.log()), { n: g.hooks.length, a });
    check('e2e: stopped reconnecting (3 connections), process still alive', s.st.conns === 3 && g.p.child.exitCode === null);
    check('e2e: run/auth-alert-state.json written (0600)', (fs.statSync(path.join(g.dir, 'run', 'auth-alert-state.json')).mode & 0o777) === 0o600);
    check('e2e: gateway.log never contains the keystore secret', !g.log().includes(ks.session_private_key));
    const r = await stop(g); check('e2e: SIGTERM while paused -> clean exit 0', r.code === 0, r);
    // restart with credentials still bad: same outage -> no second alert
    const off = fs.statSync(path.join(W, 'e2e-auth', 'gateway.log')).size;
    const g2 = await gw({ dir: path.join(W, 'e2e-auth'), blazeUrl: s.url });
    await waitFor(() => /AUTH circuit open/.test(g2.log().slice(off)), 20000); await sleep(1500);
    check('e2e: restart, still failing -> paused again, NO second alert (once per outage)', g2.hooks.length === 0 && /auth alert already submitted/.test(g2.log().slice(off)), { n: g2.hooks.length });
    await stop(g2); await s.close();
    // credentials fixed -> resumes on restart, state cleared
    const ok = await scripted(() => 'ok'); const g3 = await gw({ dir: path.join(W, 'e2e-auth'), blazeUrl: ok.url });
    await waitFor(() => !fs.existsSync(path.join(g3.dir, 'run', 'auth-alert-state.json')), 15000);
    check('e2e: fixed creds + restart -> connected, auth state cleared ("auth recovered")', /auth recovered outage=/.test(g3.log()) && /blaze connected/.test(g3.log()));
    await stop(g3); await ok.close(); }
  { const dir = path.join(W, 'e2e-off'); fs.mkdirSync(path.join(dir, 'run'), { recursive: true, mode: 0o700 });
    GS.writeJson(path.join(dir, 'run', 'gateway-alive.json'), { t: Date.now() - 90000 }); // previous process last had Blaze open 90s ago
    const bz = await fakeBlaze(); const m1 = blazeMsg({ category: 'PLAIN_TEXT', data: 'x', user_id: U, conversation_id: C, created_at: new Date(Date.now() - 60000).toISOString() });
    bz.add([m1]);
    const g = await gw({ dir, blazeUrl: bz.url });
    await waitFor(() => g.hooks.length >= 1, 20000);
    const h = g.hooks[0];
    check('e2e: restart after 90s away -> backlog payload has top-level offline_ms (int, ~90s) + gateway_status{reason:"restart"}', h && Number.isInteger(h.offline_ms) && h.offline_ms >= 90000 && h.offline_ms < 100000 && h.gateway_status.offline_ms === h.offline_ms && h.gateway_status.reason === 'restart' && h.gateway_status.reconnected_at && h.gateway_status.offline_since, h);
    check('e2e: all old fields still there, no kind field', h.message_id === m1.message_id && h.conversation_id === C && h.category === 'PLAIN_TEXT' && !('kind' in h) && 'display_text' in h);
    await sleep(600);
    check('e2e: last-alive stamp refreshed while connected', Date.now() - JSON.parse(fs.readFileSync(path.join(dir, 'run', 'gateway-alive.json'), 'utf8')).t < 2000);
    const m2 = blazeMsg({ category: 'PLAIN_TEXT', data: 'y', user_id: U, conversation_id: C, created_at: new Date(Date.now() + 3000).toISOString() });
    bz.add([m2]); bz.pushAll(); await waitFor(() => g.hooks.length >= 2, 10000);
    check('e2e: a new message after the reconnect -> no offline_ms', g.hooks[1] && !('offline_ms' in g.hooks[1]) && !('gateway_status' in g.hooks[1]));
    check('e2e: startup log line "gateway status offline_threshold_ms=30000 auth_fail_limit=3" + reconnect line', /gateway status offline_threshold_ms=30000 auth_fail_limit=3 last_alive=\S+Z/.test(g.log()) && /gateway reconnected after outage offline_ms=\d+ .* reason=restart/.test(g.log()));
    await stop(g);
    // quick restart (< threshold) -> no annotation
    const m3 = blazeMsg({ category: 'PLAIN_TEXT', data: 'z', user_id: U, conversation_id: C, created_at: new Date(Date.now() - 1000).toISOString() }); bz.add([m3]);
    const g2 = await gw({ dir, blazeUrl: bz.url }); await waitFor(() => g2.hooks.length >= 1, 20000);
    check('e2e: quick restart (a few s) -> backlog NOT annotated (debounced)', g2.hooks[0] && g2.hooks[0].message_id === m3.message_id && !('offline_ms' in g2.hooks[0]), g2.hooks[0]);
    await stop(g2); await bz.close(); }
  { const g = await gw({ dir: path.join(W, 'e2e-badks'), blazeUrl: 'ws://127.0.0.1:9', extraEnv: { MIXIN_KEYSTORE_JSON: '{not json' } });
    const r = await g.p.done; await g.hook.close(); await g.api.close();
    check('e2e: invalid keystore JSON -> exit 78 (RestartPreventExitStatus: no systemd restart loop), keystore not logged', r.code === 78 && /FATAL keystore invalid/.test(g.log()) && !g.log().includes('{not json'), { code: r.code }); }
  fs.rmSync(W, { recursive: true, force: true });
  finish('gateway-status');
})().catch((e) => { console.error('FAIL crash', e); process.exit(1); });
