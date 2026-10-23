'use strict';
// Local send endpoint (gateway side): lets reply.js send a prebuilt CREATE_MESSAGE on the gateway's MAIN Blaze
// connection instead of opening a second Blaze connection under the same bot session (that second connection made the
// server close the main one with 1006 a few seconds later).
// Transport (server): unix socket `MIXIN_SEND_SOCKET` (default <gateway dir>/run/send.sock), dir 0700, socket 0600,
// same user only. Nothing ever listens on a network port.
// Transport (client, reply.js / recall.js): MIXIN_SEND_ENDPOINT (see parseEndpoint):
//   unset            -> local socket MIXIN_SEND_SOCKET / <dir>/run/send.sock (same host as the gateway)
//   unix:<abs path>  -> that local socket ("/abs/path" alone works too)
//   ssh:<host>:<abs path> -> `ssh -o BatchMode=yes … -W <abs path> -- <host>` (OpenSSH streamlocal forwarding over
//                    stdio): the same one-line protocol, carried over SSH to the socket on the gateway host. Auth = the
//                    SSH key in ~/.ssh/config for <host>; the socket stays 0600 there.
//   0|off|false|no   -> disabled (group sends then fail; there is no second Blaze connection any more, audit W-6)
// Protocol: one request per connection, one JSON line each way:
//   -> {"action":"CREATE_MESSAGE","params":{conversation_id,message_id,category,data_base64,...}}
//   -> {"action":"RECORD","items":[{message_id,conversation_id,category,via,context?:{text,created_at},remove_context?}]}
//      (remote clients only: keeps the gateway host's sent-log.jsonl / context store in sync with what reply.js sent
//       from another host, so receipts, recall ownership checks and webhook `context` keep working)
//   <- {"ok":true,"data":{...}}  |  {"ok":false,"error":{"code":..,"description":..,"extra":..,"status":..}}
// Only ENCRYPTED_* categories are accepted (the endpoint exists for encrypted group replies; never plain).
// One narrow exception: MESSAGE_RECALL (a control message with no encrypted form; data is exactly {"message_id"}),
// only for a message the bot itself sent in that conversation (sent-log.js), and no other params.
// reply.js only sends it when MIXIN_GROUP_RECALL=1 (group recall is refused by default).
// Optional `mentions` (array of user uuids, <=100) is passed through to Blaze (reply.js --mention).
// Logged: message id, conversation, category, mention count, result code. Never the data.
const fs = require('fs');
const net = require('net');
const path = require('path');

const MAX_REQ = 2 << 20; // 2 MB
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultSocketPath = () => process.env.MIXIN_SEND_SOCKET || path.join(__dirname, 'run', 'send.sock');

const ISO = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/;
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
      if (!c || typeof c !== 'object' || typeof c.text !== 'string' || c.text.length > 8000 || !ISO.test(c.created_at || '') || Object.keys(c).length !== 2) return 'RECORD context must be {text (<=8000), created_at (ISO)}';
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
  if (p.mentions != null && (!Array.isArray(p.mentions) || p.mentions.length > 100 || !p.mentions.every((x) => UUID.test(String(x))))) return 'mentions must be an array of at most 100 user ids (uuids)';
  return null;
}
// MESSAGE_RECALL params -> target message id, or null if anything else is in there
function recallTarget(p) {
  if (Object.keys(p).some((k) => !['conversation_id', 'message_id', 'category', 'status', 'data_base64'].includes(k))) return null;
  let d; try { d = JSON.parse(Buffer.from(p.data_base64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (_) { return null; }
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).length !== 1 || !UUID.test(d.message_id || '')) return null;
  return d.message_id;
}

// Default RECORD handler: sent-log line per item; context entry when this host has MIXIN_WEBHOOK_CONTEXT=1.
function defaultRecord(items, { botId }) {
  const sentLog = require('./sent-log'); const cs = require('./context-store');
  let recorded = 0, context = 0, removed = 0;
  for (const x of items) {
    if (x.remove_context) { try { if (cs.enabled() && cs.remove(x.conversation_id, x.message_id)) removed++; } catch (_) {} if (x.category === 'MESSAGE_RECALL') continue; }
    sentLog.record({ message_id: x.message_id, conversation_id: x.conversation_id, category: x.category, via: x.via }); recorded++;
    if (x.context && cs.enabled() && botId) {
      try { if (cs.append({ conversation_id: x.conversation_id, user_id: botId, message_id: x.message_id, text: x.context.text, created_at: x.context.created_at, from_bot: true }) !== false) context++; } catch (_) {}
    }
  }
  return { recorded, context, removed };
}

function createSendEndpoint({ blaze, log, socketPath = defaultSocketPath(), waitOpenMs = 10000, timeoutMs = 15000, botId = null, isOwn = (c, id) => require('./sent-log').isOwn(c, id, { botId }).own, record = (items) => defaultRecord(items, { botId }) }) {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  try { if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath); } catch (_) {} // stale socket of a previous run
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0), done = false;
    const reply = (o) => { if (done) return; done = true; try { sock.end(JSON.stringify(o) + '\n'); } catch (_) {} };
    sock.setTimeout(waitOpenMs + timeoutMs + 10000, () => { reply({ ok: false, error: { code: 'ETIMEDOUT', description: 'endpoint timeout' } }); sock.destroy(); });
    sock.on('error', () => {});
    sock.on('data', async (d) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      if (buf.length > MAX_REQ) { reply({ ok: false, error: { code: 'TOO_LARGE', description: 'request too large' } }); return; }
      const nl = buf.indexOf(10); if (nl < 0) return;
      let req; try { req = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch (_) { reply({ ok: false, error: { code: 'BAD_REQUEST', description: 'invalid JSON' } }); return; }
      const bad = validate(req);
      if (bad) { log(`send endpoint rejected bad request: ${bad}`); reply({ ok: false, error: { code: 'BAD_REQUEST', description: bad } }); return; }
      if (req.action === 'RECORD') {
        try { const r = record(req.items); log(`send endpoint record items=${req.items.length} recorded=${r.recorded} context=${r.context} removed=${r.removed || 0}`); reply({ ok: true, data: r }); }
        catch (e) { log(`WARN send endpoint record failed err=${e.message}`); reply({ ok: false, error: { code: 'RECORD_FAILED', description: e.message } }); }
        return;
      }
      const p = req.params;
      const target = p.category === 'MESSAGE_RECALL' ? recallTarget(p) : null;
      if (target && !isOwn(p.conversation_id, target)) {
        log(`send endpoint msg=${p.message_id} conv=${p.conversation_id} cat=MESSAGE_RECALL target=${target} refused not_own`);
        reply({ ok: false, error: { code: 'NOT_OWN_MESSAGE', description: 'recall allowed only for messages the bot sent in this conversation' } }); return;
      }
      try {
        const m = await blaze.send('CREATE_MESSAGE', p, { waitOpenMs, timeoutMs });
        if (m && m.error) {
          log(`send endpoint msg=${p.message_id} conv=${p.conversation_id} cat=${p.category} error code=${m.error.code}`);
          reply({ ok: false, error: { code: m.error.code, description: m.error.description, extra: m.error.extra, status: m.error.status } });
        } else {
          log(`send endpoint msg=${p.message_id} conv=${p.conversation_id} cat=${p.category}${target ? ' target=' + target : ''}${Array.isArray(p.mentions) && p.mentions.length ? ' mentions=' + p.mentions.length : ''} ok`);
          reply({ ok: true, data: m && m.data ? { message_id: m.data.message_id, status: m.data.status } : {} });
        }
      } catch (e) {
        log(`send endpoint msg=${p.message_id} conv=${p.conversation_id} cat=${p.category} failed code=${e.code || '-'}`);
        reply({ ok: false, error: { code: e.code || 'ERROR', description: e.message } });
      }
    });
  });
  // The 0700 directory is the access control; the socket itself is chmod'ed to 0600 right after bind.
  srv.listen(socketPath, () => { try { fs.chmodSync(socketPath, 0o600); } catch (_) {} log(`send endpoint listening socket=${socketPath}`); });
  srv.on('error', (e) => log(`WARN send endpoint unavailable err=${e.message}`));
  return { close: () => { try { srv.close(); } catch (_) {} try { fs.unlinkSync(socketPath); } catch (_) {} }, socketPath };
}

// ---- Client side (reply.js / recall.js) ----
const OFF = /^(0|false|no|off)$/i;
// MIXIN_SEND_ENDPOINT -> {type:'unix',path} | {type:'ssh',host,path} | {type:'off'}; throws on a malformed value.
// Precedence: MIXIN_SEND_ENDPOINT > explicit socketPath / MIXIN_SEND_SOCKET (local) > migration marker > local default.
// Remote-send marker (client host that sends via a remote gateway): <dir>/deploy/MIGRATED_TO_VPS (MIXIN_MIGRATION_MARKER overrides the path)
// holds the endpoint on its first non-comment line, e.g. "ssh:<host>:/home/<user>/mixin-gateway/run/send.sock". So callers
// need no env change. A marker without a valid endpoint fails closed (ENDPOINT_CONFIG), never the local socket.
const markerPath = () => process.env.MIXIN_MIGRATION_MARKER || path.join(__dirname, 'deploy', 'MIGRATED_TO_VPS');
function markerEndpoint() {
  let txt; try { txt = fs.readFileSync(markerPath(), 'utf8'); } catch (_) { return null; }
  const line = txt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!line || OFF.test(line)) { const e = new Error(`migration marker ${markerPath()} has no endpoint line (ssh:<host>:/abs/send.sock)`); e.code = 'ENDPOINT_CONFIG'; throw e; }
  return { ...parseEndpoint(line), source: 'marker' };
}
function parseEndpoint(spec = process.env.MIXIN_SEND_ENDPOINT, { socketPath } = {}) {
  const v = String(spec == null ? '' : spec).trim();
  if (!v) {
    if (socketPath || process.env.MIXIN_SEND_SOCKET) return { type: 'unix', path: socketPath || defaultSocketPath(), spec: 'local' };
    const m = markerEndpoint(); if (m) return m;
    return { type: 'unix', path: defaultSocketPath(), spec: 'local' };
  }
  if (OFF.test(v)) return { type: 'off', spec: 'off' };
  const bad = (why) => { const e = new Error(`MIXIN_SEND_ENDPOINT invalid (${why}); use unix:/abs/send.sock or ssh:<host>:/abs/send.sock`); e.code = 'ENDPOINT_CONFIG'; throw e; };
  const safePath = (p) => { if (!p || !p.startsWith('/') || /[\s\0'"`$\\]/.test(p)) bad('path must be absolute, no spaces/quotes'); return p; };
  if (v.startsWith('ssh:')) {
    const rest = v.slice(4); const i = rest.indexOf(':');
    if (i <= 0) bad('ssh:<host>:<path>');
    const host = rest.slice(0, i), p = rest.slice(i + 1);
    if (!/^[A-Za-z0-9_.][A-Za-z0-9_.@-]{0,252}$/.test(host)) bad('host');
    return { type: 'ssh', host, path: safePath(p), spec: `ssh:${host}:${p}` };
  }
  if (v.startsWith('unix:')) return { type: 'unix', path: safePath(v.slice(5)), spec: v };
  if (v.startsWith('/')) return { type: 'unix', path: safePath(v), spec: `unix:${v}` };
  return bad('unknown scheme');
}
const describe = (ep) => (ep.type === 'ssh' ? `ssh:${ep.host}:${ep.path}` : ep.type === 'unix' ? `unix:${ep.path}` : 'off');
const sshArgs = (ep) => ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${parseInt(process.env.MIXIN_SSH_CONNECT_TIMEOUT_S || '10', 10)}`,
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ExitOnForwardFailure=yes', '-o', 'ClearAllForwardings=yes',
  '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-W', ep.path, '--', ep.host];
const oneLine = (s) => String(s || '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(-200);

const live = new Set(); // running ssh children of this process
process.on('exit', () => { for (const c of live) try { c.kill('SIGTERM'); } catch (_) {} });
// Opens a byte channel to the endpoint: {write(str), onData(fn), onClose(fn(reason)), close()}
function openChannel(ep) {
  if (ep.type === 'unix') {
    const s = net.createConnection(ep.path); const ch = { _s: s };
    let closeFn = () => {}, dataFn = () => {}, opened = false, pend = [];
    s.on('connect', () => { opened = true; for (const x of pend) s.write(x); pend = []; });
    s.on('data', (d) => dataFn(d));
    s.on('error', (e) => closeFn({ code: e.code || 'ECONNREFUSED', msg: `gateway endpoint ${e.code || e.message}` }));
    s.on('end', () => closeFn({ code: 'BAD_RESPONSE', msg: 'gateway endpoint closed without reply' }));
    ch.write = (x) => { if (opened) s.write(x); else pend.push(x); };
    ch.onData = (f) => { dataFn = f; }; ch.onClose = (f) => { closeFn = f; };
    ch.close = () => { try { s.destroy(); } catch (_) {} };
    return ch;
  }
  const { spawn } = require('child_process');
  const bin = process.env.MIXIN_SSH_BIN || 'ssh';
  const c = spawn(bin, sshArgs(ep), { stdio: ['pipe', 'pipe', 'pipe'] });
  let closeFn = () => {}, dataFn = () => {}, err = '';
  c.stdout.on('data', (d) => dataFn(d));
  c.stderr.on('data', (d) => { if (err.length < 4096) err += d; });
  c.stdin.on('error', () => {});
  c.on('error', (e) => closeFn({ code: 'SSH_FAILED', msg: `ssh could not start (${e.code || e.message})` }));
  c.on('close', (code) => {
    const why = oneLine(err);
    if (code === 255 && /channel \d+: open failed|stdio forwarding failed/i.test(why)) closeFn({ code: 'ENDPOINT_DOWN', msg: `gateway endpoint not listening at ${describe(ep)} (gateway down?): ${why}` });
    else closeFn({ code: code === 255 ? 'SSH_FAILED' : 'BAD_RESPONSE', msg: code === 255 ? `ssh to ${ep.host} failed: ${why || 'exit 255'}` : `gateway endpoint closed without reply (ssh exit ${code})${why ? ': ' + why : ''}` });
  });
  live.add(c); c.on('exit', () => live.delete(c));
  // close(ok): after a reply the server has already closed its side, so ssh exits by itself once stdin ends (a short
  // grace, then SIGTERM). close(false) on timeout / error: kill now. Any ssh still running when we exit is killed too.
  return { write: (x) => { try { c.stdin.write(x); } catch (_) {} }, onData: (f) => { dataFn = f; }, onClose: (f) => { closeFn = f; },
    close: (ok) => {
      try { c.stdin.end(); } catch (_) {}
      if (!ok) { try { c.kill('SIGTERM'); } catch (_) {} return; }
      const t = setTimeout(() => { try { c.kill('SIGTERM'); } catch (_) {} }, 2000); t.unref && t.unref();
    } };
}

// Transport-level codes: the request may not have reached Blaze -> safe to retry with the same message_id.
const RETRYABLE = new Set(['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'NOT_CONNECTED', 'SSH_FAILED', 'ENDPOINT_DOWN', 'BAD_RESPONSE']);
// Resolves {data} or rejects with err.code = the server's error code (e.g. 20140, 10002), or err.unavailable = true when
// the endpoint cannot be used (gateway down / its Blaze down / ssh failure / timeout); err.retryable for transport errors.
function endpointRequest(obj, { endpoint, socketPath, timeoutMs = parseInt(process.env.MIXIN_SEND_ENDPOINT_TIMEOUT_MS || '30000', 10) } = {}) {
  return new Promise((resolve, reject) => {
    let ep; try { ep = endpoint || parseEndpoint(socketPath ? '' : undefined, { socketPath }); } catch (e) { e.unavailable = true; return reject(e); }
    if (ep.type === 'off') { const e = new Error('gateway send endpoint disabled (MIXIN_SEND_ENDPOINT=0)'); e.code = 'ENDPOINT_DISABLED'; e.unavailable = true; return reject(e); }
    let buf = '', settled = false; const ch = openChannel(ep);
    const timer = setTimeout(() => fail('ETIMEDOUT', `gateway endpoint timeout (${describe(ep)})`, true), timeoutMs);
    const fail = (code, msg, unavailable, extra) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const e = new Error(msg); e.code = code; e.unavailable = unavailable; e.retryable = unavailable && RETRYABLE.has(code); if (extra) e.extra = extra;
      ch.close(false); reject(e);
    };
    ch.onClose((r) => fail(r.code, r.msg, true));
    ch.onData((d) => {
      buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return;
      let r; try { r = JSON.parse(buf.slice(0, nl)); } catch (_) { return fail('BAD_RESPONSE', 'gateway endpoint bad response', true); }
      if (r.ok) { settled = true; clearTimeout(timer); ch.close(true); return resolve(r.data || {}); }
      const er = r.error || {};
      const transport = ['NOT_CONNECTED', 'ETIMEDOUT', 'ECONNRESET', 'BAD_REQUEST', 'TOO_LARGE', 'ERROR', 'RECORD_FAILED'].includes(er.code);
      fail(er.code, `code: ${er.code}, description: ${er.description}${er.extra ? ', extra: ' + JSON.stringify(er.extra) : ''}`, transport, er.extra);
    });
    ch.write(JSON.stringify(obj) + '\n');
  });
}
function sendViaEndpoint(params, opts = {}) { return endpointRequest({ action: 'CREATE_MESSAGE', params }, opts); }
function recordViaEndpoint(items, opts = {}) { return endpointRequest({ action: 'RECORD', items }, { timeoutMs: 15000, ...opts }); }
module.exports = { markerPath, createSendEndpoint, sendViaEndpoint, recordViaEndpoint, endpointRequest, parseEndpoint, describe, sshArgs, defaultSocketPath, validate, recallTarget, defaultRecord, RETRYABLE };
