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
//   - if no socket reaches OPEN for DEAD_MS -> onDead (process exits, run.sh restarts).
// Liveness (pong/frame, server ping, probe, stale, recycle, open timeout, suspend gap, heartbeat log) is driven by
// ONE setInterval tick comparing Date.now() against per-socket timestamps, so frozen time is caught on resume.
// Probe replies are matched by request id; CREATE_MESSAGE frames are counted separately. No content is logged.
const { randomUUID } = require('crypto');
const pako = require('pako');
const { websocket, sendRaw, decodeMessage } = require('@mixin.dev/mixin-node-sdk/blaze');
const { MixinApi } = require('@mixin.dev/mixin-node-sdk');

function createBlazeConn({ keystore, handler, log, onDead, url = 'wss://blaze.mixin.one',
  checkMs = 20000, staleMs = 75000, probeTimeoutMs = 15000, recycleMs = 600000, deadMs = 120000, pingTimeoutMs = 30000,
  clientPingMs = 9000, pongWaitMs = 15000, ackConfirmMs = 10000,
  tickMs = 1000, heartbeatMs = 300000, suspendGapMs = 10000, openTimeoutMs = 30000, handlerTimeoutMs = 30000, ackHttpTimeoutMs = 20000,
  wsOptions = { parse: false, syncAck: false } }) {
  let gen = 0, cur = null, stopped = false, reconnectTimer = null, backoff = 1000;
  let lastOpenAt = Date.now();
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
    if (stopped) return;
    const c = { gen: ++gen, ws: null, probes: new Map(), lastFrame: Date.now(), msgs: 0, open: false, openedAt: 0, dead: false };
    cur = c;
    c.ws = websocket(keystore, url, handler, wsOptions); // SDK only builds the socket (UA/JWT/subprotocol)
    c.ws.onmessage = null; // we decode, dispatch and ACK ourselves (official Go client order: handle, then ACK READ)
    c.lastPong = c.lastServerPing = c.lastClientPing = c.lastProbe = c.createdAt = Date.now();
    c.ws.on('pong', () => { c.lastPong = Date.now(); });
    // All liveness checks are driven by the single tick() below (wall-clock based), not per-socket timers.
    c.ws.on('ping', () => { c.lastServerPing = Date.now(); });
    c.ws.on('open', () => {
      if (c !== cur) return;
      c.open = true; c.openedAt = lastOpenAt = c.lastFrame = c.lastPong = c.lastServerPing = c.lastProbe = Date.now(); backoff = 1000;
      log(`blaze connected gen=${c.gen}`);
      probe(c, 'on-open');
    });
    c.ws.on('message', (data) => {
      c.lastFrame = Date.now();
      try {
        const m = JSON.parse(pako.ungzip(data, { to: 'string' }));
        if (m.id && c.probes.has(m.id)) {
          c.probes.delete(m.id);
          if (m.error) log(`blaze LIST_PENDING error gen=${c.gen} code=${m.error.code}`);
          return;
        }
        if (m.id && pendingAcks.has(m.id)) { pendingAcks.delete(m.id); return; } // ACK confirmed by server
        if (m.action === 'CREATE_MESSAGE') c.msgs++;
      } catch (_) {}
      dispatch(c, data);
    });
    c.ws.on('close', (code) => { log(`blaze closed gen=${c.gen} code=${code} msgs=${c.msgs}`); drop(c, `close ${code}`); });
    c.ws.on('error', (e) => { log(`blaze error gen=${c.gen} code=${e && e.code ? e.code : '-'} ${e && e.message}`); drop(c, 'error'); });
    c.ws.on('unexpected-response', (_q, r) => log(`blaze unexpected-response gen=${c.gen} status=${r.statusCode}`));
  }

  function drop(c, why, delay) {
    if (c.dead) return;
    c.dead = true;
    try { c.ws.removeAllListeners('message'); } catch (_) {}
    try { c.ws.onmessage = null; c.ws.terminate(); } catch (_) {}
    if (c !== cur || stopped) return;
    cur = null;
    const d = delay != null ? delay : backoff;
    backoff = Math.min(30000, backoff * 2);
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
      api = api || MixinApi({ keystore });
      await withTimeout(api.message.sendAcknowledges(batch.map((message_id) => ({ message_id, status: 'READ' }))), ackHttpTimeoutMs, 'ack HTTP');
      batch.forEach((x) => httpAckQueue.delete(x));
      log(`ack via HTTP count=${batch.length}`);
    } catch (e) { log(`ack via HTTP failed count=${batch.length} err=${e.message}`); }
  }
  const ackTimer = setInterval(() => { flushAcks().catch(() => {}); }, 5000);

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
    if (gap > suspendGapMs) {
      log(`WATCHDOG tick gap ${Math.round(gap / 1000)}s (process/VM suspended or event loop blocked) gen=${c ? c.gen : '-'}`);
      lastOpenAt = Math.max(lastOpenAt, now - gap); // don't count frozen time toward deadMs; reconnect instead
      if (c) return drop(c, 'resume after suspend', 0);
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

  return {
    start: connect,
    current: () => cur,
    _tick: tick, // test hook
    _shiftClock: (ms) => { lastTick -= ms; if (cur) { cur.lastFrame -= ms; cur.lastPong -= ms; cur.lastServerPing -= ms; } }, // test hook: simulate frozen time
    forceClose: () => { if (cur) cur.ws.terminate(); }, // test hook: simulate 1006
    stop: () => { stopped = true; clearInterval(timer); clearInterval(ackTimer); clearTimeout(reconnectTimer); if (cur) { try { cur.ws.terminate(); } catch (_) {} } },
  };
}
module.exports = { createBlazeConn };
