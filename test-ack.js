'use strict';
// Step 3: verify the ACK HTTP fallback (POST /acknowledgements) with a fake Blaze + fake Mixin API.
//  1) Blaze never confirms WS ACKs -> HTTP fallback with READ for every id, signed JWT; after reconnect the
//     server (modelled: pending until ACKed) does not redeliver them.
//  2) Socket dies while the handler runs -> ACK can't go over WS -> HTTP fallback.
//  3) HTTP 500 -> "ack via HTTP failed", retried until it succeeds.
require('./ws-shim');
const crypto = require('crypto');
const { createBlazeConn } = require('./blaze-conn');
const { check, finish, fakeKeystore, ksJson, fakeBlaze, fakeMixinApi, waitFor, sleep, blazeMsg, uuid } = require('./test-helpers');
const ks = JSON.parse(ksJson(fakeKeystore()));
const jwtPayload = (auth) => JSON.parse(Buffer.from(auth.replace(/^Bearer /, '').split('.')[1], 'base64url').toString());

(async () => {
  { // 1
    const blaze = await fakeBlaze({ wsAck: false });
    const api = await fakeMixinApi({ onAck: (ids) => blaze.ackHttp(ids) });
    const msgs = [0, 1, 2].map((i) => blazeMsg({ category: 'PLAIN_TEXT', data: 'x' + i, user_id: uuid(), conversation_id: uuid() }));
    blaze.add(msgs);
    const logs = []; let handled = 0;
    const b = createBlazeConn({ keystore: ks, url: blaze.url, log: (...a) => logs.push(a.join(' ')), onDead: () => {}, handler: { onMessage: () => { handled++; } },
      ackConfirmMs: 300, ackFlushMs: 200, tickMs: 100, checkMs: 60000, apiConfig: { baseURL: api.url } });
    b.start();
    await waitFor(() => logs.some((l) => /ack via HTTP count=/.test(l)) && blaze.st.pending.size === 0, 8000);
    const acked = api.state.acks.flatMap((a) => a.body);
    check('WS ACK unconfirmed -> POST /acknowledgements', msgs.every((m) => acked.some((a) => a.message_id === m.message_id && a.status === 'READ')), acked);
    check('log "ack via HTTP count=N"', logs.some((l) => /^ack via HTTP count=\d+$/.test(l)), logs.filter((l) => /ack/.test(l)));
    const auth = api.state.acks[0].auth; const p = jwtPayload(auth);
    const req = api.reqs.find((r) => r.url === '/acknowledgements');
    const sig = crypto.createHash('sha256').update('POST/acknowledgements' + req.body.toString()).digest('hex');
    check('request signed by the bot session (uid/sid/sig in JWT)', p.uid === ks.app_id && p.sid === ks.session_id && p.sig === sig, { uid: p.uid === ks.app_id, sid: p.sid === ks.session_id, sig: p.sig === sig });
    check('server state: all ACKed, none pending', blaze.st.pending.size === 0 && msgs.every((m) => blaze.st.acked.has(m.message_id)));
    const before = handled; const listsBefore = blaze.st.lists;
    b.forceClose(); await waitFor(() => blaze.st.lists > listsBefore, 5000); await sleep(500);
    check('after reconnect + LIST_PENDING: no redelivery', handled === before && blaze.st.conns >= 2, { handled, before });
    b.stop(); await blaze.close(); await api.close();
  }
  { // 2 socket dies inside the handler
    const blaze = await fakeBlaze();
    const api = await fakeMixinApi({ onAck: (ids) => blaze.ackHttp(ids) });
    const m = blazeMsg({ category: 'PLAIN_TEXT', data: 'y', user_id: uuid(), conversation_id: uuid() }); blaze.add([m]);
    const logs = []; let b;
    b = createBlazeConn({ keystore: ks, url: blaze.url, log: (...a) => logs.push(a.join(' ')), onDead: () => {}, handler: { onMessage: async () => { b.forceClose(); await sleep(50); } },
      ackConfirmMs: 300, ackFlushMs: 200, tickMs: 100, checkMs: 60000, apiConfig: { baseURL: api.url } });
    b.start();
    await waitFor(() => api.state.acks.some((a) => a.body.some((x) => x.message_id === m.message_id)), 8000);
    check('socket closed before ACK -> HTTP fallback', api.state.acks.some((a) => a.body.some((x) => x.message_id === m.message_id)) && blaze.st.wsAcks === 0, { ws: blaze.st.wsAcks });
    b.stop(); await blaze.close(); await api.close();
  }
  { // 3 HTTP 500 then success
    const blaze = await fakeBlaze({ wsAck: false });
    const api = await fakeMixinApi({ onAck: (ids) => blaze.ackHttp(ids), failAcks: 2 });
    const m = blazeMsg({ category: 'PLAIN_TEXT', data: 'z', user_id: uuid(), conversation_id: uuid() }); blaze.add([m]);
    const logs = [];
    const b = createBlazeConn({ keystore: ks, url: blaze.url, log: (...a) => logs.push(a.join(' ')), onDead: () => {}, handler: { onMessage: () => {} },
      ackConfirmMs: 300, ackFlushMs: 200, tickMs: 100, checkMs: 60000, apiConfig: { baseURL: api.url } });
    b.start();
    await waitFor(() => logs.some((l) => /^ack via HTTP count=1$/.test(l)), 15000);
    check('HTTP ACK 500 -> logged failure, retried, then 200', logs.some((l) => /ack via HTTP failed count=1/.test(l)) && logs.some((l) => /^ack via HTTP count=1$/.test(l)) && blaze.st.acked.has(m.message_id), logs.filter((l) => /ack via/.test(l)));
    b.stop(); await blaze.close(); await api.close();
  }
  finish('ack-http-fallback');
})().catch((e) => { console.error(e); process.exit(1); });
