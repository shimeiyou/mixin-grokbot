'use strict';

// Local send endpoint (unix socket 0600 or SSH streamlocal): proxies group encrypted CREATE_MESSAGE
// over the gateway's single Blaze session so reply.js never opens a second session (avoiding 1006).
const fs = require('fs');
const net = require('net');
const path = require('path');
const channel = require('./send-channel');

const MAX_REQ = 2 << 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/;

function recallTarget(p) {
  if (Object.keys(p).some((k) => !['conversation_id', 'message_id', 'category', 'status', 'data_base64'].includes(k))) return null;
  let d;
  try {
    d = JSON.parse(Buffer.from(p.data_base64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).length !== 1 || !UUID.test(d.message_id || '')) return null;
  return d.message_id;
}

function validateRecord(req) {
  const it = req.items;
  if (!Array.isArray(it) || !it.length || it.length > 50) return 'RECORD needs items (1..50)';
  if (Object.keys(req).some((k) => !['action', 'items'].includes(k))) return 'RECORD takes only items';
  for (const x of it) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return 'RECORD item must be an object';
    if (Object.keys(x).some((k) => !['message_id', 'conversation_id', 'category', 'via', 'context', 'remove_context'].includes(k))) return 'RECORD item has unknown fields';
    if (!UUID.test(x.message_id || '') || !UUID.test(x.conversation_id || '')) return 'RECORD item ids must be uuids';
    if (!/^[A-Z_]{3,40}$/.test(x.category || '')) return 'RECORD item category invalid';
    if (x.via != null && !/^[a-z-]{0,20}$/.test(String(x.via))) return 'RECORD item via invalid';
    if (x.remove_context != null && typeof x.remove_context !== 'boolean') return 'RECORD remove_context must be boolean';
    if (x.context != null) {
      const c = x.context;
      if (!c || typeof c !== 'object' || typeof c.text !== 'string' || c.text.length > 8000 || !ISO.test(c.created_at || '') || Object.keys(c).length !== 2) {
        return 'RECORD context must be {text (<=8000), created_at (ISO)}';
      }
    }
  }
  return null;
}

function validate(req) {
  if (req && typeof req === 'object' && req.action === 'RECORD') return validateRecord(req);
  if (!req || typeof req !== 'object' || req.action !== 'CREATE_MESSAGE') return 'action must be CREATE_MESSAGE or RECORD';
  const p = req.params;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'params must be an object';
  if (!UUID.test(p.conversation_id || '') || !UUID.test(p.message_id || '')) return 'conversation_id/message_id must be uuids';
  if (typeof p.data_base64 !== 'string' || !p.data_base64) return 'data_base64 required';
  if (p.category === 'MESSAGE_RECALL') return recallTarget(p) ? null : 'MESSAGE_RECALL needs only conversation_id/message_id/category/status and data {"message_id":"<uuid>"}';
  if (!/^ENCRYPTED_[A-Z_]+$/.test(p.category || '')) return 'only ENCRYPTED_* categories (or MESSAGE_RECALL of our own message) are accepted';
  if (p.mentions != null && (!Array.isArray(p.mentions) || p.mentions.length > 100 || !p.mentions.every((x) => UUID.test(String(x))))) {
    return 'mentions must be an array of at most 100 user ids (uuids)';
  }
  return null;
}

function defaultRecord(items, { botId }) {
  const sentLog = require('./sent-log');
  const cs = require('./context-store');
  let recorded = 0;
  let context = 0;
  let removed = 0;
  for (const x of items) {
    if (x.remove_context) {
      try { if (cs.enabled() && cs.remove(x.conversation_id, x.message_id)) removed++; } catch (_) {}
      if (x.category === 'MESSAGE_RECALL') continue;
    }
    sentLog.record({ message_id: x.message_id, conversation_id: x.conversation_id, category: x.category, via: x.via });
    recorded++;
    if (x.context && cs.enabled() && botId) {
      try {
        if (cs.append({ conversation_id: x.conversation_id, user_id: botId, message_id: x.message_id, text: x.context.text, created_at: x.context.created_at, from_bot: true }) !== false) context++;
      } catch (_) {}
    }
  }
  return { recorded, context, removed };
}

function createSendEndpoint({
  blaze, log, socketPath = channel.defaultSocketPath(), waitOpenMs = 10000, timeoutMs = 15000, botId = null,
  isOwn = (c, id) => require('./sent-log').isOwn(c, id, { botId }).own,
  record = (items) => defaultRecord(items, { botId }),
}) {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  try {
    if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
  } catch (_) {}

  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const reply = (o) => {
      if (done) return;
      done = true;
      try { sock.end(JSON.stringify(o) + '\n'); } catch (_) {}
    };
    sock.setTimeout(waitOpenMs + timeoutMs + 10000, () => {
      reply({ ok: false, error: { code: 'ETIMEDOUT', description: 'endpoint timeout' } });
      sock.destroy();
    });
    sock.on('error', () => {});
    sock.on('data', async (d) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      if (buf.length > MAX_REQ) return reply({ ok: false, error: { code: 'TOO_LARGE', description: 'request too large' } });
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      let req;
      try { req = JSON.parse(buf.subarray(0, nl).toString('utf8')); }
      catch (_) { return reply({ ok: false, error: { code: 'BAD_REQUEST', description: 'invalid JSON' } }); }
      const bad = validate(req);
      if (bad) {
        log(`send endpoint rejected bad request: ${bad}`);
        return reply({ ok: false, error: { code: 'BAD_REQUEST', description: bad } });
      }
      if (req.action === 'RECORD') {
        try {
          const r = record(req.items);
          log(`send endpoint record items=${req.items.length} recorded=${r.recorded} context=${r.context} removed=${r.removed || 0}`);
          reply({ ok: true, data: r });
        } catch (e) {
          log(`WARN send endpoint record failed err=${e.message}`);
          reply({ ok: false, error: { code: 'RECORD_FAILED', description: e.message } });
        }
        return;
      }
      const p = req.params;
      const target = p.category === 'MESSAGE_RECALL' ? recallTarget(p) : null;
      if (target && !isOwn(p.conversation_id, target)) {
        log(`send endpoint msg=${p.message_id} conv=${p.conversation_id} cat=MESSAGE_RECALL target=${target} refused not_own`);
        return reply({ ok: false, error: { code: 'NOT_OWN_MESSAGE', description: 'recall allowed only for messages the bot sent in this conversation' } });
      }
      try {
        const m = await blaze.send('CREATE_MESSAGE', p, { waitOpenMs, timeoutMs });
        if (m && m.error) {
          log(`send endpoint msg=${p.message_id} conv=${p.conversation_id} cat=${p.category} error code=${m.error.code}`);
          reply({ ok: false, error: { code: m.error.code, description: m.error.description, extra: m.error.extra, status: m.error.status } });
        } else {
          const mTag = Array.isArray(p.mentions) && p.mentions.length ? ' mentions=' + p.mentions.length : '';
          log(`send endpoint msg=${p.message_id} conv=${p.conversation_id} cat=${p.category}${target ? ' target=' + target : ''}${mTag} ok`);
          reply({ ok: true, data: m && m.data ? { message_id: m.data.message_id, status: m.data.status } : {} });
        }
      } catch (e) {
        log(`send endpoint msg=${p.message_id} conv=${p.conversation_id} cat=${p.category} failed code=${e.code || '-'}`);
        reply({ ok: false, error: { code: e.code || 'ERROR', description: e.message } });
      }
    });
  });

  srv.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch (_) {}
    log(`send endpoint listening socket=${socketPath}`);
  });
  srv.on('error', (e) => log(`WARN send endpoint unavailable err=${e.message}`));
  return {
    close: () => {
      try { srv.close(); } catch (_) {}
      try { fs.unlinkSync(socketPath); } catch (_) {}
    },
    socketPath,
  };
}

module.exports = {
  ...channel,
  createSendEndpoint,
  validate,
  recallTarget,
  defaultRecord,
};
