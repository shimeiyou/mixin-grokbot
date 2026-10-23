'use strict';
// Receipt logging + message-status.js. Offline: fake Blaze, fake API, temp files. Nothing real is contacted.
//  A) receipt-log.js unit: own ids only, metadata only, dedupe, disable switch, picks up just-sent ids.
//  B) gateway.js end-to-end: receipt frames for own ids are logged, NOT ACKed; normal messages still ACKed.
//  C) message-status.js: per-session status JSON, paging, session->user/platform mapping, exit codes, read-only calls.
require('./ws-shim');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const pako = require('pako');
const { check, finish, uuid, fakeKeystore, ksJson, tmpdir, fakeBlaze, fakeMixinApi, httpServer, runNode, waitFor, sleep, blazeMsg } = require('./test-helpers');
const HERE = __dirname;
const W = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mixin-receipts-'));

(async () => {
  // ---------------- A) unit ----------------
  {
    const sl = path.join(W, 'sent-a.jsonl'); process.env.MIXIN_SENT_LOG_FILE = sl;
    delete require.cache[require.resolve('./sent-log')]; delete require.cache[require.resolve('./receipt-log')];
    const { createReceiptLog } = require('./receipt-log');
    const own = uuid(), foreign = uuid(), later = uuid(), conv = uuid(), sess = uuid(), user = uuid();
    fs.writeFileSync(sl, JSON.stringify({ message_id: own, conversation_id: conv, category: 'ENCRYPTED_TEXT', via: 'group-encrypted', at: new Date().toISOString() }) + '\n');
    const lines = []; const rl = createReceiptLog({ log: (s) => lines.push(s), statMs: 0 });
    rl.onAckReceipt({ source: 'ACKNOWLEDGE_MESSAGE_RECEIPT', message_id: foreign, status: 'READ' });
    check('foreign id ignored', lines.length === 0, lines);
    rl.onAckReceipt({ source: 'ACKNOWLEDGE_MESSAGE_RECEIPT', message_id: own, status: 'DELIVERED', updated_at: '2026-10-18T03:51:37.074043Z', data: 'U0VDUkVUIEJPRFk=', user_id: user, session_id: sess });
    check('own id logged with status/updated_at/prefixes', lines.length === 1 && lines[0] === `receipt msg=${own} status=DELIVERED updated_at=2026-10-18T03:51:37.074043Z user=${user.slice(0, 8)} session=${sess.slice(0, 8)}`, lines);
    check('no body/data in log line', !/U0VDUkVU|SECRET/.test(lines.join('\n')));
    rl.onAckReceipt({ source: 'ACKNOWLEDGE_MESSAGE_RECEIPT', message_id: own, status: 'DELIVERED', updated_at: '2026-10-18T03:51:37.074043Z', user_id: user, session_id: sess });
    check('exact duplicate deduped', lines.length === 1, lines);
    rl.onAckReceipt({ source: 'ACKNOWLEDGE_MESSAGE_RECEIPT', message_id: own, status: 'READ', updated_at: '2026-10-18T03:51:55Z' });
    check('READ logged; frames without user/session have no prefixes', lines.length === 2 && lines[1] === `receipt msg=${own} status=READ updated_at=2026-10-18T03:51:55Z`, lines);
    rl.onAckReceipt({ message_id: own, status: '<script>', updated_at: 'x'.repeat(200) });
    check('unknown status -> OTHER, updated_at capped', lines.length === 3 && /status=OTHER updated_at=x{40}$/.test(lines[2]), lines[2]);
    fs.appendFileSync(sl, JSON.stringify({ message_id: later, conversation_id: conv, at: new Date().toISOString() }) + '\n');
    const rl2Lines = []; const rl2 = createReceiptLog({ log: (s) => rl2Lines.push(s), statMs: 60000 });
    rl2.onAckReceipt({ message_id: own, status: 'SENT' }); // loads the file once
    fs.appendFileSync(sl, JSON.stringify({ message_id: uuid(), conversation_id: conv }) + '\n');
    const newest = JSON.parse(fs.readFileSync(sl, 'utf8').trim().split('\n').pop()).message_id;
    rl2.onAckReceipt({ message_id: newest, status: 'SENT' });
    check('just-sent id picked up even inside the stat interval', rl2Lines.length === 2 && rl2Lines[1].includes(newest), rl2Lines);
    const off = []; createReceiptLog({ log: (s) => off.push(s), enabled: false, statMs: 0 }).onAckReceipt({ message_id: own, status: 'READ' });
    check('disabled -> nothing logged', off.length === 0);
    let threw = false; try { createReceiptLog({ log: () => { throw new Error('boom'); }, statMs: 0 }).onAckReceipt({ message_id: own, status: 'READ' }); } catch (_) { threw = true; }
    check('logger failure never throws into blaze-conn', !threw);
    const none = []; process.env.MIXIN_SENT_LOG_FILE = path.join(W, 'missing.jsonl'); delete require.cache[require.resolve('./sent-log')]; delete require.cache[require.resolve('./receipt-log')];
    require('./receipt-log').createReceiptLog({ log: (s) => none.push(s), statMs: 0 }).onAckReceipt({ message_id: own, status: 'READ' });
    check('no sent-log -> nothing logged, no error', none.length === 0);
    delete process.env.MIXIN_SENT_LOG_FILE;
  }

  // ---------------- B) gateway end-to-end ----------------
  {
    const ks = fakeKeystore(); const dir = path.join(W, 'gw'); fs.mkdirSync(dir, { recursive: true });
    const U = uuid(), C = uuid(), own = uuid(), foreign = uuid();
    const sl = path.join(dir, 'sent-log.jsonl');
    fs.writeFileSync(sl, JSON.stringify({ message_id: own, conversation_id: C, category: 'ENCRYPTED_TEXT', via: 'group-encrypted', at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    const blaze = await fakeBlaze(); const normal = blazeMsg({ category: 'PLAIN_TEXT', data: 'hello', user_id: U, conversation_id: C }); blaze.add([normal]);
    const hook = await httpServer((r) => (r.method === 'POST' ? { status: 200, body: '' } : null));
    const api = await fakeMixinApi({ onAck: (ids) => blaze.ackHttp(ids) });
    fs.writeFileSync(path.join(dir, 'allow.json'), JSON.stringify([U]));
    const env = {
      MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_WEBHOOK_URL: hook.url + '/hook', MIXIN_WEBHOOK_KEY: 'k', MIXIN_ALLOWLIST_FILE: path.join(dir, 'allow.json'),
      MIXIN_SEEN_FILE: path.join(dir, 'seen.json'), MIXIN_GATEWAY_LOG: path.join(dir, 'gateway.log'), MIXIN_CONTEXT_DIR: path.join(dir, 'context'), MIXIN_QUEUE_DIR: path.join(dir, 'queue'),
      MIXIN_MEDIA_DIR: path.join(dir, 'media'), MIXIN_LOOKUP_CACHE_FILE: path.join(dir, 'lookup.json'), MIXIN_API_BASE: api.url, TEST_BLAZE_URL: blaze.url,
      MIXIN_SEND_SOCKET: path.join(dir, 'run', 'send.sock'), MIXIN_CONV_CACHE_FILE: path.join(dir, 'conv.json'), MIXIN_MEMBER_ALERT_STATE_FILE: path.join(dir, 'ma.json'),
      MIXIN_SENT_LOG_FILE: sl, HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9',
    };
    const p = runNode(['-r', path.join(HERE, 'test-redirect-ws.js'), 'gateway.js'], { env, cwd: HERE, timeoutMs: 60000 });
    await waitFor(() => blaze.st.acked.has(normal.message_id), 20000);
    const z = (o) => Buffer.from(pako.gzip(JSON.stringify(o)));
    const rec = (id, status) => ({ type: 'message', source: 'ACKNOWLEDGE_MESSAGE_RECEIPT', message_id: id, status, conversation_id: '', user_id: '', session_id: '', category: '', data: '', updated_at: new Date().toISOString() });
    const before = blaze.st.wsAcks;
    for (const s of blaze.st.sockets) if (s.readyState === 1) { s.send(z({ id: uuid(), action: 'CREATE_MESSAGE', data: rec(own, 'DELIVERED') })); s.send(z({ id: uuid(), action: 'CREATE_MESSAGE', data: rec(foreign, 'READ') })); s.send(z({ id: uuid(), action: 'CREATE_MESSAGE', data: rec(own, 'READ') })); }
    const L = () => (fs.existsSync(env.MIXIN_GATEWAY_LOG) ? fs.readFileSync(env.MIXIN_GATEWAY_LOG, 'utf8') : '');
    await waitFor(() => /receipt msg=\S+ status=READ/.test(L()), 8000); await sleep(1500);
    p.child.kill('SIGTERM'); await p.done;
    const log = L(); const rl = log.split('\n').filter((l) => l.includes('receipt msg='));
    check('gateway: own DELIVERED + READ receipts logged', rl.length === 2 && rl[0].includes(`receipt msg=${own} status=DELIVERED`) && rl[1].includes(`receipt msg=${own} status=READ`), rl);
    check('gateway: foreign receipt not logged', !log.includes(foreign));
    check('gateway: receipts not ACKed (WS or HTTP)', blaze.st.wsAcks === before && !blaze.st.acked.has(own) && !blaze.st.acked.has(foreign) && !api.state.acks.some((a) => a.body.some((x) => x.message_id === own || x.message_id === foreign)), { before, after: blaze.st.wsAcks });
    check('gateway: normal message still ACKed and forwarded path intact', blaze.st.acked.has(normal.message_id) && log.includes(`recv msg=${normal.message_id}`));
    check('gateway: no handler errors', !/handler error|ack handler/.test(log), log.slice(-400));
    await blaze.close(); await hook.close(); await api.close();
  }

  // ---------------- C) message-status.js ----------------
  {
    const ks = fakeKeystore(); const conv = uuid(), MID = uuid(), OTHER = uuid();
    const A = uuid(), B = uuid(), Cc = uuid(); const sA1 = uuid(), sA2 = uuid(), sB = uuid(), sC = uuid(), sBot = uuid();
    const t0 = Date.parse('2026-10-18T03:51:36.183613Z');
    const iso = (ms, us = '183613') => new Date(ms).toISOString().replace(/\.\d{3}Z$/, `.${us}Z`);
    // page 1: 100 rows (forces paging), page 2: the rest
    const page1 = Array.from({ length: 100 }, (_, i) => ({ type: 'message', message_id: OTHER, status: 'SENT', session_id: uuid(), user_id: '', conversation_id: '', updated_at: iso(t0 - 1000 + i), source: 'LIST_SEND_STATUSES' }));
    page1.push(...[]);
    const page2 = [
      { message_id: MID, status: 'SENT', session_id: sA1, updated_at: iso(t0) }, { message_id: MID, status: 'SENT', session_id: sA2, updated_at: iso(t0) },
      { message_id: MID, status: 'SENT', session_id: sB, updated_at: iso(t0) }, { message_id: MID, status: 'DELIVERED', session_id: sA1, updated_at: iso(t0 + 1000) },
      { message_id: MID, status: 'READ', session_id: sB, updated_at: iso(t0 + 20000) }, { message_id: MID, status: 'DELIVERED', session_id: sB, updated_at: iso(t0 + 21000) },
    ].map((r) => ({ type: 'message', user_id: '', conversation_id: '', source: 'LIST_SEND_STATUSES', data: 'U0VDUkVU', ...r }));
    const seen = [];
    const api = await httpServer((r) => {
      const u = r.url.split('?')[0]; seen.push(`${r.method} ${u.replace(/\d{10,}/, 'N')}`);
      let m;
      if (r.method === 'GET' && (m = u.match(/^\/messages\/status\/(\d+)$/))) {
        const off = BigInt(m[1]);
        const ns = (x) => { const [a, f] = x.updated_at.replace('Z', '').split('.'); return BigInt(Date.parse(a + 'Z')) * 1000000n + BigInt((f + '000000000').slice(0, 9)); };
        const all = [...page1, ...page2].filter((x) => ns(x) > off);
        return { json: { data: all.slice(0, 100) } };
      }
      if (r.method === 'GET' && u === `/conversations/${conv}`) return { json: { data: { conversation_id: conv, category: 'GROUP', participant_sessions: [
        { user_id: ks.app_id, session_id: sBot, public_key: 'x' }, { user_id: A, session_id: sA1, public_key: 'x' }, { user_id: A, session_id: sA2, public_key: 'x' }, { user_id: B, session_id: sB, public_key: 'x' }, { user_id: Cc, session_id: sC, public_key: 'x' } ] } } };
      if (r.method === 'POST' && u === '/sessions/fetch') return { json: { data: [{ user_id: A, session_id: sA1, platform: 'iOS' }, { user_id: A, session_id: sA2, platform: 'Desktop' }, { user_id: B, session_id: sB, platform: 'Android' }, { user_id: Cc, session_id: sC, platform: 'iOS' }] } };
      return null;
    });
    const sl = path.join(W, 'sent-c.jsonl'); fs.writeFileSync(sl, JSON.stringify({ message_id: MID, conversation_id: conv, at: new Date(t0 - 2000).toISOString() }) + '\n');
    const run = async (args, extra = {}) => { const p = runNode(['message-status.js', ...args], { cwd: HERE, env: { MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_API_BASE: api.url, MIXIN_SENT_LOG_FILE: sl, HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', ...extra } }); const r = await p.done; let json = null; try { json = JSON.parse(r.out); } catch (_) {} return { ...r, json }; };
    let r = await run(['--message', MID, '--since', new Date(t0 - 5000).toISOString()]);
    const by = r.json ? Object.fromEntries(r.json.sessions.map((s) => [s.session_id, s])) : {};
    check('status: exit 0, conversation from sent-log, paging reached page 2', r.code === 0 && r.json && r.json.conversation_id === conv && r.json.rows === 6 && seen.filter((x) => x.startsWith('GET /messages/status')).length >= 2, { code: r.code, err: r.err.slice(-300), seen });
    check('status: latest/best per session (READ beats later DELIVERED), NO_RECORD for silent session, bot excluded', by[sA1] && by[sA1].status === 'DELIVERED' && by[sA2].status === 'SENT' && by[sB].status === 'READ' && by[sC].status === 'NO_RECORD' && !by[sBot], r.json && r.json.sessions);
    check('status: platforms mapped, per-user best, summary', by[sA2] && by[sA2].platform === 'Desktop' && by[sB].platform === 'Android' && JSON.stringify(r.json.summary) === JSON.stringify({ SENT: 1, DELIVERED: 1, READ: 1, NO_RECORD: 1 }) && r.json.users.find((u) => u.user_id === A).best_status === 'DELIVERED', r.json && { s: r.json.summary, u: r.json.users });
    check('status: no body/data and no keys in output', !/U0VDUkVU|public_key/.test(r.out));
    check('status: only read-only calls made', seen.every((x) => /^GET \/messages\/status\/N$|^GET \/conversations\/|^POST \/sessions\/fetch$/.test(x)), seen);
    r = await run(['--message', uuid(), '--conversation', conv, '--minutes', '5']);
    check('status: unknown message -> exit 4, JSON ok with 0 rows', r.code === 4 && r.json && r.json.rows === 0, { code: r.code, err: r.err.slice(-200) });
    r = await run(['--message', 'nope']); const r2 = await run([]); const h = await run(['--help']);
    check('status: usage -> exit 2; --help exit 0', r.code === 2 && r2.code === 2 && h.code === 0 && /usage/.test(h.out), { a: r.code, b: r2.code, h: h.code });
    r = await run(['--message', MID, '--conversation', conv], { MIXIN_API_BASE: 'http://127.0.0.1:9' });
    check('status: API down -> exit 1 JSON error', r.code === 1 && /"ok":false/.test(r.err), { code: r.code, err: r.err.slice(-200) });
    const { isoToNanos } = require('./message-status');
    check('isoToNanos keeps microseconds', isoToNanos('2026-10-18T03:51:36.183613Z') === BigInt(Date.parse('2026-10-18T03:51:36Z')) * 1000000n + 183613000n);
    await api.close();
  }
  fs.rmSync(W, { recursive: true, force: true });
  finish('test-receipts');
})().catch((e) => { console.error('FAIL crash', e); process.exit(1); });
