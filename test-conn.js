'use strict';
// Offline tests with a fake Blaze server.
//  1) LIST_PENDING per socket, handle->ACK order with id-confirmed reply, reconnect after forced close.
//  2) Simulated process/VM suspend (wall clock jumps, frozen timers) -> detected on first tick, new gen.
//  3) Silent server (socket open, no pongs/frames/pings) -> pong watchdog fires, for gen>=2 too.
//  4) Periodic recycle fires for every gen; heartbeat line is logged.
//  5) Watchdog: closing a socket that was healthy for longer than deadMs must NOT fire 'blaze dead' right away
//     (fix #4: deadMs counts from when it stopped being OPEN); a real outage of deadMs still fires it.
//  6) send(): reply matched by id (not dispatched/ACKed as a message), error passthrough, ECONNRESET on drop,
//     NOT_CONNECTED after waitOpenMs, waits for a reconnect within waitOpenMs.
require('./ws-shim');
const pako = require('pako');
const WS = require(require.resolve('ws', { paths: [require.resolve('@mixin.dev/mixin-node-sdk')] }));
const { createBlazeConn } = require('./blaze-conn');
const { generateKeyPairSync, randomUUID } = require('crypto');
const seed = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('hex');
const ks = { app_id: randomUUID(), session_id: randomUUID(), session_private_key: seed };
const z = (o) => Buffer.from(pako.gzip(JSON.stringify(o)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function server(opts = {}) {
  const st = { lists: 0, acks: 0, conns: 0, silent: false, sockets: [] };
  return new Promise((res) => {
    const srv = new WS.Server({ port: 0, autoPong: !opts.noPong }, () => res({ srv, st, url: `ws://127.0.0.1:${srv.address().port}` }));
    srv.on('connection', (s) => {
      st.conns++; st.sockets.push(s);
      const pi = setInterval(() => { if (!st.silent) try { s.ping(); } catch (_) {} }, 200);
      s.on('close', () => clearInterval(pi));
      if (opts.noPong) s.on('ping', () => {}); // ws auto-pongs unless autoPong:false
      s.on('message', (d) => {
        if (st.silent) return;
        const m = JSON.parse(pako.ungzip(d, { to: 'string' }));
        if (opts.onSend && m.action === 'CREATE_MESSAGE') {
          const r = opts.onSend(m, st); st.sends = (st.sends || 0) + 1;
          if (r === 'drop') return s.terminate(); if (r === 'silent') return;
          return s.send(z({ id: m.id, action: m.action, ...r }));
        }
        s.send(z({ id: m.id, action: m.action }));
        if (m.action === 'LIST_PENDING_MESSAGES') { st.lists++; s.send(z({ id: randomUUID(), action: 'CREATE_MESSAGE', data: { message_id: randomUUID(), category: 'PLAIN_TEXT', data: '' } })); }
        if (m.action === 'ACKNOWLEDGE_MESSAGE_RECEIPT') st.acks++;
      });
    });
  });
}
function mk(url, extra = {}) {
  const logs = []; let handled = 0;
  const b = createBlazeConn({ keystore: ks, url, log: (...a) => { logs.push(a.join(' ')); if (process.env.V) console.log(...a); }, onDead: () => {},
    handler: { onMessage: () => { handled++; } }, checkMs: 500, tickMs: 100, backoffJitter: 0, ...extra }); // jitter off: timings below assume a 1s first retry (jitter is tested in test-backoff.js)
  return { b, logs, handled: () => handled };
}
const results = [];
const check = (name, ok, info) => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, info ? JSON.stringify(info) : ''); };

(async () => {
  { // 1
    const { srv, st, url } = await server(); const t = mk(url);
    t.b.start(); await sleep(1500); t.b.forceClose(); await sleep(2500);
    check('basic reconnect + ack', st.conns === 2 && st.lists >= 2 && t.handled() >= 2 && st.acks === t.handled(), { conns: st.conns, lists: st.lists, handled: t.handled(), acks: st.acks });
    t.b.stop(); srv.close();
  }
  { // 2 suspend: shift every timestamp back by 7979s as if the VM was frozen; next tick must notice it.
    const { srv, st, url } = await server(); const t = mk(url);
    t.b.start(); await sleep(800); t.b.forceClose(); await sleep(1500); // now on gen 2 like the incident
    const g = t.b.current().gen; t.b._shiftClock(7979000); t.b._tick(); await sleep(1500);
    const c = t.b.current();
    check('suspend detected on resume (gen2)', g === 2 && t.logs.some((l) => /tick gap 7979s/.test(l)) && c && c.gen === 3 && c.open, { g, now: c && c.gen, conns: st.conns });
    t.b.stop(); srv.close();
  }
  { // 3 silent server on gen 2: no pongs, no frames, no pings
    const { srv, st, url } = await server({ noPong: true }); const t = mk(url, { pongWaitMs: 1000, clientPingMs: 200, pingTimeoutMs: 1500, probeTimeoutMs: 5000 });
    t.b.start(); await sleep(600); t.b.forceClose(); await sleep(1200);
    st.silent = true; await sleep(2000);
    check('silent gen2 -> watchdog fires', t.logs.some((l) => /WATCHDOG gen=2 (no pong\/frame|no server ping)/.test(l)) && t.b.current() && t.b.current().gen >= 3, { gen: t.b.current() && t.b.current().gen });
    t.b.stop(); srv.close();
  }
  { // 4 recycle every gen + heartbeat
    const { srv, url } = await server(); const t = mk(url, { recycleMs: 700, heartbeatMs: 500 });
    t.b.start(); await sleep(3000);
    const rec = t.logs.filter((l) => /periodic recycle/.test(l)).length;
    check('recycle per gen + heartbeat', rec >= 2 && t.logs.some((l) => /^heartbeat gen=/.test(l)), { rec });
    t.b.stop(); srv.close();
  }
  { // 5 watchdog after a long-lived connection closes
    const { srv, st, url } = await server(); let dead = 0; const t = mk(url, { deadMs: 1500, onDead: () => { dead++; } });
    t.b.start(); await sleep(2600); // healthy OPEN for > deadMs
    const wasOpen = t.b.current() && t.b.current().open;
    srv.close(); for (const s of st.sockets) s.terminate(); // real outage starts now: reconnects are refused
    await sleep(700);
    const early = t.logs.filter((l) => /WATCHDOG blaze dead/.test(l)).length;
    check('no blaze-dead right after long-lived socket closes', wasOpen && early === 0 && dead === 0, { wasOpen, early, dead });
    await sleep(1600);
    const late = t.logs.find((l) => /WATCHDOG blaze dead: no OPEN socket for \d+s/.test(l));
    check('blaze-dead still fires after a real deadMs outage', !!late && dead === 1, { late, dead });
    t.b.stop();
  }
  { // 5b suspend freeze (tick gap) is not counted toward deadMs; then a real outage still counts
    const { srv, st, url } = await server(); let dead = 0; const t = mk(url, { deadMs: 3000, onDead: () => { dead++; } });
    t.b.start(); await sleep(800);
    t.b._shiftClock(7979000); t.b._tick();
    const fired = t.logs.some((l) => /WATCHDOG blaze dead/.test(l));
    check('suspend gap does not count toward deadMs', !fired && dead === 0 && t.logs.some((l) => /tick gap 7979s/.test(l)), { fired, dead });
    t.b.stop(); srv.close(); for (const s of st.sockets) s.terminate();
  }
  { // 6 send()
    let mode = 'ok';
    const { srv, st, url } = await server({ onSend: (m) => mode === 'ok' ? { data: { message_id: m.params.message_id, status: 'SENT' } }
      : mode === 'err' ? { error: { status: 202, code: 20140, description: 'checksum', extra: { field: 'x' } } } : mode });
    const t = mk(url);
    t.b.start(); await sleep(700);
    const h0 = t.handled(); const mid = randomUUID();
    const r1 = await t.b.send('CREATE_MESSAGE', { message_id: mid, conversation_id: randomUUID(), category: 'ENCRYPTED_TEXT', data_base64: 'eA' });
    await sleep(200);
    check('send(): reply matched by id, not dispatched', r1 && r1.data && r1.data.message_id === mid && t.handled() === h0 && st.acks === h0, { r1, h0, h: t.handled() });
    mode = 'err';
    const r2 = await t.b.send('CREATE_MESSAGE', { message_id: randomUUID() });
    check('send(): server error passed through', r2.error && r2.error.code === 20140 && r2.error.extra.field === 'x', r2);
    mode = 'drop'; let e3 = null;
    await t.b.send('CREATE_MESSAGE', { message_id: randomUUID() }).catch((e) => { e3 = e; });
    check('send(): socket dropped before reply -> ECONNRESET', e3 && e3.code === 'ECONNRESET', e3 && e3.code);
    mode = 'ok'; // reconnects after ~1s backoff; send waits for it
    const t0 = Date.now(); const r4 = await t.b.send('CREATE_MESSAGE', { message_id: randomUUID() }, { waitOpenMs: 5000 }).catch((e) => e);
    check('send(): waits for reconnect within waitOpenMs', r4 && r4.data && t.b.current().gen >= 2, { r4: r4 && (r4.code || 'ok'), ms: Date.now() - t0 });
    srv.close(); for (const s of st.sockets) s.terminate(); await sleep(200);
    const t1 = Date.now(); let e5 = null;
    await t.b.send('CREATE_MESSAGE', { message_id: randomUUID() }, { waitOpenMs: 800 }).catch((e) => { e5 = e; });
    check('send(): NOT_CONNECTED after waitOpenMs', e5 && e5.code === 'NOT_CONNECTED' && Date.now() - t1 >= 700, { code: e5 && e5.code, ms: Date.now() - t1 });
    t.b.stop();
  }
  const ok = results.every(Boolean); console.log(ok ? 'ALL PASS' : 'SOME FAILED'); process.exit(ok ? 0 : 1);
})();
