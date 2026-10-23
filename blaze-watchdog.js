'use strict';
// Blaze liveness watchdog.
// The SDK (7.6.0) only kills a socket if no *server ping* arrives for 30s. It never pings itself and never
// checks that the app-level stream still works, so a half-dead connection (TCP/pings alive but no frames, or a
// socket stuck in a non-OPEN state) can sit silently forever. This watchdog, every CHECK_MS:
//   - sends a ws ping (expects a pong) and a LIST_PENDING_MESSAGES request (Blaze answers with a frame),
//   - tracks last inbound frame / pong / ping and last OPEN time,
//   - calls onDead(reason) if no inbound frame for STALE_MS, or no OPEN socket for STALE_MS.
// No message content is touched or logged.
const { randomUUID } = require('crypto');

function createWatchdog({ getWs, sendRaw, log, onDead, checkMs = 20000, staleMs = 75000, now = Date.now }) {
  const st = { lastFrame: now(), lastPong: now(), lastPing: now(), lastOpen: now(), ws: null, fired: false };
  const age = (t) => Math.round((now() - t) / 1000);
  function attach(w) {
    st.ws = w;
    const t = now();
    st.lastFrame = st.lastPong = st.lastPing = t; // fresh grace period for every new socket
    w.on('message', () => { st.lastFrame = now(); });
    w.on('pong', () => { st.lastPong = now(); });
    w.on('ping', () => { st.lastPing = now(); });
    w.on('open', () => { st.lastOpen = st.lastFrame = st.lastPong = now(); log('blaze connected'); });
    w.on('close', (code, reason) => log(`blaze closed code=${code}${reason && reason.length ? ' reason=' + String(reason).slice(0, 100) : ''} (SDK will reconnect)`));
    w.on('error', (e) => log(`blaze error code=${e && e.code ? e.code : '-'} ${e && e.message}`));
    w.on('unexpected-response', (_q, r) => log(`blaze unexpected-response status=${r.statusCode}`));
  }
  function fire(reason) {
    if (st.fired) return;
    st.fired = true;
    log(`WATCHDOG blaze dead: ${reason}`);
    onDead(reason);
  }
  function check() {
    const w = getWs();
    if (w && w !== st.ws) attach(w);
    const open = w && w.readyState === 1;
    if (open) st.lastOpen = now();
    else if (now() - st.lastOpen > staleMs) return fire(`no OPEN socket for ${age(st.lastOpen)}s (state=${w ? w.readyState : 'none'})`);
    if (!open) return;
    if (now() - st.lastFrame > staleMs) {
      return fire(`no inbound frame for ${age(st.lastFrame)}s (last pong ${age(st.lastPong)}s, last server ping ${age(st.lastPing)}s ago)`);
    }
    try { w.ping(); } catch (e) { log(`watchdog ping failed ${e.message}`); }
    sendRaw(w, { id: randomUUID(), action: 'LIST_PENDING_MESSAGES' }).catch(() => {});
  }
  const poll = setInterval(() => { const w = getWs(); if (w && w !== st.ws) attach(w); }, 20);
  const timer = setInterval(check, checkMs);
  poll.unref(); timer.unref();
  return { state: st, check, stop: () => { clearInterval(poll); clearInterval(timer); } };
}
module.exports = { createWatchdog };
