'use strict';
// Metadata-only log of delivery receipts (ACKNOWLEDGE_MESSAGE_RECEIPT frames) for the bot's OWN message ids.
// Logs: message id, status, receipt updated_at, and user/session id prefixes when the frame carries them.
// Never logs bodies. Never ACKs (receipts are not ACKed by official clients either; blaze-conn returns before ACK).
// Own ids come from sent-log.jsonl (written by reply.js), re-read only when that file changes.
// Disable with MIXIN_RECEIPT_LOG=0.
const fs = require('fs');
const sentLog = require('./sent-log');

const STATUSES = new Set(['SENT', 'DELIVERED', 'READ']);
const short = (v) => (typeof v === 'string' && v ? v.slice(0, 8) : '');

function createReceiptLog({ log, enabled = process.env.MIXIN_RECEIPT_LOG !== '0', maxIds = 5000, statMs = 2000, dedupeMax = 20000 } = {}) {
  let ids = new Set(), sig = '', lastStat = 0;
  const seen = new Set();
  function refresh() {
    const now = Date.now();
    if (now - lastStat < statMs) return;
    lastStat = now;
    let st; try { st = fs.statSync(sentLog.file()); } catch (_) { ids = new Set(); sig = ''; return; }
    const s = `${st.size}:${st.mtimeMs}`;
    if (s === sig) return;
    sig = s;
    const next = new Set();
    let txt = ''; try { txt = fs.readFileSync(sentLog.file(), 'utf8'); } catch (_) {}
    const lines = txt.split('\n').filter(Boolean).slice(-maxIds);
    for (const l of lines) { try { const r = JSON.parse(l); if (r && typeof r.message_id === 'string') next.add(r.message_id); } catch (_) {} }
    ids = next;
  }
  function onAckReceipt(msg) {
    if (!enabled || !msg) return;
    try {
      const id = msg.message_id, status = msg.status;
      if (typeof id !== 'string' || !id) return;
      refresh();
      if (!ids.has(id)) { lastStat = 0; refresh(); if (!ids.has(id)) return; } // just-sent id: force one re-read
      const st = STATUSES.has(status) ? status : 'OTHER';
      const key = `${id}|${st}|${msg.session_id || ''}|${msg.user_id || ''}|${msg.updated_at || ''}`;
      if (seen.has(key)) return;
      seen.add(key); if (seen.size > dedupeMax) seen.clear();
      const who = [msg.user_id ? `user=${short(msg.user_id)}` : '', msg.session_id ? `session=${short(msg.session_id)}` : ''].filter(Boolean).join(' ');
      log(`receipt msg=${id} status=${st}${msg.updated_at ? ' updated_at=' + String(msg.updated_at).slice(0, 40) : ''}${who ? ' ' + who : ''}`);
    } catch (_) { /* never let logging affect the connection */ }
  }
  return { onAckReceipt, enabled: !!enabled, _ids: () => ids };
}
module.exports = { createReceiptLog };
