'use strict';
// Shared fakes for offline tests: fake keystore, fake Blaze server, fake HTTP servers, child-process runner.
// Nothing here talks to the real Mixin API or the real webhook.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const pako = require('pako');
const WS = require(require.resolve('ws', { paths: [require.resolve('@mixin.dev/mixin-node-sdk')] }));
const { ed25519, x25519 } = require('@noble/curves/ed25519.js');
const m = require('./mixin-crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
function fakeKeystore() {
  const seed = crypto.randomBytes(32);
  return { app_id: uuid(), session_id: uuid(), session_private_key: seed.toString('hex'), _seed: seed };
}
const curvePub = (seed) => m.b64urlEncode(x25519.getPublicKey(ed25519.utils.toMontgomerySecret(seed)));
const ksJson = (ks) => { const { _seed, ...rest } = ks; return JSON.stringify(rest); };
const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
async function waitFor(fn, ms = 10000, step = 50) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; }

// Fake Blaze: models server-side pending messages. A message stays pending until ACKed (over WS or HTTP),
// LIST_PENDING (re)pushes every pending message, like the real server.
// onCreate(params) (optional): called for every CREATE_MESSAGE; return {error:{...}} to reject it, 'drop' to never reply.
function fakeBlaze({ wsAck = true, onCreate = null } = {}) {
  const st = { pending: new Map(), acked: new Set(), wsAcks: 0, lists: 0, conns: 0, pushed: 0, sockets: [], created: [] };
  const z = (o) => Buffer.from(pako.gzip(JSON.stringify(o)));
  return new Promise((res) => {
    const srv = new WS.Server({ port: 0 }, () => res({
      url: `ws://127.0.0.1:${srv.address().port}`, st,
      add: (msgs) => { for (const x of msgs) st.pending.set(x.message_id, x); },
      ackHttp: (ids) => { for (const id of ids) { st.pending.delete(id); st.acked.add(id); } },
      pushAll: () => { for (const s of st.sockets) if (s.readyState === 1) for (const x of st.pending.values()) { st.pushed++; s.send(z({ id: uuid(), action: 'CREATE_MESSAGE', data: x })); } },
      close: () => new Promise((r) => { for (const s of st.sockets) try { s.terminate(); } catch (_) {} srv.close(() => r()); }),
    }));
    srv.on('connection', (s) => {
      st.conns++; st.sockets.push(s);
      const pi = setInterval(() => { try { s.ping(); } catch (_) {} }, 2000);
      s.on('close', () => clearInterval(pi));
      s.on('message', (d) => {
        const msg = JSON.parse(pako.ungzip(d, { to: 'string' }));
        if (msg.action === 'ACKNOWLEDGE_MESSAGE_RECEIPT') {
          if (!wsAck) return; // simulate lost ACKs: no reply, not recorded
          st.wsAcks++; st.pending.delete(msg.params.message_id); st.acked.add(msg.params.message_id);
          s.send(z({ id: msg.id, action: msg.action })); return;
        }
        if (msg.action === 'CREATE_MESSAGE') {
          st.created.push(msg.params);
          const r = onCreate ? onCreate(msg.params) : null;
          if (r === 'drop') return;
          s.send(z(r && r.error ? { id: msg.id, action: msg.action, error: r.error } : { id: msg.id, action: msg.action, data: { message_id: msg.params.message_id, status: 'SENT' } }));
          return;
        }
        s.send(z({ id: msg.id, action: msg.action }));
        if (msg.action === 'LIST_PENDING_MESSAGES') {
          st.lists++;
          for (const x of st.pending.values()) { st.pushed++; s.send(z({ id: uuid(), action: 'CREATE_MESSAGE', data: x })); }
        }
      });
    });
  });
}
// Blaze message as delivered with parse:false (data = base64).
function blazeMsg({ category, data, user_id, conversation_id, message_id = uuid(), quote_message_id, created_at = new Date().toISOString() }) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const o = { type: 'message', source: 'CREATE_MESSAGE', conversation_id, user_id, message_id, category, data: b.toString('base64'), status: 'SENT', created_at, updated_at: created_at, session_id: uuid() };
  if (quote_message_id) o.quote_message_id = quote_message_id;
  return o;
}

// Minimal HTTP server; handler(req, body, res) may return {status, json|body}.
function httpServer(handler) {
  const reqs = [];
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const r = { method: req.method, url: req.url, headers: req.headers, body };
        reqs.push(r);
        let out;
        try { out = (await handler(r)) || { status: 404, json: { error: { code: 404, description: 'not found' } } }; } catch (e) { out = { status: 500, json: { error: String(e) } }; }
        const payload = out.json !== undefined ? Buffer.from(JSON.stringify(out.json)) : Buffer.from(out.body || '');
        rsp.writeHead(out.status || 200, { 'Content-Type': out.json !== undefined ? 'application/json' : 'application/octet-stream', ...(out.headers || {}) });
        rsp.end(payload);
      });
    });
    srv.listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${srv.address().port}`, reqs, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) }));
  });
}

// Fake Mixin REST API (subset). blobs: attachment_id -> Buffer served at /blob/<id>.
function fakeMixinApi({ users = {}, stickers = {}, blobs = {}, onAck = () => {}, sessions = {}, conversations = {}, failAcks = 0, messageHook = null } = {}) {
  const state = { acks: [], messages: [], encrypted: [], uploads: {}, created: [], failAcks };
  let base = '';
  return httpServer((r) => {
    const u = r.url.split('?')[0];
    const J = () => JSON.parse(r.body.toString() || 'null');
    let mm;
    if (r.method === 'POST' && u === '/acknowledgements') {
      if (state.failAcks > 0) { state.failAcks--; return { status: 500, json: { error: { code: 500, description: 'boom', status: 500 } } }; }
      const b = J(); state.acks.push({ body: b, auth: r.headers.authorization || '' }); onAck(b.map((x) => x.message_id)); return { json: { data: [] } };
    }
    if (r.method === 'GET' && (mm = u.match(/^\/users\/([^/]+)$/))) return users[mm[1]] ? { json: { data: users[mm[1]] } } : { status: 404, json: { error: { code: 404, description: 'not found', status: 404 } } };
    if (r.method === 'GET' && (mm = u.match(/^\/stickers\/([^/]+)$/))) return stickers[mm[1]] ? { json: { data: stickers[mm[1]] } } : { status: 404, json: { error: { code: 404, description: 'nf', status: 404 } } };
    if (r.method === 'GET' && (mm = u.match(/^\/attachments\/([^/]+)$/))) return (blobs[mm[1]] || state.uploads[mm[1]]) ? { json: { data: { type: 'attachment', attachment_id: mm[1], view_url: `${base}/blob/${mm[1]}` } } } : { status: 404, json: { error: { code: 404, description: 'nf', status: 404 } } };
    if (r.method === 'GET' && (mm = u.match(/^\/blob\/([^/]+)$/))) { const b = blobs[mm[1]] || state.uploads[mm[1]]; return b ? { body: b } : { status: 404, body: 'nf' }; }
    if (r.method === 'POST' && u === '/attachments') { const id = uuid(); state.created.push(id); return { json: { data: { type: 'attachment', attachment_id: id, upload_url: `${base}/upload/${id}`, view_url: `${base}/blob/${id}`, created_at: new Date().toISOString() } } }; }
    if (r.method === 'PUT' && (mm = u.match(/^\/upload\/([^/]+)$/))) { state.uploads[mm[1]] = r.body; state.uploadHeaders = r.headers; return { status: 200, body: '' }; }
    if (r.method === 'POST' && u === '/messages') { const b = J(); state.messages.push(...(Array.isArray(b) ? b : [b])); if (messageHook) { const o = messageHook(b); if (o) return o; } return { json: { data: {} } }; }
    if (r.method === 'POST' && u === '/encrypted_messages') { const b = J(); state.encrypted.push(...b); if (messageHook) { const o = messageHook(b, true); if (o) return o; } return { json: { data: b.map((x) => ({ type: 'message', message_id: x.message_id, state: 'SUCCESS' })) } }; }
    if (r.method === 'POST' && u === '/sessions/fetch') { const ids = J(); return { json: { data: ids.flatMap((id) => sessions[id] || []) } }; }
    if (r.method === 'GET' && (mm = u.match(/^\/conversations\/([^/]+)$/))) return conversations[mm[1]] ? { json: { data: conversations[mm[1]] } } : { status: 404, json: { error: { code: 404, description: 'nf', status: 404 } } };
    return null;
  }).then((s) => { base = s.url; return { ...s, state }; });
}

// Spawn node with a CLEAN env (never inherits the real MIXIN_* secrets / webhook URL).
function runNode(args, { env = {}, cwd = __dirname, input = null, timeoutMs = 60000 } = {}) {
  // Default MIXIN_SEND_SOCKET: a fresh private path, so a test reply.js can never reach a real gateway's send endpoint.
  // Same for the sent-log and member-alert state: tests never write into the real files.
  const sock = path.join(os.tmpdir(), `mixin-test-sock-${process.pid}-${crypto.randomBytes(4).toString('hex')}`, 'send.sock');
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH, HOME: os.tmpdir(), MIXIN_SEND_SOCKET: sock, MIXIN_SENT_LOG_FILE: path.join(path.dirname(sock), 'sent-log.jsonl'), MIXIN_MEMBER_ALERT_STATE_FILE: path.join(path.dirname(sock), 'member-alert-state.json'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  if (input != null) child.stdin.end(input); else child.stdin.end();
  const done = new Promise((res) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (code, sig) => { clearTimeout(t); res({ code, sig, out, err }); });
  });
  return { child, done, get out() { return out; }, get err() { return err; } };
}

let failures = 0, passes = 0;
const check = (name, ok, info) => { if (ok) passes++; else failures++; console.log(ok ? 'PASS' : 'FAIL', name, ok || info === undefined ? '' : JSON.stringify(info).slice(0, 600)); };
const finish = (label) => { console.log(failures ? `${label}: SOME FAILED (${failures} failed, ${passes} passed)` : `${label}: ALL PASS (${passes})`); process.exit(failures ? 1 : 0); };
module.exports = { sleep, uuid, fakeKeystore, curvePub, ksJson, tmpdir, waitFor, fakeBlaze, blazeMsg, httpServer, fakeMixinApi, runNode, check, finish, encryptFor: (plain, ks, senderSeed = crypto.randomBytes(32)) => m.encryptMessageData(Buffer.from(plain), [{ session_id: ks.session_id, public_key: curvePub(ks._seed) }], senderSeed) };
