'use strict';
// Own Blaze connection manager (replaces SDK BlazeKeystoreClient.loop + its auto-reconnect).
// Why: after the SDK's in-place reconnect (close 1006 -> new socket), delivery could stall for 20+ min while
// frames (server pings, replies to our own LIST_PENDING probes) still arrived, so the old watchdog never fired.
// Here every connection is a brand-new socket object with its own handlers and its own liveness state:
//   - on open: send LIST_PENDING_MESSAGES on THAT socket (logged with gen + id) and require its reply.
//   - on any close/error/stale: terminate that socket, recreate a fresh one after a short backoff.
//   - every RECYCLE_MS (default 10 min): proactive full recreate (pending msgs are redelivered; ACK+dedupe).
//   - every CHECK_MS: ping + LIST_PENDING on the current socket; if the reply to a probe sent on the current
//     socket doesn't arrive within PROBE_TIMEOUT_MS, or nothing arrives for STALE_MS -> recreate.
//   - if no socket has been OPEN for DEAD_MS -> onDead (process exits, run.sh restarts). DEAD_MS counts from the moment
//     the last socket stopped being OPEN (lastOpenAt is refreshed on every tick while open and on drop), not from its open.
//   - send(action, params): request on the CURRENT socket (used by send-endpoint.js for reply.js), reply matched by id.
// Liveness (pong/frame, server ping, probe, stale, recycle, open timeout, suspend gap, heartbeat log) is driven by
// ONE setInterval tick comparing Date.now() against per-socket timestamps, so frozen time is caught on resume.
// Probe replies are matched by request id; CREATE_MESSAGE frames are counted separately. No content is logged.
// 2026-10-19 additions (all additive; defaults keep the old behaviour except that auth failures now stop):
//   - Auth circuit breaker: a connection attempt that fails authentication (Blaze ERROR frame code 401 "Unauthorized,
//     maybe invalid token." which the server sends right after the upgrade and then closes 1006; an HTTP 401/403 upgrade
//     response; or websocket()/JWT signing throwing on an invalid keystore) counts as one auth failure. After
//     authFailLimit (3) CONSECUTIVE ones (network errors neither count nor reset; a successful LIST_PENDING reply resets)
//     reconnecting is PAUSED for good: no new sockets, no deadMs exit (so systemd does not restart-loop and Mixin is not
//     hammered), onAuthFailed({failures, last_error, since}) is called once, the tick keeps running and keeps logging
//     `heartbeat … paused=auth_failed`. Resume = fix the credentials and restart the process.
//   - Outage tracking: downSince = when the last socket stopped being OPEN (or the freeze start on a tick gap, or
//     initialDownSince for the time before this process started). On the first successful LIST_PENDING reply after
//     that, onReconnect({offline_ms, since, at, reason, gen}) is called (also for short recycles; the caller filters).
const { randomUUID } = require('crypto');
const pako = require('pako');
const { websocket, sendRaw, decodeMessage } = require('@mixin.dev/mixin-node-sdk/blaze');
const { MixinApi } = require('@mixin.dev/mixin-node-sdk');

function createBlazeConn({ keystore, handler, log, onDead, url = 'wss://blaze.mixin.one',
  checkMs = 20000, staleMs = 75000, probeTimeoutMs = 15000, recycleMs = 600000, deadMs = 120000, pingTimeoutMs = 30000,
  clientPingMs = 9000, pongWaitMs = 15000, ackConfirmMs = 10000,
  tickMs = 1000, heartbeatMs = 300000, suspendGapMs = 10000, openTimeoutMs = 30000, handlerTimeoutMs = 30000, ackHttpTimeoutMs = 20000,
  wsOptions = { parse: false, syncAck: false },
  apiConfig = null, ackFlushMs = 5000,
  // Reconnect backoff (references: mixin-builder blaze.md "Reconnect doctrine"): base*2^n up to maxMs, each wait
  // multiplied by a random factor in [1-jitter, 1+jitter], reset to base only after a socket stayed OPEN for resetMs.
  // Only failed/closed connections use it: watchdog drops, recycles and resume-after-suspend reconnect immediately.
  backoffBaseMs = 1000, backoffMaxMs = 60000, backoffJitter = 0.5, backoffResetMs = 120000, random = Math.random,
  authFailLimit = 3, onAuthFailed = null, onAuthOk = null, onReconnect = null, initialDownSince = null }) { // apiConfig: optional SDK requestConfig (e.g. {baseURL}) for HTTP ACK; tests only
  const jitter = Math.min(1, Math.max(0, Number(backoffJitter) || 0));
  // Cap <= deadMs/2: every deadMs outage window gets >= 2 attempts, and a long cap (e.g. 300s) can't create a gap the
  // watchdog would turn into a restart anyway (each wait is also clamped to the remaining deadMs window, see drop()).
  const capLimit = Math.max(backoffBaseMs, Math.floor(deadMs / 2));
  const maxBackoff = Math.min(Math.max(backoffBaseMs, backoffMaxMs), capLimit);
  if (backoffMaxMs > capLimit) log(`WARN blaze backoff cap ${backoffMaxMs}ms > deadMs/2; using ${maxBackoff}ms`);
  let gen = 0, cur = null, stopped = false, reconnectTimer = null, backoff = backoffBaseMs;
  let authFails = 0, firstAuthFailAt = null, lastAuthError = null, paused = false; // auth circuit breaker
  let downSince = Number.isFinite(initialDownSince) ? initialDownSince : null, downReason = downSince != null ? 'restart' : null;
  const safe = (fn, what, ...a) => { if (typeof fn !== 'function') return; try { fn(...a); } catch (e) { log(`WARN ${what} callback err=${e.message}`); } };
  function authOk(c) { // a reply proves the credentials work: reset the breaker, close an open outage
    if (c.authOk) return;
    c.authOk = true;
    if (authFails) log(`blaze auth ok gen=${c.gen} (auth failure counter ${authFails} reset)`);
    authFails = 0; firstAuthFailAt = null; lastAuthError = null;
    safe(onAuthOk, 'onAuthOk', { gen: c.gen });
    if (downSince != null) {
      const now = Date.now(), info = { offline_ms: Math.max(0, now - downSince), since: downSince, at: now, reason: downReason, gen: c.gen };
      downSince = null; downReason = null;
      safe(onReconnect, 'onReconnect', info);
    }
  }
  const jittered = (ms) => Math.max(0, Math.round(ms * (1 - jitter + 2 * jitter * random())));
  let lastOpenAt = Date.now(); // last moment a socket was known OPEN (refreshed every tick while open, and on drop)
  const requests = new Map(); // request id -> { gen, resolve, reject, timer } for send()
  const withTimeout = (p, ms, what) => {
    if (!p || typeof p.then !== 'function') return Promise.resolve(p);
    let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timeout ${ms}ms`)), ms); })]).finally(() => clearTimeout(t));
  };
  const age = (t) => Math.round((Date.now() - t) / 1000);

  function probe(c, why) {
    const id = randomUUID();
    c.probes.set(id, Date.now());
    if (why !== 'periodic') log(`blaze LIST_PENDING sent gen=${c.gen} id=${id} (${why})`);
    sendRaw(c.ws, { id, action: 'LIST_PENDING_MESSAGES' }).then((ok) => { if (!ok) log(`blaze LIST_PENDING send failed gen=${c.gen}`); });
  }

  function connect() {
    reconnectTimer = null;
    if (stopped || paused) return;
    const c = { gen: ++gen, ws: null, probes: new Map(), lastFrame: Date.now(), msgs: 0, open: false, openedAt: 0, dead: false };
    cur = c;
    c.lastPong = c.lastServerPing = c.lastClientPing = c.lastProbe = c.createdAt = Date.now();
    try { c.ws = websocket(keystore, url, handler, wsOptions); } // SDK only builds the socket (UA/JWT/subprotocol)
    catch (e) { // invalid keystore / JWT signing failed: counts as an auth failure (never logs key material)
      const msg = String(e && e.message || e).slice(0, 120);
      log(`blaze connect failed gen=${c.gen} err=${msg}`);
      c.authFail = `invalid keystore/JWT (${msg})`;
      return drop(c, 'connect error');
    }
    c.ws.onmessage = null; // we decode, dispatch and ACK ourselves (official Go client order: handle, then ACK READ)
    c.lastPong = c.lastServerPing = c.lastClientPing = c.lastProbe = c.createdAt = Date.now();
    c.ws.on('pong', () => { c.lastPong = Date.now(); });
    // All liveness checks are driven by the single tick() below (wall-clock based), not per-socket timers.
    c.ws.on('ping', () => { c.lastServerPing = Date.now(); });
    c.ws.on('open', () => {
      if (c !== cur) return;
      c.open = true; c.openedAt = lastOpenAt = c.lastFrame = c.lastPong = c.lastServerPing = c.lastProbe = Date.now(); // backoff resets in tick() once stable
      log(`blaze connected gen=${c.gen}`);
      probe(c, 'on-open');
    });
    c.ws.on('message', (data) => {
      c.lastFrame = Date.now();
      try {
        const m = JSON.parse(pako.ungzip(data, { to: 'string' }));
        if (m.error && Number(m.error.code) === 401) { // e.g. {"action":"ERROR","error":{"status":202,"code":401,...}}
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
        if (m.id && requests.has(m.id)) { const r = requests.get(m.id); requests.delete(m.id); clearTimeout(r.timer); r.resolve(m); return; } // reply to send()
        if (m.id && pendingAcks.has(m.id)) { pendingAcks.delete(m.id); return; } // ACK confirmed by server
        if (m.action === 'CREATE_MESSAGE') { c.msgs++; authOk(c); }
      } catch (_) {}
      dispatch(c, data);
    });
    c.ws.on('close', (code) => { log(`blaze closed gen=${c.gen} code=${code} msgs=${c.msgs}`); drop(c, `close ${code}`); });
    c.ws.on('error', (e) => { log(`blaze error gen=${c.gen} code=${e && e.code ? e.code : '-'} ${e && e.message}`); drop(c, 'error'); });
    c.ws.on('unexpected-response', (_q, r) => {
      log(`blaze unexpected-response gen=${c.gen} status=${r.statusCode}`);
      if (r.statusCode === 401 || r.statusCode === 403) { c.authFail = `blaze upgrade HTTP ${r.statusCode}`; drop(c, `auth HTTP ${r.statusCode}`); }
    });
  }

  function drop(c, why, delay) {
    if (c.dead) return;
    c.dead = true;
    if (c.open) lastOpenAt = Date.now(); // it was OPEN until now: the deadMs outage window starts here
    if (downSince == null && c === cur && !stopped) { downSince = c.open ? Date.now() : c.createdAt; downReason = why; }
    for (const [id, r] of requests) if (r.gen === c.gen) { requests.delete(id); clearTimeout(r.timer); const e = new Error(`blaze connection lost (${why})`); e.code = 'ECONNRESET'; r.reject(e); }
    try { c.ws.removeAllListeners('message'); } catch (_) {}
    try { c.ws.onmessage = null; c.ws.terminate(); } catch (_) {}
    if (c !== cur || stopped) return;
    cur = null;
    if (c.authFail) {
      if (!authFails) firstAuthFailAt = Date.now();
      authFails++; lastAuthError = c.authFail;
      log(`blaze auth failure ${authFails}/${authFailLimit} gen=${c.gen} (${c.authFail})`);
      if (authFailLimit > 0 && authFails >= authFailLimit) {
        paused = true;
        log(`AUTH circuit open: ${authFails} consecutive auth failures, last=${lastAuthError}; Blaze reconnect PAUSED (process stays up; fix the keystore/session, then restart the service)`);
        safe(onAuthFailed, 'onAuthFailed', { failures: authFails, last_error: lastAuthError, since: firstAuthFailAt, gen: c.gen });
        return;
      }
    }
    // A backoff wait never runs past the deadMs outage limit: the last attempt happens ~5s before onDead would fire.
    const d = delay != null ? delay : Math.max(Math.round(backoffBaseMs / 2), Math.min(jittered(backoff), deadMs - (Date.now() - lastOpenAt) - 5000));
    if (delay == null) backoff = Math.min(maxBackoff, backoff * 2); // only failures grow the backoff
    log(`blaze recreate in ${d}ms (gen=${c.gen} ${why})`);
    reconnectTimer = setTimeout(connect, d);
  }

  // ---- ACK: per-message over Blaze, confirmed by reply id; unconfirmed ones fall back to
  // POST /acknowledgements (official bulk API, <=100 per call). Unacked messages are re-pushed by Mixin anyway.
  const pendingAcks = new Map(); // request id -> { message_id, t }
  const httpAckQueue = new Set();
  let api = null;
  async function dispatch(c, data) {
    let msg;
    try { msg = decodeMessage(data, wsOptions); } catch (_) { return; }
    if (!msg) return;
    try {
      if (msg.source === 'ACKNOWLEDGE_MESSAGE_RECEIPT') { if (handler.onAckReceipt) await withTimeout(handler.onAckReceipt(msg), handlerTimeoutMs, 'ack handler'); return; }
      if (msg.category === 'SYSTEM_CONVERSATION' && handler.onConversation) await withTimeout(handler.onConversation(msg), handlerTimeoutMs, 'handler');
      else if (msg.category === 'SYSTEM_ACCOUNT_SNAPSHOT' && handler.onTransfer) await withTimeout(handler.onTransfer(msg), handlerTimeoutMs, 'handler');
      else await withTimeout(handler.onMessage(msg), handlerTimeoutMs, 'handler');
    } catch (e) { log(`handler error ${e.message}`); }
    if (!msg.message_id) return;
    const id = randomUUID();
    pendingAcks.set(id, { message_id: msg.message_id, t: Date.now() });
    const ok = !c.dead && await sendRaw(c.ws, { id, action: 'ACKNOWLEDGE_MESSAGE_RECEIPT', params: { message_id: msg.message_id, status: 'READ' } });
    if (!ok) { pendingAcks.delete(id); httpAckQueue.add(msg.message_id); }
  }
  let ackInFlight = false;
  async function flushAcks() {
    if (ackInFlight) return;
    ackInFlight = true;
    try { await flushAcksInner(); } finally { ackInFlight = false; }
  }
  async function flushAcksInner() {
    for (const [id, a] of pendingAcks) if (Date.now() - a.t > ackConfirmMs) { pendingAcks.delete(id); httpAckQueue.add(a.message_id); }
    if (!httpAckQueue.size) return;
    const batch = [...httpAckQueue].slice(0, 100);
    try {
      api = api || MixinApi(apiConfig ? { keystore, requestConfig: apiConfig } : { keystore });
      await withTimeout(api.message.sendAcknowledges(batch.map((message_id) => ({ message_id, status: 'READ' }))), ackHttpTimeoutMs, 'ack HTTP');
      batch.forEach((x) => httpAckQueue.delete(x));
      log(`ack via HTTP count=${batch.length}`);
    } catch (e) { log(`ack via HTTP failed count=${batch.length} err=${e.message}`); }
  }
  const ackTimer = setInterval(() => { flushAcks().catch(() => {}); }, ackFlushMs);

  // Single wall-clock tick drives every liveness check. Node timers run on the monotonic clock, which does
  // not advance while the process/VM is frozen; comparing Date.now() against timestamps means that a suspend
  // is noticed on the very first tick after resume (tick gap), and nothing depends on a per-gen timer being armed.
  let lastTick = Date.now(), lastHeartbeat = Date.now(), ticks = 0;
  function tick() {
    if (stopped) return;
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now; ticks++;
    const c = cur;
    if (paused) { // auth circuit open: no reconnect, no deadMs exit; keep logging heartbeats so the outage is visible
      if (gap > suspendGapMs) log(`WATCHDOG tick gap ${Math.round(gap / 1000)}s (process/VM suspended or event loop blocked) gen=- paused=auth_failed`);
      if (now - lastHeartbeat >= heartbeatMs) { lastHeartbeat = now; log(`heartbeat gen=- open=false paused=auth_failed auth_failures=${authFails} pendingAcks=${pendingAcks.size} httpAckQueue=${httpAckQueue.size}`); }
      return;
    }
    if (gap > suspendGapMs) {
      if (downSince == null) { downSince = now - gap; downReason = 'resume after suspend'; } // outage = the frozen time
      log(`WATCHDOG tick gap ${Math.round(gap / 1000)}s (process/VM suspended or event loop blocked) gen=${c ? c.gen : '-'}`);
      lastOpenAt = Math.min(now, lastOpenAt + gap); // don't count frozen time toward deadMs; reconnect instead
      if (c) return drop(c, 'resume after suspend', 0);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; log('blaze reconnect now (resume after suspend, backoff wait cancelled)'); connect(); return; }
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
    lastOpenAt = now; // healthy OPEN socket: an outage can only start after this tick
    if (backoff !== backoffBaseMs && now - c.openedAt >= backoffResetMs) backoff = backoffBaseMs; // stable -> reset backoff
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

  // Send one request (e.g. CREATE_MESSAGE) on the current OPEN socket and resolve with the server's reply frame
  // ({id, action, data} or {id, action, error}). Waits up to waitOpenMs for a (re)connect; rejects NOT_CONNECTED /
  // ETIMEDOUT / ECONNRESET (socket dropped before the reply). No content is logged.
  async function send(action, params, { waitOpenMs = 10000, timeoutMs = 15000 } = {}) {
    const t0 = Date.now();
    while (!(cur && cur.open && !cur.dead && cur.ws.readyState === 1)) {
      if (stopped || paused || Date.now() - t0 >= waitOpenMs) { const e = new Error(`blaze not connected (waited ${Date.now() - t0}ms)`); e.code = 'NOT_CONNECTED'; throw e; }
      await new Promise((r) => setTimeout(r, 100));
    }
    const c = cur, id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); const e = new Error('blaze reply timeout'); e.code = 'ETIMEDOUT'; reject(e); }, timeoutMs);
      requests.set(id, { gen: c.gen, resolve, reject, timer });
      try { c.ws.send(pako.gzip(Buffer.from(JSON.stringify({ id, action, params })))); }
      catch (err) { clearTimeout(timer); requests.delete(id); const e = new Error(`blaze send failed ${err.message}`); e.code = 'ECONNRESET'; reject(e); }
    });
  }

  return {
    start: connect,
    current: () => cur,
    _tick: tick, // test hook
    send,
    _shiftClock: (ms) => { lastTick -= ms; lastOpenAt -= ms; if (cur) { cur.lastFrame -= ms; cur.lastPong -= ms; cur.lastServerPing -= ms; } }, // test hook: simulate frozen time (all wall-clock stamps age)
    _lastOpenAt: () => lastOpenAt, // test hook
    _backoff: () => backoff, // test hook
    _config: () => ({ maxBackoff, backoffResetMs, deadMs }), // test hook
    paused: () => paused, // auth circuit open
    authFailures: () => authFails,
    _downSince: () => downSince, // test hook
    forceClose: () => { if (cur) cur.ws.terminate(); }, // test hook: simulate 1006
    stop: () => { stopped = true; clearInterval(timer); clearInterval(ackTimer); clearTimeout(reconnectTimer); for (const [, r] of requests) { clearTimeout(r.timer); r.reject(Object.assign(new Error('stopped'), { code: 'NOT_CONNECTED' })); } requests.clear(); if (cur) { try { cur.ws.terminate(); } catch (_) {} } },
  };
}
module.exports = { createBlazeConn };
