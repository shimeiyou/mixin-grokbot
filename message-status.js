#!/usr/bin/env node
'use strict';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'usage: node message-status.js --message <uuid> [--conversation <uuid>] [--since <ISO>] [--minutes N]';
const RANK = { SENT: 1, DELIVERED: 2, READ: 3 };

function isoToNanos(iso) { // keeps microsecond/nanosecond precision of server timestamps
  const m = /^(.*?)(?:\.(\d+))?Z$/.exec(String(iso));
  if (!m) return BigInt(Date.parse(iso)) * 1000000n;
  const sec = BigInt(Date.parse(m[1] + 'Z')) * 1000000n;
  return sec + BigInt(((m[2] || '') + '000000000').slice(0, 9));
}

async function statusRows({ api, messageId, sinceNanos, maxPages = 30 }) {
  const rows = []; let offset = sinceNanos;
  for (let p = 0; p < maxPages; p++) {
    const page = await api.request({ method: 'GET', url: `/messages/status/${offset}` });
    if (!Array.isArray(page) || page.length === 0) break;
    for (const r of page) if (r && r.message_id === messageId) rows.push(r);
    const last = page[page.length - 1].updated_at; const next = last ? isoToNanos(last) : offset;
    if (next <= offset) break;
    offset = next;
    if (page.length < 100) break;
  }
  return rows;
}

async function status({ api, botId, messageId, conversation, sinceNanos }) {
  const rows = await statusRows({ api, messageId, sinceNanos });
  const latest = new Map();
  for (const r of rows) {
    const k = r.session_id || r.user_id || '?'; const prev = latest.get(k);
    if (!prev || (RANK[r.status] || 0) > (RANK[prev.status] || 0) || ((RANK[r.status] || 0) === (RANK[prev.status] || 0) && String(r.updated_at) > String(prev.updated_at))) latest.set(k, r);
  }
  let parts = [], plat = new Map();
  if (conversation) {
    const c = await api.request({ method: 'GET', url: `/conversations/${conversation}` });
    parts = (c.participant_sessions || []).filter((s) => s.user_id !== botId);
    const users = [...new Set(parts.map((s) => s.user_id))];
    if (users.length) { try { for (const s of await api.request({ method: 'POST', url: '/sessions/fetch', data: users })) plat.set(s.session_id, s.platform || null); } catch (_) {} }
  }
  const s2u = new Map(parts.map((s) => [s.session_id, s.user_id]));
  const sessions = []; const listed = new Set();
  for (const s of parts) { const r = latest.get(s.session_id); listed.add(s.session_id); sessions.push({ user_id: s.user_id, session_id: s.session_id, platform: plat.get(s.session_id) || null, status: r ? r.status : 'NO_RECORD', updated_at: r ? r.updated_at : null }); }
  for (const [k, r] of latest) if (!listed.has(k)) sessions.push({ user_id: r.user_id || s2u.get(k) || null, session_id: r.session_id || null, platform: null, status: r.status, updated_at: r.updated_at, not_in_conversation: !!conversation });
  const best = new Map();
  for (const s of sessions) { const u = s.user_id || '?'; const b = best.get(u); if (!b || (RANK[s.status] || 0) > (RANK[b] || 0)) best.set(u, s.status); }
  const summary = { SENT: 0, DELIVERED: 0, READ: 0, NO_RECORD: 0 };
  for (const s of sessions) summary[s.status in summary ? s.status : 'NO_RECORD']++;
  return { ok: true, message_id: messageId, conversation_id: conversation || null, rows: rows.length, sessions, users: [...best].map(([user_id, best_status]) => ({ user_id, best_status })), summary };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE + '\n'); return 0; }
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const messageId = arg('--message'); let conversation = arg('--conversation');
  if (!UUID.test(messageId || '') || (conversation && !UUID.test(conversation))) { console.error(USAGE); return 2; }
  let since = arg('--since'); const minutes = arg('--minutes');
  if (since && isNaN(Date.parse(since))) { console.error(USAGE); return 2; }
  if (!conversation || !since) {
    try {
      const fs = require('fs'); const txt = fs.readFileSync(require('./sent-log').file(), 'utf8');
      for (const l of txt.split('\n')) { if (!l.includes(messageId)) continue; try { const r = JSON.parse(l); if (r.message_id === messageId) { if (!conversation) conversation = r.conversation_id; if (!since && !minutes && r.at) since = new Date(Date.parse(r.at) - 60000).toISOString(); } } catch (_) {} }
    } catch (_) {}
  }
  const sinceMs = since ? Date.parse(since) : Date.now() - (parseInt(minutes || '120', 10) * 60000);
  require('./ws-shim');
  const { MixinApi } = require('@mixin.dev/mixin-node-sdk');
  const { loadKeystore } = require('./common');
  let keystore; try { keystore = loadKeystore(); } catch (e) { console.error(JSON.stringify({ ok: false, code: 'NO_KEYSTORE', error: e.message })); return 1; }
  const API_BASE = process.env.MIXIN_API_BASE || ''; // tests only
  const api = MixinApi(API_BASE ? { keystore, requestConfig: { baseURL: API_BASE, timeout: 15000 } } : { keystore, requestConfig: { timeout: 15000 } });
  try {
    const r = await status({ api, botId: keystore.app_id, messageId, conversation, sinceNanos: BigInt(sinceMs) * 1000000n });
    console.log(JSON.stringify(r));
    return r.rows ? 0 : 4;
  } catch (e) {
    console.error(JSON.stringify({ ok: false, code: (e.response && e.response.status) || e.code || 'ERROR', error: e.message }));
    return 1;
  }
}
if (require.main === module) main().then((c) => process.exit(c));
module.exports = { status, statusRows, isoToNanos, main };
