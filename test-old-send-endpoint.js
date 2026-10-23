'use strict';
// TEST FIXTURE ONLY: verbatim copy of send-endpoint.js as deployed with fix #4 (before P0), used by test-p0.js to
// prove reply.js falls back gracefully when the running gateway is the old one. Not used at runtime.
// Local send endpoint (gateway side): lets reply.js send a prebuilt CREATE_MESSAGE on the gateway's MAIN Blaze
// connection instead of opening a second Blaze connection under the same bot session (that second connection made the
// server close the main one with 1006 a few seconds later).
// Transport: unix socket `MIXIN_SEND_SOCKET` (default <gateway dir>/run/send.sock), dir 0700, socket 0600, same user only.
// Protocol: one request per connection, one JSON line each way:
//   -> {"action":"CREATE_MESSAGE","params":{conversation_id,message_id,category,data_base64,...}}
//   <- {"ok":true,"data":{...}}  |  {"ok":false,"error":{"code":..,"description":..,"extra":..,"status":..}}
// Only ENCRYPTED_* categories are accepted (the endpoint exists for encrypted group replies; never plain).
// Logged: message id, conversation, category, result code. Never the data.
const fs = require('fs');
const net = require('net');
const path = require('path');

const MAX_REQ = 2 << 20; // 2 MB
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultSocketPath = () => process.env.MIXIN_SEND_SOCKET || path.join(__dirname, 'run', 'send.sock');

function validate(req) {
  if (!req || typeof req !== 'object' || req.action !== 'CREATE_MESSAGE') return 'action must be CREATE_MESSAGE';
  const p = req.params;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'params must be an object';
  if (!UUID.test(p.conversation_id || '') || !UUID.test(p.message_id || '')) return 'conversation_id/message_id must be uuids';
  if (!/^ENCRYPTED_[A-Z_]+$/.test(p.category || '')) return 'only ENCRYPTED_* categories are accepted';
  if (typeof p.data_base64 !== 'string' || !p.data_base64) return 'data_base64 required';
  return null;
}

function createSendEndpoint({ blaze, log, socketPath = defaultSocketPath(), waitOpenMs = 10000, timeoutMs = 15000 }) {
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
      const p = req.params;
      try {
        const m = await blaze.send('CREATE_MESSAGE', p, { waitOpenMs, timeoutMs });
        if (m && m.error) {
          log(`send endpoint msg=${p.message_id} conv=${p.conversation_id} cat=${p.category} error code=${m.error.code}`);
          reply({ ok: false, error: { code: m.error.code, description: m.error.description, extra: m.error.extra, status: m.error.status } });
        } else {
          log(`send endpoint msg=${p.message_id} conv=${p.conversation_id} cat=${p.category} ok`);
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

// Client side (reply.js). Resolves {data} or rejects with err.code = the server's error code (e.g. 20140, 10002),
// or err.unavailable = true when the endpoint cannot be used (no gateway / old gateway / gateway's Blaze down / timeout).
function sendViaEndpoint(params, { socketPath = defaultSocketPath(), timeoutMs = parseInt(process.env.MIXIN_SEND_ENDPOINT_TIMEOUT_MS || '30000', 10) } = {}) {
  return new Promise((resolve, reject) => {
    let buf = '', settled = false;
    const fail = (code, msg, unavailable, extra) => { if (settled) return; settled = true; const e = new Error(msg); e.code = code; e.unavailable = unavailable; if (extra) e.extra = extra; try { s.destroy(); } catch (_) {} reject(e); };
    const s = net.createConnection(socketPath);
    s.setTimeout(timeoutMs, () => fail('ETIMEDOUT', 'gateway endpoint timeout', true));
    s.on('error', (e) => fail(e.code || 'ECONNREFUSED', `gateway endpoint ${e.code || e.message}`, true));
    s.on('connect', () => s.write(JSON.stringify({ action: 'CREATE_MESSAGE', params }) + '\n'));
    s.on('data', (d) => {
      buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return;
      let r; try { r = JSON.parse(buf.slice(0, nl)); } catch (_) { return fail('BAD_RESPONSE', 'gateway endpoint bad response', true); }
      if (r.ok) { settled = true; s.end(); return resolve(r.data || {}); }
      const er = r.error || {};
      // transport-level problems on the gateway side -> unavailable (caller may use its own connection)
      const transport = ['NOT_CONNECTED', 'ETIMEDOUT', 'ECONNRESET', 'BAD_REQUEST', 'TOO_LARGE', 'ERROR'].includes(er.code);
      fail(er.code, `code: ${er.code}, description: ${er.description}${er.extra ? ', extra: ' + JSON.stringify(er.extra) : ''}`, transport, er.extra);
    });
    s.on('end', () => fail('BAD_RESPONSE', 'gateway endpoint closed without reply', true));
  });
}
module.exports = { createSendEndpoint, sendViaEndpoint, defaultSocketPath, validate };
