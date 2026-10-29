'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

const OFF = /^(0|false|no|off)$/i;
const RETRYABLE = new Set(['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'NOT_CONNECTED', 'SSH_FAILED', 'ENDPOINT_DOWN', 'BAD_RESPONSE']);

const defaultSocketPath = () => process.env.MIXIN_SEND_SOCKET || path.join(__dirname, 'run', 'send.sock');
const markerPath = () => process.env.MIXIN_MIGRATION_MARKER || path.join(__dirname, 'deploy', 'MIGRATED_TO_VPS');

function markerEndpoint() {
  let txt;
  try { txt = fs.readFileSync(markerPath(), 'utf8'); } catch (_) { return null; }
  const line = txt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!line || OFF.test(line)) {
    throw Object.assign(new Error(`migration marker ${markerPath()} has no endpoint line (ssh:<host>:/abs/send.sock)`), { code: 'ENDPOINT_CONFIG' });
  }
  return { ...parseEndpoint(line), source: 'marker' };
}

function parseEndpoint(spec = process.env.MIXIN_SEND_ENDPOINT, { socketPath } = {}) {
  const v = String(spec == null ? '' : spec).trim();
  if (!v) {
    if (socketPath || process.env.MIXIN_SEND_SOCKET) return { type: 'unix', path: socketPath || defaultSocketPath(), spec: 'local' };
    const m = markerEndpoint();
    if (m) return m;
    return { type: 'unix', path: defaultSocketPath(), spec: 'local' };
  }
  if (OFF.test(v)) return { type: 'off', spec: 'off' };
  const bad = (why) => {
    throw Object.assign(new Error(`MIXIN_SEND_ENDPOINT invalid (${why}); use unix:/abs/send.sock or ssh:<host>:/abs/send.sock`), { code: 'ENDPOINT_CONFIG' });
  };
  const safePath = (p) => {
    if (!p || !p.startsWith('/') || /[\s\0'"`$\\]/.test(p)) bad('path must be absolute, no spaces/quotes');
    return p;
  };
  if (v.startsWith('ssh:')) {
    const rest = v.slice(4);
    const i = rest.indexOf(':');
    if (i <= 0) bad('ssh:<host>:<path>');
    const host = rest.slice(0, i);
    const p = rest.slice(i + 1);
    if (!/^[A-Za-z0-9_.][A-Za-z0-9_.@-]{0,252}$/.test(host)) bad('host');
    return { type: 'ssh', host, path: safePath(p), spec: `ssh:${host}:${p}` };
  }
  if (v.startsWith('unix:')) return { type: 'unix', path: safePath(v.slice(5)), spec: v };
  if (v.startsWith('/')) return { type: 'unix', path: safePath(v), spec: `unix:${v}` };
  return bad('unknown scheme');
}

const describe = (ep) => (ep.type === 'ssh' ? `ssh:${ep.host}:${ep.path}` : ep.type === 'unix' ? `unix:${ep.path}` : 'off');
const sshArgs = (ep) => [
  '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${parseInt(process.env.MIXIN_SSH_CONNECT_TIMEOUT_S || '10', 10)}`,
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ExitOnForwardFailure=yes', '-o', 'ClearAllForwardings=yes',
  '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-W', ep.path, '--', ep.host,
];
const oneLine = (s) => String(s || '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(-200);

const live = new Set();
process.on('exit', () => {
  for (const c of live) { try { c.kill('SIGTERM'); } catch (_) {} }
});

function openChannel(ep) {
  if (ep.type === 'unix') {
    const s = net.createConnection(ep.path);
    let closeFn = () => {};
    let dataFn = () => {};
    let opened = false;
    let pend = [];
    s.on('connect', () => {
      opened = true;
      for (const x of pend) s.write(x);
      pend = [];
    });
    s.on('data', (d) => dataFn(d));
    s.on('error', (e) => closeFn({ code: e.code || 'ECONNREFUSED', msg: `gateway endpoint ${e.code || e.message}` }));
    s.on('end', () => closeFn({ code: 'BAD_RESPONSE', msg: 'gateway endpoint closed without reply' }));
    return {
      _s: s,
      write: (x) => (opened ? s.write(x) : pend.push(x)),
      onData: (f) => { dataFn = f; },
      onClose: (f) => { closeFn = f; },
      close: () => { try { s.destroy(); } catch (_) {} },
    };
  }
  const { spawn } = require('child_process');
  const bin = process.env.MIXIN_SSH_BIN || 'ssh';
  const c = spawn(bin, sshArgs(ep), { stdio: ['pipe', 'pipe', 'pipe'] });
  let closeFn = () => {};
  let dataFn = () => {};
  let err = '';
  c.stdout.on('data', (d) => dataFn(d));
  c.stderr.on('data', (d) => { if (err.length < 4096) err += d; });
  c.stdin.on('error', () => {});
  c.on('error', (e) => closeFn({ code: 'SSH_FAILED', msg: `ssh could not start (${e.code || e.message})` }));
  c.on('close', (code) => {
    const why = oneLine(err);
    if (code === 255 && /channel \d+: open failed|stdio forwarding failed/i.test(why)) {
      closeFn({ code: 'ENDPOINT_DOWN', msg: `gateway endpoint not listening at ${describe(ep)} (gateway down?): ${why}` });
    } else {
      closeFn({
        code: code === 255 ? 'SSH_FAILED' : 'BAD_RESPONSE',
        msg: code === 255 ? `ssh to ${ep.host} failed: ${why || 'exit 255'}` : `gateway endpoint closed without reply (ssh exit ${code})${why ? ': ' + why : ''}`,
      });
    }
  });
  live.add(c);
  c.on('exit', () => live.delete(c));
  return {
    write: (x) => { try { c.stdin.write(x); } catch (_) {} },
    onData: (f) => { dataFn = f; },
    onClose: (f) => { closeFn = f; },
    close: (ok) => {
      try { c.stdin.end(); } catch (_) {}
      if (!ok) { try { c.kill('SIGTERM'); } catch (_) {} return; }
      const t = setTimeout(() => { try { c.kill('SIGTERM'); } catch (_) {} }, 2000);
      if (t.unref) t.unref();
    },
  };
}

function endpointRequest(obj, { endpoint, socketPath, timeoutMs = parseInt(process.env.MIXIN_SEND_ENDPOINT_TIMEOUT_MS || '30000', 10) } = {}) {
  return new Promise((resolve, reject) => {
    let ep;
    try { ep = endpoint || parseEndpoint(socketPath ? '' : undefined, { socketPath }); }
    catch (e) { e.unavailable = true; return reject(e); }
    if (ep.type === 'off') {
      return reject(Object.assign(new Error('gateway send endpoint disabled (MIXIN_SEND_ENDPOINT=0)'), { code: 'ENDPOINT_DISABLED', unavailable: true }));
    }
    let buf = '';
    let settled = false;
    const ch = openChannel(ep);
    const timer = setTimeout(() => fail('ETIMEDOUT', `gateway endpoint timeout (${describe(ep)})`, true), timeoutMs);
    const fail = (code, msg, unavailable, extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const e = Object.assign(new Error(msg), { code, unavailable, retryable: unavailable && RETRYABLE.has(code) });
      if (extra) e.extra = extra;
      ch.close(false);
      reject(e);
    };
    ch.onClose((r) => fail(r.code, r.msg, true));
    ch.onData((d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let r;
      try { r = JSON.parse(buf.slice(0, nl)); } catch (_) { return fail('BAD_RESPONSE', 'gateway endpoint bad response', true); }
      if (r.ok) {
        settled = true;
        clearTimeout(timer);
        ch.close(true);
        return resolve(r.data || {});
      }
      const er = r.error || {};
      const transport = ['NOT_CONNECTED', 'ETIMEDOUT', 'ECONNRESET', 'BAD_REQUEST', 'TOO_LARGE', 'ERROR', 'RECORD_FAILED'].includes(er.code);
      fail(er.code, `code: ${er.code}, description: ${er.description}${er.extra ? ', extra: ' + JSON.stringify(er.extra) : ''}`, transport, er.extra);
    });
    ch.write(JSON.stringify(obj) + '\n');
  });
}

function sendViaEndpoint(params, opts = {}) {
  return endpointRequest({ action: 'CREATE_MESSAGE', params }, opts);
}

function recordViaEndpoint(items, opts = {}) {
  return endpointRequest({ action: 'RECORD', items }, { timeoutMs: 15000, ...opts });
}

module.exports = {
  markerPath, defaultSocketPath, parseEndpoint, describe, sshArgs,
  openChannel, endpointRequest, sendViaEndpoint, recordViaEndpoint, RETRYABLE,
};
