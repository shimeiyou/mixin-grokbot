'use strict';
// Simulates a healthy Blaze server that then goes silent (no pongs, no replies; TCP stays up).
const wsPath = require.resolve('ws', { paths: [require.resolve('@mixin.dev/mixin-node-sdk')] });
const WS = require(wsPath);
const { sendRaw } = require('@mixin.dev/mixin-node-sdk/blaze');
const { createWatchdog } = require('./blaze-watchdog');
let silent = false, replies = 0;
const srv = new WS.Server({ port: 0, autoPong: false }, () => {
  srv.on('connection', (s) => {
    s.on('ping', (d) => { if (!silent) s.pong(d); });
    s.on('message', () => { if (!silent) { replies++; s.send(Buffer.from('ack')); } });
  });
  const client = new WS(`ws://127.0.0.1:${srv.address().port}`);
  const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const wd = createWatchdog({ getWs: () => client, sendRaw, log: (...a) => console.log(ts(), ...a), checkMs: 300, staleMs: 1500,
    onDead: (r) => { const ok = silent && replies > 3 && Date.now() - t0 > 3000; console.log(ts(), ok ? 'PASS' : 'FAIL', 'replies=' + replies); process.exit(ok ? 0 : 1); } });
  setTimeout(() => { console.log(ts(), 'server goes silent'); silent = true; }, 3000);
  setTimeout(() => { console.log('FAIL: watchdog never fired'); process.exit(1); }, 8000);
});
