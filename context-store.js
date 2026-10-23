'use strict';
// Per-conversation recent-message store (JSON file per conversation, atomic writes, size/age caps).
// Holds message text on disk; never logs bodies.
const fs = require('fs');
const path = require('path');

function cfg(over = {}) {
  const env = process.env;
  return {
    dir: over.dir || env.MIXIN_CONTEXT_DIR || path.join(__dirname, 'context'),
    max: over.max ?? parseInt(env.MIXIN_CONTEXT_MAX || '20', 10),
    maxAgeMs: over.maxAgeMs ?? parseInt(env.MIXIN_CONTEXT_MAX_AGE_MS || String(24 * 3600 * 1000), 10),
    maxText: over.maxText ?? parseInt(env.MIXIN_CONTEXT_MAX_TEXT || '2000', 10),
    maxFileBytes: over.maxFileBytes ?? parseInt(env.MIXIN_CONTEXT_MAX_FILE_BYTES || '262144', 10),
  };
}
const enabled = () => /^(1|true|yes|on)$/i.test(process.env.MIXIN_WEBHOOK_CONTEXT || '');
const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const fileFor = (c, conv) => path.join(c.dir, safeId(conv) + '.json');
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(file, fn) {
  const lock = file + '.lock';
  const t0 = Date.now();
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.rmSync(lock, { force: true }); continue; } } catch (_) {}
      if (Date.now() - t0 > 2000) throw new Error('context lock timeout');
      sleepSync(10);
    }
  }
  try { return fn(); } finally { try { fs.rmSync(lock, { force: true }); } catch (_) {} }
}

function readRaw(file) {
  try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
function prune(list, c, now = Date.now()) {
  let out = list.filter((m) => m && m.message_id && !(Date.parse(m.created_at) < now - c.maxAgeMs));
  out.sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
  if (out.length > c.max) out = out.slice(out.length - c.max);
  return out;
}

// entry: {conversation_id, user_id, message_id, text, created_at, from_bot}
function append(entry, over) {
  const c = cfg(over);
  if (!entry || !entry.conversation_id || !entry.message_id || !safeId(entry.conversation_id)) return false;
  fs.mkdirSync(c.dir, { recursive: true, mode: 0o700 });
  const file = fileFor(c, entry.conversation_id);
  const rec = {
    user_id: entry.user_id || null, message_id: entry.message_id,
    text: String(entry.text ?? '').slice(0, c.maxText),
    created_at: entry.created_at || new Date().toISOString(), from_bot: !!entry.from_bot,
  };
  return withLock(file, () => {
    let list = readRaw(file).filter((m) => m.message_id !== rec.message_id);
    list.push(rec);
    list = prune(list, c);
    let data = JSON.stringify(list);
    while (Buffer.byteLength(data) > c.maxFileBytes && list.length > 1) { list.shift(); data = JSON.stringify(list); }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  });
}

// Recent context, oldest first, excluding excludeId.
function recent(conversationId, excludeId, over) {
  const c = cfg(over);
  if (!safeId(conversationId)) return [];
  return prune(readRaw(fileFor(c, conversationId)), c).filter((m) => m.message_id !== excludeId)
    .map(({ user_id, message_id, text, created_at, from_bot }) => ({ user_id, message_id, text, created_at, from_bot }));
}
// Remove one message (e.g. after MESSAGE_RECALL). Returns true if something was removed.
function remove(conversationId, messageId, over) {
  const c = cfg(over);
  if (!safeId(conversationId) || !messageId) return false;
  const file = fileFor(c, conversationId);
  if (!fs.existsSync(file)) return false;
  return withLock(file, () => {
    const list = readRaw(file);
    const next = list.filter((m) => m.message_id !== messageId);
    if (next.length === list.length) return false;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  });
}
module.exports = { append, recent, remove, enabled, cfg };
