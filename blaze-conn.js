'use strict';
// Single Blaze WebSocket manager per bot session (a second concurrent session triggers 1006).
// Every reconnect creates a fresh socket object and requires a LIST_PENDING_MESSAGES reply.
const { randomUUID } = require('crypto');
const pako = require('pako');
const { websocket, sendRaw } = require('@mixin.dev/mixin-node-sdk/blaze');
const { createAckDispatcher } = require('./blaze-ack');
function createBlazeConn({
  keystore, handler, log, onDead, url = 'wss://blaze.mixin.one',
  checkMs = 20000, staleMs = 75000, probeTimeoutMs = 15000, recycleMs = 600000, deadMs = 120000, pingTimeoutMs = 30000,
  clientPingMs = 9000, pongWaitMs = 15000, ackConfirmMs = 10000,
  tickMs = 1000, heartbeatMs = 300000, suspendGapMs = 10000, openTimeoutMs = 30000, handlerTimeoutMs = 30000, ackHttpTimeoutMs = 20000,
  wsOptions = { parse: false, syncAck: false }, apiConfig = null, ackFlushMs = 5000,
  backoffBaseMs = 1000, backoffMaxMs = 60000, backoffJitter = 0.5, backoffResetMs = 120000, random = Math.random,
  authFailLimit = 3, onAuthFailed = null, onAuthOk = null, onReconnect = null, initialDownSince = null,
}) {
  const jitter = Math.min(1, Math.max(0, Number(backoffJitter) || 0));
  const capLimit = Math.max(backoffBaseMs, Math.floor(deadMs / 2));
  const maxBackoff = Math.min(Math.max(backoffBaseMs, backoffMaxMs), capLimit);
  if (backoffMaxMs > capLimit) log(`WARN blaze backoff cap ${backoffMaxMs}ms > deadMs/2; using ${maxBackoff}ms`);
  let gen = 0;
  let cur = null;
  let stopped = false;
  let reconnectTimer = null;
  let backoff = backoffBaseMs;
  let authFails = 0;
  let firstAuthFailAt = null;
  let lastAuthError = null;
  let paused = false;
  let downSince = Number.isFinite(initialDownSince) ? initialDownSince : null;
  let downReason = downSince != null ? 'restart' : null;
  let lastOpenAt = Date.now();
  const requests = new Map();
  const ack = createAckDispatcher({ keystore, handler, log, wsOptions, apiConfig, handlerTimeoutMs, ackConfirmMs, ackHttpTimeoutMs, ackFlushMs });
  const { pendingAcks, httpAckQueue, dispatch } = ack;
  const safe = (fn, what, ...a) => {
    if (typeof fn !== 'function') return;
    try { fn(...a); } catch (e) { log(`WARN ${what} callback err=${e.message}`); }
  };
  function authOk(c) {
    if (c.authOk) return;
    c.authOk = true;
    if (authFails) log(`blaze auth ok gen=${c.gen} (auth failure counter ${authFails} reset)`);
    authFails = 0;
    firstAuthFailAt = null;
    lastAuthError = null;
    safe(onAuthOk, 'onAuthOk', { gen: c.gen });
    if (downSince != null) {
      const now = Date.now();
      const info = { offline_ms: Math.max(0, now - downSince), since: downSince, at: now, reason: downReason, gen: c.gen };
      downSince = null;
      downReason = null;
      safe(onReconnect, 'onReconnect', info);
    }
  }
  const jittered = (ms) => Math.max(0, Math.round(ms * (1 - jitter + 2 * jitter * random())));
  const age = (t) => Math.round((Date.now() - t) / 1000);
  function probe(c, why) {
    const id = randomUUID();
    c.probes.set(id, Date.now());
    if (why !== 'periodic') log(`blaze LIST_PENDING sent gen=${c.gen} id=${id} (${why})`);
    sendRaw(c.ws, { id, action: 'LIST_PENDING_MESSAGES' }).then((ok) => {
      if (!ok) log(`blaze LIST_PENDING send failed gen=${c.gen}`);
    });
  }
  function connect() {
    reconnectTimer = null;
    if (stopped || paused) return;
    const now = Date.now();
    const c = {
      gen: ++gen, ws: null, probes: new Map(), msgs: 0, open: false, openedAt: 0, dead: false,
      lastFrame: now, lastPong: now, lastServerPing: now, lastClientPing: now, lastProbe: now, createdAt: now,
    };
    cur = c;
    try {
      c.ws = websocket(keystore, url, handler, wsOptions);
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 120);
      log(`blaze connect failed gen=${c.gen} err=${msg}`);
      c.authFail = `invalid keystore/JWT (${msg})`;
      return drop(c, 'connect error');
    }
    c.ws.onmessage = null;
    c.ws.on('pong', () => { c.lastPong = Date.now(); });
    c.ws.on('ping', () => { c.lastServerPing = Date.now(); });
    c.ws.on('open', () => {
      if (c !== cur) return;
      c.open = true;
      c.openedAt = lastOpenAt = c.lastFrame = c.lastPong = c.lastServerPing = c.lastProbe = Date.now();
      log(`blaze connected gen=${c.gen}`);
      probe(c, 'on-open');
    });
    c.ws.on('message', (data) => {
      c.lastFrame = Date.now();
      try {
        const m = JSON.parse(pako.ungzip(data, { to: 'string' }));
        if (m.error && Number(m.error.code) === 401) {
          c.authFail = `blaze ${m.action || '-'} error code=401`;
          log(`blaze AUTH error gen=${c.gen} action=${m.action || '-'} code=401 status=${m.error.status != null ? m.error.status : '-'}`);
          return drop(c, 'auth error 401');
        }
        if (m.id && c.probes.has(m.id)) {
          c.probes.delete(m.id);
          if (m.error) log(`blaze LIST_PENDING error gen=${c.gen} code=${m.error.code}`);
          else authOk(c);
          return;
        }
        if (m.id && requests.has(m.id)) {
          const r = requests.get(m.id);
          requests.delete(m.id);
          clearTimeout(r.timer);
          r.resolve(m);
          return;
        }
        if (m.id && pendingAcks.has(m.id)) {
          pendingAcks.delete(m.id);
          return;
        }
        if (m.action === 'CREATE_MESSAGE') {
          c.msgs++;
          authOk(c);
        }
      } catch (_) {}
      dispatch(c, data);
    });
    c.ws.on('close', (code) => { log(`blaze closed gen=${c.gen} code=${code} msgs=${c.msgs}`); drop(c, `close ${code}`); });
    c.ws.on('error', (e) => { log(`blaze error gen=${c.gen} code=${e && e.code ? e.code : '-'} ${e && e.message}`); drop(c, 'error'); });
    c.ws.on('unexpected-response', (_q, r) => {
      log(`blaze unexpected-response gen=${c.gen} status=${r.statusCode}`);
      if (r.statusCode === 401 || r.statusCode === 403) {
        c.authFail = `blaze upgrade HTTP ${r.statusCode}`;
        drop(c, `auth HTTP ${r.statusCode}`);
      }
    });
  }
  function drop(c, why, delay) {
    if (c.dead) return;
    c.dead = true;
    if (c.open) lastOpenAt = Date.now();
    if (downSince == null && c === cur && !stopped) {
      downSince = c.open ? Date.now() : c.createdAt;
      downReason = why;
    }
    for (const [id, r] of requests) {
      if (r.gen === c.gen) {
        requests.delete(id);
        clearTimeout(r.timer);
        r.reject(Object.assign(new Error(`blaze connection lost (${why})`), { code: 'ECONNRESET' }));
      }
    }
    try { c.ws.removeAllListeners('message'); } catch (_) {}
    try { c.ws.onmessage = null; c.ws.terminate(); } catch (_) {}
    if (c !== cur || stopped) return;
    cur = null;
    if (c.authFail) {
      if (!authFails) firstAuthFailAt = Date.now();
      authFails++;
      lastAuthError = c.authFail;
      log(`blaze auth failure ${authFails}/${authFailLimit} gen=${c.gen} (${c.authFail})`);
      if (authFailLimit > 0 && authFails >= authFailLimit) {
        paused = true;
        log(`AUTH circuit open: ${authFails} consecutive auth failures, last=${lastAuthError}; Blaze reconnect PAUSED (process stays up; fix the keystore/session, then restart the service)`);
        safe(onAuthFailed, 'onAuthFailed', { failures: authFails, last_error: lastAuthError, since: firstAuthFailAt, gen: c.gen });
        return;
      }
    }
    const d = delay != null ? delay : Math.max(Math.round(backoffBaseMs / 2), Math.min(jittered(backoff), deadMs - (Date.now() - lastOpenAt) - 5000));
    if (delay == null) backoff = Math.min(maxBackoff, backoff * 2);
    log(`blaze recreate in ${d}ms (gen=${c.gen} ${why})`);
    reconnectTimer = setTimeout(connect, d);
  }
  let lastTick = Date.now();
  let lastHeartbeat = Date.now();
  function tick() {
    if (stopped) return;
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    const c = cur;
    if (paused) {
      if (gap > suspendGapMs) log(`WATCHDOG tick gap ${Math.round(gap / 1000)}s (process/VM suspended or event loop blocked) gen=- paused=auth_failed`);
      if (now - lastHeartbeat >= heartbeatMs) {
        lastHeartbeat = now;
        log(`heartbeat gen=- open=false paused=auth_failed auth_failures=${authFails} pendingAcks=${pendingAcks.size} httpAckQueue=${httpAckQueue.size}`);
      }
      return;
    }
    if (gap > suspendGapMs) {
      if (downSince == null) { downSince = now - gap; downReason = 'resume after suspend'; }
      log(`WATCHDOG tick gap ${Math.round(gap / 1000)}s (process/VM suspended or event loop blocked) gen=${c ? c.gen : '-'}`);
      lastOpenAt = Math.min(now, lastOpenAt + gap);
      if (c) return drop(c, 'resume after suspend', 0);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        log('blaze reconnect now (resume after suspend, backoff wait cancelled)');
        connect();
        return;
      }
    }
    if (now - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = now;
      log(`heartbeat gen=${c ? c.gen : '-'} open=${!!(c && c.open)} lastFrame=${c ? age(c.lastFrame) : '-'}s lastPong=${c ? age(c.lastPong) : '-'}s lastServerPing=${c ? age(c.lastServerPing) : '-'}s msgs=${c ? c.msgs : 0} pendingAcks=${pendingAcks.size} httpAckQueue=${httpAckQueue.size}`);
    }
    if (!c || !c.open) {
      if (c && !c.dead && now - c.createdAt > openTimeoutMs) { log(`WATCHDOG gen=${c.gen} not open after ${age(c.createdAt)}s`); return drop(c, 'open timeout', 0); }
      if (now - lastOpenAt > deadMs) { stopped = true; log(`WATCHDOG blaze dead: no OPEN socket for ${age(lastOpenAt)}s`); onDead(); }
      return;
    }
    if (c.dead) return;
    lastOpenAt = now;
    if (backoff !== backoffBaseMs && now - c.openedAt >= backoffResetMs) backoff = backoffBaseMs;
    const lastAlive = Math.max(c.lastPong, c.lastFrame);
    if (now - lastAlive > pongWaitMs) { log(`WATCHDOG gen=${c.gen} no pong/frame ${age(lastAlive)}s`); return drop(c, 'pong timeout', 0); }
    if (now - c.lastServerPing > pingTimeoutMs) { log(`WATCHDOG gen=${c.gen} no server ping ${age(c.lastServerPing)}s`); return drop(c, 'no server ping', 0); }
    for (const [id, t] of c.probes) {
      if (now - t > probeTimeoutMs) { log(`WATCHDOG gen=${c.gen} LIST_PENDING ${id} unanswered ${age(t)}s`); return drop(c, 'probe timeout', 0); }
    }
    if (now - c.lastFrame > staleMs) { log(`WATCHDOG gen=${c.gen} no frame for ${age(c.lastFrame)}s`); return drop(c, 'stale', 0); }
    if (recycleMs > 0 && now - c.openedAt > recycleMs) return drop(c, 'periodic recycle', 0);
    if (now - c.lastClientPing >= clientPingMs) { c.lastClientPing = now; try { c.ws.ping(); } catch (_) {} }
    if (now - c.lastProbe >= checkMs) { c.lastProbe = now; probe(c, 'periodic'); }
  }
  const timer = setInterval(tick, tickMs);
  async function send(action, params, { waitOpenMs = 10000, timeoutMs = 15000 } = {}) {
    const t0 = Date.now();
    while (!(cur && cur.open && !cur.dead && cur.ws.readyState === 1)) {
      if (stopped || paused || Date.now() - t0 >= waitOpenMs) {
        throw Object.assign(new Error(`blaze not connected (waited ${Date.now() - t0}ms)`), { code: 'NOT_CONNECTED' });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const c = cur;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        requests.delete(id);
        reject(Object.assign(new Error('blaze reply timeout'), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      requests.set(id, { gen: c.gen, resolve, reject, timer: t });
      try {
        c.ws.send(pako.gzip(Buffer.from(JSON.stringify({ id, action, params }))));
      } catch (err) {
        clearTimeout(t);
        requests.delete(id);
        reject(Object.assign(new Error(`blaze send failed ${err.message}`), { code: 'ECONNRESET' }));
      }
    });
  }
  return {
    start: connect,
    current: () => cur,
    _tick: tick,
    send,
    _shiftClock: (ms) => {
      lastTick -= ms;
      lastOpenAt -= ms;
      if (cur) { cur.lastFrame -= ms; cur.lastPong -= ms; cur.lastServerPing -= ms; }
    },
    _lastOpenAt: () => lastOpenAt,
    _backoff: () => backoff,
    _config: () => ({ maxBackoff, backoffResetMs, deadMs }),
    paused: () => paused,
    authFailures: () => authFails,
    _downSince: () => downSince,
    forceClose: () => { if (cur) cur.ws.terminate(); },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      ack.stop();
      clearTimeout(reconnectTimer);
      for (const [, r] of requests) {
        clearTimeout(r.timer);
        r.reject(Object.assign(new Error('stopped'), { code: 'NOT_CONNECTED' }));
      }
      requests.clear();
      if (cur) { try { cur.ws.terminate(); } catch (_) {} }
    },
  };
}
module.exports = { createBlazeConn };
