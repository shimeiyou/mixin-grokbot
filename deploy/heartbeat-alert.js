#!/usr/bin/env node
'use strict';
// Heartbeat alerting (run by the systemd --user timer mixin-gateway-heartbeat.timer on the gateway host).
// Checks: (1) `systemctl --user is-active <MIXIN_ALERT_SERVICE>` (default mixin-gateway.service; "" skips it),
//         (2) ./check-heartbeat.sh (last "heartbeat" line in gateway.log newer than HEARTBEAT_MAX_AGE_S, default 600).
// On FAILURE only: POST ONE additive webhook event kind:"gateway_alert" to your webhook receiver (MIXIN_ALERT_URL, default
// MIXIN_WEBHOOK_URL; same auth headers as gateway.js: MIXIN_WEBHOOK_KEY in MIXIN_WEBHOOK_KEY_HEADERS). Once per outage:
// state in MIXIN_ALERT_STATE_FILE (default <gw>/run/alert-state.json, 0600). A failed POST is retried on the next run.
// Recovery clears the state (logged, nothing posted). Within MIXIN_ALERT_START_GRACE_S of the service start a stale
// heartbeat is reported as 'starting' (exit 0, nothing posted, outage state kept). Never prints secrets or the webhook URL.
// Usage: node deploy/heartbeat-alert.js [--dry-run]   (--dry-run: print the payload it would send; no POST, no state)
// Auth pause (2026-10-19): if the gateway opened its auth circuit breaker (run/auth-alert-state.json, written by
// gateway.js when Blaze auth failed MIXIN_AUTH_FAIL_LIMIT times; the gateway itself already submitted ONE
// gateway_alert status:"auth_failed" through its webhook queue) and the service is still active, this check logs
// `auth_failed paused …` and exits 1 WITHOUT posting and without opening its own outage (no duplicate alert, no restart).
// Exit: 0 healthy, 1 outage (alert sent now or earlier), 2 outage and the alert could not be delivered, 78 config error.
const fs = require('fs'); const path = require('path'); const os = require('os');
const { execFileSync } = require('child_process');
const GW = path.resolve(__dirname, '..');
const { v5: uuidv5, v4: uuidv4 } = require('module').createRequire(path.join(GW, 'package.json'))('uuid');
const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const DRY = process.argv.includes('--dry-run');
const env = process.env;
const STATE = env.MIXIN_ALERT_STATE_FILE || path.join(GW, 'run', 'alert-state.json');
const AUTH_STATE = env.MIXIN_AUTH_STATE_FILE || path.join(GW, 'run', 'auth-alert-state.json');
const SERVICE = env.MIXIN_ALERT_SERVICE != null ? env.MIXIN_ALERT_SERVICE : 'mixin-gateway.service';
const say = (m) => console.log(`[${new Date().toISOString()}] heartbeat-alert ${m}`);

function sh(cmd, args, opts = {}) {
  try { return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, ...opts }).trim() }; }
  catch (e) { return { code: typeof e.status === 'number' ? e.status : 127, out: String(e.stdout || '').trim() || String(e.message).split('\n')[0] }; }
}
function check() {
  let service_state = 'skipped';
  if (SERVICE) service_state = sh('systemctl', ['--user', 'is-active', SERVICE]).out.split('\n')[0] || 'unknown';
  const hb = sh(path.join(GW, 'check-heartbeat.sh'), [], { cwd: GW });
  const age = (/last heartbeat (\d+)s ago/.exec(hb.out) || [])[1];
  const okService = !SERVICE || service_state === 'active';
  let status = !okService ? 'service_inactive' : hb.code !== 0 ? 'heartbeat_stale' : 'ok';
  // Startup grace: the gateway logs its first heartbeat ~5 min after start, so a service that became active less than
  // MIXIN_ALERT_START_GRACE_S (default 420) ago with no fresh heartbeat yet is "starting", not an outage.
  let active_for_s = null;
  if (status === 'heartbeat_stale' && SERVICE) {
    const r = sh('systemctl', ['--user', 'show', '-p', 'ActiveEnterTimestamp', '--value', SERVICE]);
    const t = r.code === 0 && r.out ? Date.parse(sh('date', ['-d', r.out, '+%Y-%m-%dT%H:%M:%S%z']).out.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : NaN;
    if (Number.isFinite(t)) active_for_s = Math.max(0, Math.round((Date.now() - t) / 1000));
    const grace = parseInt(env.MIXIN_ALERT_START_GRACE_S || '420', 10);
    if (active_for_s != null && active_for_s < grace) status = 'starting';
  }
  return { status, service_state, check: hb.out.slice(0, 300), heartbeat_age_s: age != null ? +age : null, active_for_s };
}
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return null; } };
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true, mode: 0o700 });
  const tmp = `${STATE}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, STATE);
}
function botId() { try { return JSON.parse(env.MIXIN_KEYSTORE_JSON || '{}').app_id || null; } catch (_) { return null; } }

function buildPayload(c, st) {
  const bot = botId(); const user = env.MIXIN_ALERT_USER || '';
  let conv = null;
  if (bot && /^[0-9a-f-]{36}$/i.test(user)) { try { conv = require(path.join(GW, 'conversation-target')).uniqueConversationId(bot, user); } catch (_) {} }
  const host = env.MIXIN_ALERT_HOST || os.hostname();
  const what = c.status === 'service_inactive' ? `服务未运行（${SERVICE}: ${c.service_state}）` : `心跳超时（${c.heartbeat_age_s != null ? c.heartbeat_age_s + ' 秒未更新' : '没有心跳'}）`;
  const text = `[网关告警] Mixin 网关（${host}）${what}：你的 AI agent / webhook 接收端收不到新消息，群回复会失败（ENDPOINT_UNAVAILABLE），直到网关恢复`;
  const now = new Date().toISOString();
  return {
    conversation_id: conv, user_id: user || bot, message_id: uuidv5(`gateway-alert:${st.outage_id}`, NS),
    category: 'SYSTEM_GATEWAY_ALERT', text, created_at: now, encrypted: false, original_category: 'SYSTEM_GATEWAY_ALERT',
    ...(/^(1|true|yes|on)$/i.test(env.MIXIN_PAYLOAD_V2 || '') ? { display_text: text } : {}),
    kind: 'gateway_alert',
    gateway_alert: {
      status: c.status, host, service: SERVICE || null, service_state: c.service_state, check: c.check, heartbeat_age_s: c.heartbeat_age_s,
      outage_id: st.outage_id, outage_since: st.since, detected_at: now, bot_id: bot,
      effect: 'no inbound Mixin messages reach your webhook receiver and group replies fail with ENDPOINT_UNAVAILABLE until the gateway is back; 1:1 replies still work',
      runbook: env.MIXIN_ALERT_RUNBOOK || 'docs/operations.md',
    },
  };
}
async function post(payload) {
  const url = env.MIXIN_ALERT_URL || env.MIXIN_WEBHOOK_URL;
  if (!url) { const e = new Error('no MIXIN_ALERT_URL / MIXIN_WEBHOOK_URL'); e.config = true; throw e; }
  const headers = { 'Content-Type': 'application/json' };
  const key = env.MIXIN_WEBHOOK_KEY; const hs = (env.MIXIN_WEBHOOK_KEY_HEADERS || 'Authorization,X-Webhook-Key').split(',').map((h) => h.trim()).filter(Boolean);
  if (key) for (const h of hs) headers[h] = h.toLowerCase() === 'authorization' ? `Bearer ${key}` : key;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(parseInt(env.MIXIN_ALERT_TIMEOUT_MS || '15000', 10)) });
  if (!r.ok) throw new Error(`webhook status ${r.status}`);
  return r.status;
}

(async () => {
  const c = check(); let st = readState();
  let auth = null; try { auth = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8')); } catch (_) {}
  if (auth && auth.outage_id && (!SERVICE || c.service_state === 'active')) {
    say(`auth_failed paused outage=${auth.outage_id} since=${auth.since} (gateway already alerted at ${auth.alerted_at || '-'}; nothing posted; fix the keystore and restart the service) service=${c.service_state}`);
    process.exit(1);
  }
  if (c.status === 'ok') {
    if (st) { say(`recovered outage=${st.outage_id} since=${st.since} alerted=${!!st.alerted_at} (${c.check})`); if (!DRY) { try { fs.unlinkSync(STATE); } catch (_) {} } }
    else say(`ok service=${c.service_state} ${c.check}`);
    process.exit(0);
  }
  if (c.status === 'starting') { say(`starting service=${c.service_state} active_for=${c.active_for_s}s, no fresh heartbeat yet (grace; nothing posted) ${c.check}`); process.exit(0); }
  if (!st) { st = { outage_id: uuidv4(), since: new Date().toISOString(), status: c.status, alerted_at: null }; if (!DRY) writeState(st); }
  const payload = buildPayload(c, st);
  if (DRY) { say(`DRY-RUN status=${c.status} would POST (url not shown):`); console.log(JSON.stringify(payload, null, 2)); process.exit(1); }
  if (st.alerted_at) { say(`outage continues status=${c.status} outage=${st.outage_id} already alerted at ${st.alerted_at} (${c.check})`); process.exit(1); }
  try {
    const code = await post(payload);
    st.alerted_at = new Date().toISOString(); st.status = c.status; writeState(st);
    say(`ALERT sent kind=gateway_alert status=${c.status} outage=${st.outage_id} msg=${payload.message_id} http=${code}`); process.exit(1);
  } catch (e) {
    say(`ALERT delivery FAILED status=${c.status} outage=${st.outage_id} err=${e.message} (retry next run)`); process.exit(e.config ? 78 : 2);
  }
})();
