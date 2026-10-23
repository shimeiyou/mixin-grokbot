'use strict';
// blaze-conn.js reconnect backoff (2026-10-18): jitter, configurable cap (default 60s), reset only after a stable
// connection, immediate reconnects (watchdog/recycle/suspend) don't grow it, the wait never outlives deadMs, and a
// VM resume during a backoff wait reconnects at once. Offline: fake WS server / refused port. Nothing real contacted.
require('./ws-shim');
const pako = require('pako');
const net = require('net');
const WS = require(require.resolve('ws', { paths: [require.resolve('@mixin.dev/mixin-node-sdk')] }));
const { createBlazeConn } = require('./blaze-conn');
const { generateKeyPairSync, randomUUID } = require('crypto');
const seed = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('hex');
const ks = { app_id: randomUUID(), session_id: randomUUID(), session_private_key: seed };
const z = (o) => Buffer.from(pako.gzip(JSON.stringify(o)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, info) => { ok ? pass++ : fail++; console.log(ok ? 'PASS' : 'FAIL', n, ok || info === undefined ? '' : JSON.stringify(info)); };

function server() {
  const st = { conns: 0, sockets: [] };
  return new Promise((res) => {
    const srv = new WS.Server({ port: 0 }, () => res({ srv, st, url: `ws://127.0.0.1:${srv.address().port}` }));
    srv.on('connection', (s) => {
      st.conns++; st.sockets.push(s);
      const pi = setInterval(() => { try { s.ping(); } catch (_) {} }, 200); s.on('close', () => clearInterval(pi));
      s.on('message', (d) => { const m = JSON.parse(pako.ungzip(d, { to: 'string' })); s.send(z({ id: m.id, action: m.action })); });
    });
  });
}
async function refusedUrl() { // a port with nothing listening
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r));
  return `ws://127.0.0.1:${p}`;
}
function mk(url, extra = {}) {
  const logs = [];
  const b = createBlazeConn({ keystore: ks, url, log: (...a) => { logs.push(a.join(' ')); if (process.env.V) console.log(...a); }, onDead: () => {}, handler: { onMessage: () => {} }, tickMs: 50, checkMs: 500, deadMs: 600000, ...extra });
  const waits = () => logs.map((l) => /blaze recreate in (\d+)ms/.exec(l)).filter(Boolean).map((m) => +m[1]);
  return { b, logs, waits };
}

(async () => {
  { // 1 exponential growth + cap, factor 1.0 (random 0.5)
    const t = mk(await refusedUrl(), { backoffBaseMs: 50, backoffMaxMs: 400, random: () => 0.5 });
    t.b.start(); await sleep(2500); t.b.stop();
    const w = t.waits();
    check('backoff doubles and caps at backoffMaxMs (50,100,200,400,400…)', w.length >= 6 && w.slice(0, 6).join() === '50,100,200,400,400,400', w.slice(0, 8));
  }
  { // 2 jitter bounds: random 0 -> x0.5, random ~1 -> x1.5
    const lo = mk(await refusedUrl(), { backoffBaseMs: 100, backoffMaxMs: 800, random: () => 0 });
    lo.b.start(); await sleep(1200); lo.b.stop();
    const hi = mk(await refusedUrl(), { backoffBaseMs: 100, backoffMaxMs: 800, random: () => 0.999999 });
    hi.b.start(); await sleep(1500); hi.b.stop();
    check('jitter low bound x0.5 (50,100,200…)', lo.waits().slice(0, 3).join() === '50,100,200', lo.waits().slice(0, 5));
    check('jitter high bound x1.5 (150,300,600…)', hi.waits().slice(0, 3).join() === '150,300,600', hi.waits().slice(0, 5));
    const rnd = mk(await refusedUrl(), { backoffBaseMs: 100, backoffMaxMs: 100 }); // real Math.random, constant base
    rnd.b.start(); await sleep(2500); rnd.b.stop();
    const rw = rnd.waits();
    check('default jitter (0.5): waits spread within [0.5x,1.5x] and are not all equal', rw.length >= 8 && rw.every((x) => x >= 50 && x <= 150) && new Set(rw).size > 1, rw.slice(0, 10));
    const nj = mk(await refusedUrl(), { backoffBaseMs: 100, backoffMaxMs: 100, backoffJitter: 0 });
    nj.b.start(); await sleep(800); nj.b.stop();
    check('backoffJitter 0 -> deterministic', nj.waits().length >= 3 && nj.waits().every((x) => x === 100), nj.waits());
  }
  { // 3 default config: 1s base, 60s cap
    const t = mk(await refusedUrl());
    t.b.start(); await sleep(200); t.b.stop();
    const w = t.waits();
    check('defaults: first wait in [500,1500]ms, backoff then 2000; cap default 60000', w.length === 1 && w[0] >= 500 && w[0] <= 1500 && t.b._backoff() === 2000, { w, b: t.b._backoff() });
    const c = mk(await refusedUrl(), { backoffBaseMs: 40000 }); // default backoffMaxMs: 40000*2 must cap at 60000
    c.b.start(); await sleep(200); c.b.stop();
    check('default cap is 60000 (was 30000)', c.b._backoff() === 60000, c.b._backoff());
  }
  { // 3b 2026-10-18 hardening: reset default 120s; cap clamped to deadMs/2 (no 5-min window vs the 120s watchdog)
    const d = mk(await refusedUrl(), { deadMs: 120000 }); const cd = d.b._config();
    check('defaults: reset after 120000ms stable, cap 60000 (= deadMs/2)', cd.backoffResetMs === 120000 && cd.maxBackoff === 60000, cd);
    const big = mk(await refusedUrl(), { deadMs: 120000, backoffMaxMs: 300000 }); const cb = big.b._config();
    check('cap 300000 with deadMs 120000 -> clamped to 60000 + WARN', cb.maxBackoff === 60000 && big.logs.some((l) => /WARN blaze backoff cap 300000ms > deadMs\/2; using 60000ms/.test(l)), { cb, logs: big.logs });
    let dead = 0; const t = mk(await refusedUrl(), { backoffBaseMs: 500, backoffMaxMs: 300000, random: () => 0.999999, deadMs: 6000, onDead: () => { dead++; } });
    t.b.start(); await sleep(5500); t.b.stop(); const w = t.waits();
    check('cap 300000 + small deadMs: every wait stays inside the dead window (<= deadMs/2*1.5), no onDead yet', w.length >= 3 && w.every((x) => x <= 4500) && t.b._config().maxBackoff === 3000 && dead === 0, { w, dead });
  }
  { // 4 reset only after a stable connection; flaps keep growing it
    const { srv, st, url } = await server();
    const t = mk(url, { backoffBaseMs: 100, backoffMaxMs: 10000, backoffJitter: 0, backoffResetMs: 700 });
    t.b.start(); await sleep(300); // open
    t.b.forceClose(); await sleep(400); // flap 1: wait 100, reopens
    t.b.forceClose(); await sleep(500); // flap 2: wait 200 (no reset: was open < 700ms)
    const grown = t.waits();
    check('flapping socket (open < resetMs): backoff keeps growing (100,200)', grown.slice(0, 2).join() === '100,200' && t.b._backoff() === 400, { grown, b: t.b._backoff() });
    await sleep(900); // stable > 700ms
    check('stable OPEN >= resetMs -> backoff reset to base', t.b._backoff() === 100, t.b._backoff());
    t.b.forceClose(); await sleep(300);
    check('next failure after a stable period waits base again', t.waits().slice(-1)[0] === 100 && st.conns >= 4, { w: t.waits(), conns: st.conns });
    t.b.stop(); srv.close(); for (const s of st.sockets) s.terminate();
  }
  { // 5 immediate reconnects (recycle/watchdog) don't grow backoff
    const { srv, st, url } = await server();
    const t = mk(url, { recycleMs: 250, backoffBaseMs: 100, backoffJitter: 0 });
    t.b.start(); await sleep(1500);
    const rec = t.logs.filter((l) => /periodic recycle/.test(l)).length;
    check('recycles reconnect immediately (0ms) and leave backoff at base', rec >= 3 && t.waits().every((x) => x === 0) && t.b._backoff() === 100 && t.b.current() && t.b.current().open, { rec, w: t.waits().slice(0, 5), b: t.b._backoff() });
    t.b.stop(); srv.close(); for (const s of st.sockets) s.terminate();
  }
  { // 6 a backoff wait never outlives deadMs (last attempt ~5s before onDead)
    let dead = 0;
    const t = mk(await refusedUrl(), { backoffBaseMs: 1000, backoffMaxMs: 60000, random: () => 0.999999, deadMs: 7000, onDead: () => { dead++; } });
    t.b.start(); await sleep(6500); t.b.stop();
    const w = t.waits();
    check('waits clamped to deadMs-5s-elapsed (min base/2); never a 60s wait inside a 7s deadMs', w.length >= 3 && w.every((x) => x <= 2000) && dead === 0, { w, dead });
  }
  { // 7 resume after suspend during a backoff wait -> reconnect now
    const url = await refusedUrl();
    const t = mk(url, { backoffBaseMs: 30000, backoffJitter: 0 });
    t.b.start(); await sleep(300); // first attempt refused -> waiting 30s
    const before = t.waits().length;
    t.b._shiftClock(7979000); t.b._tick(); await sleep(300);
    check('tick gap while waiting -> wait cancelled, reconnect attempted at once', before === 1 && t.logs.some((l) => /tick gap 7979s/.test(l)) && t.logs.some((l) => /blaze reconnect now \(resume after suspend/.test(l)) && t.waits().length === 2, { before, w: t.waits() });
    t.b.stop();
  }
  console.log(fail ? `backoff: SOME FAILED (${fail} failed, ${pass} passed)` : `backoff: ALL PASS (${pass})`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL crash', e); process.exit(1); });
