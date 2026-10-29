'use strict';
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 << 20, KEEP = 10000, LOG_SCAN_BYTES = 64 << 20;
const file = () => process.env.MIXIN_SENT_LOG_FILE || path.join(__dirname, 'sent-log.jsonl');
const logFile = () => process.env.MIXIN_GATEWAY_LOG || path.join(__dirname, 'gateway.log');

function record({ message_id, conversation_id, category, via }) {
  const f = file();
  const line = JSON.stringify({ message_id, conversation_id, category, via: via || '', at: new Date().toISOString() }) + '\n';
  const fd = fs.openSync(f, 'a', 0o600);
  try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
  try {
    if (fs.statSync(f).size > MAX_BYTES) {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-KEEP);
      const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 }); fs.renameSync(tmp, f);
    }
  } catch (_) {}
}

function tail(f, maxBytes) {
  let fd; try { fd = fs.openSync(f, 'r'); } catch (_) { return ''; }
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - maxBytes), buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start); return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function isOwn(conv, id, { botId = null } = {}) {
  if (!conv || !id) return { own: false };
  for (const l of tail(file(), 8 << 20).split('\n')) {
    if (!l.includes(id)) continue;
    try { const r = JSON.parse(l); if (r.message_id === id && r.conversation_id === conv) return { own: true, source: 'sent-log' }; } catch (_) {}
  }
  try {
    const m = require('./context-store').recent(conv, null).find((x) => x.message_id === id);
    if (m && m.from_bot && (!botId || m.user_id === botId)) return { own: true, source: 'context' };
  } catch (_) {}
  const needle = `reply sent msg=${id} conv=${conv} `;
  if (tail(logFile(), LOG_SCAN_BYTES).includes(needle)) return { own: true, source: 'gateway-log' };
  return { own: false };
}
module.exports = { record, isOwn, file };
