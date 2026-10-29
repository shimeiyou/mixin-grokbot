'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { v5: uuidv5, v4: uuidv4 } = require('uuid');
const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const iso = (t) => new Date(t).toISOString();

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function writeJson(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(tmp, f);
}

function readAlive(file, maxAgeMs = 7 * 86400e3, now = Date.now()) {
  const s = readJson(file); const t = s && Number(s.t);
  return Number.isFinite(t) && t <= now && now - t <= maxAgeMs ? t : null;
}

function createOutageMarker({ log, thresholdMs = 30000, windowMs = 600000, graceMs = 2000 }) {
  let last = null;
  return {
    mark(info) {
      if (!info || !(info.offline_ms > thresholdMs)) return false;
      last = { offline_ms: Math.round(info.offline_ms), offline_since: iso(info.since), reconnected_at: iso(info.at), reason: info.reason || null, at: info.at };
      log(`gateway reconnected after outage offline_ms=${last.offline_ms} since=${last.offline_since} reason=${last.reason || '-'} gen=${info.gen != null ? info.gen : '-'}`);
      return true;
    },
    annotate(payload, receivedAt = Date.now()) {
      if (!last || receivedAt - last.at > windowMs) return false;
      const ct = Date.parse(payload.created_at);
      if (Number.isFinite(ct) && ct > last.at + graceMs) return false; // written after we were back: not delayed by the outage
      payload.offline_ms = last.offline_ms;
      payload.gateway_status = { offline_ms: last.offline_ms, offline_since: last.offline_since, reconnected_at: last.reconnected_at, reason: last.reason };
      return true;
    },
    _last: () => last,
  };
}

function createAuthAlert({ log, submit, stateFile, botId, env = process.env, v2 = false }) {
  return {
    onFailed(info) {
      const prev = readJson(stateFile);
      if (prev && prev.outage_id) { log(`auth alert already submitted outage=${prev.outage_id} since=${prev.since} (not sent again)`); return null; }
      const now = new Date().toISOString();
      const st = { outage_id: uuidv4(), since: iso(info.since || Date.now()), status: 'auth_failed', alerted_at: now, failures: info.failures };
      try { writeJson(stateFile, st); } catch (e) { log(`WARN auth alert state write failed err=${e.message}`); }
      const user = env.MIXIN_ALERT_USER || ''; let conv = null;
      if (botId && /^[0-9a-f-]{36}$/i.test(user)) { try { conv = require('./conversation-target').uniqueConversationId(botId, user); } catch (_) {} }
      const host = env.MIXIN_ALERT_HOST || os.hostname(); const service = env.MIXIN_ALERT_SERVICE || 'mixin-gateway.service';
      const text = `[网关告警] Mixin 网关（${host}）Blaze 鉴权失败（连续 ${info.failures} 次），已暂停重连：你的 AI agent / webhook 接收端收不到新消息，群回复会失败（ENDPOINT_UNAVAILABLE），直到修好凭据并重启服务`;
      const payload = {
        conversation_id: conv, user_id: user || botId, message_id: uuidv5(`gateway-alert:${st.outage_id}`, NS),
        category: 'SYSTEM_GATEWAY_ALERT', text, created_at: now, encrypted: false, original_category: 'SYSTEM_GATEWAY_ALERT',
        ...(v2 ? { display_text: text } : {}),
        kind: 'gateway_alert',
        gateway_alert: {
          status: 'auth_failed', host, service, service_state: 'active', check: `blaze auth failed ${info.failures} consecutive times; reconnect paused`,
          heartbeat_age_s: null, outage_id: st.outage_id, outage_since: st.since, detected_at: now, bot_id: botId || null,
          effect: 'no inbound Mixin messages reach your webhook receiver and group replies fail with ENDPOINT_UNAVAILABLE until the credentials are fixed and the service is restarted; 1:1 replies sent over a remote send endpoint may fail too',
          runbook: env.MIXIN_ALERT_RUNBOOK || 'docs/operations.md',
          auth_failures: info.failures, last_error: String(info.last_error || '').slice(0, 200),
          resume: 'fix MIXIN_KEYSTORE_JSON in ~/.mixin-secrets/mixin-gateway.env, then: systemctl --user restart mixin-gateway.service',
        },
      };
      log(`ALERT submitted kind=gateway_alert status=auth_failed outage=${st.outage_id} msg=${payload.message_id} failures=${info.failures}`);
      submit(payload);
      return payload;
    },
    onOk() {
      const prev = readJson(stateFile);
      if (!prev) return;
      try { fs.unlinkSync(stateFile); } catch (_) {}
      log(`auth recovered outage=${prev.outage_id} since=${prev.since} (auth alert state cleared)`);
    },
  };
}
module.exports = { createOutageMarker, createAuthAlert, readAlive, writeJson, readJson };
