'use strict';
// 2026-10-18 builder changes in reply.js / send-endpoint.js (offline: fake REST API, fake Blaze, in-process gateway
// endpoint; clean env, nothing real is contacted).
//  A) --card: legacy V0 vs new V1 (mixin-builder messaging.md §2): shareable always sent, action+actions refused,
//     V1 actions unlimited, description warning at 1024, input: warning; groups still refuse cards.
//  B) --mention: "@<identity_number> " in the text (official clients' format), TEXT not POST, Blaze `mentions` param
//     on group sends (via the gateway endpoint), usage/lookup errors send nothing; endpoint validates `mentions`.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { check, finish, uuid, fakeKeystore, ksJson, tmpdir, fakeMixinApi, fakeBlaze, runNode, curvePub } = require('./test-helpers');
const mc = require('./mixin-crypto');
const { uniqueConversationId } = require('./conversation-target');
const HERE = __dirname;
require('./ws-shim');
const { createBlazeConn } = require('./blaze-conn');
const { createSendEndpoint, sendViaEndpoint } = require('./send-endpoint');
const ks = fakeKeystore();
const mk = (user_id) => { const seed = crypto.randomBytes(32); return { user_id, session_id: uuid(), public_key: curvePub(seed), _seed: seed }; };
const pub = (s) => { const { _seed, ...r } = s; return r; };
const A = uuid(), B = uuid(), OUT = uuid();
const W = tmpdir('reply-builder-');
const GLOG = path.join(W, 'g.log');
const botSess = { user_id: ks.app_id, session_id: ks.session_id, public_key: curvePub(ks._seed), _seed: ks._seed };
const sA = mk(A), sB = mk(B);
const users = { [A]: { user_id: A, identity_number: '7000123', full_name: 'A' }, [B]: { user_id: B, identity_number: '37160854', full_name: 'B' }, [OUT]: { user_id: OUT, identity_number: '7000999', full_name: 'Out' } };
const grp = { conversation_id: uuid(), category: 'GROUP', participants: [ks.app_id, A, B].map((u) => ({ user_id: u })), participant_sessions: [sA, sB, botSess].map(pub) };
const cid = uniqueConversationId(ks.app_id, A);
const contact = { conversation_id: cid, category: 'CONTACT', participants: [{ user_id: A }, { user_id: ks.app_id }], participant_sessions: [pub(sA), pub(botSess)] };
const dec = (m, s) => mc.decryptMessageData(m.data_base64, s.session_id, s._seed).toString('utf8');
const plain = (m) => Buffer.from(m.data_base64, 'base64url').toString('utf8');
const logText = () => (fs.existsSync(GLOG) ? fs.readFileSync(GLOG, 'utf8') : '');

async function fakeGateway() {
  const bz = await fakeBlaze(); const logs = []; const log = (...a) => logs.push(a.join(' '));
  const conn = createBlazeConn({ keystore: JSON.parse(ksJson(ks)), url: bz.url, log, onDead: () => {}, handler: { onMessage: () => {} } });
  conn.start(); for (let i = 0; i < 50 && !(conn.current() && conn.current().open); i++) await new Promise((r) => setTimeout(r, 100));
  const socketPath = path.join(tmpdir('gw-sock-'), 'run', 'send.sock');
  const ep = createSendEndpoint({ blaze: conn, log, socketPath });
  for (let i = 0; i < 50 && !fs.existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 20));
  return { bz, logs, socketPath, close: async () => { ep.close(); conn.stop(); await bz.close(); } };
}
async function run(conv, args, { gw = null, env = {}, apiUsers = users } = {}) {
  const api = await fakeMixinApi({ users: apiUsers, sessions: { [A]: [pub(sA)], [B]: [pub(sB)] }, conversations: { [conv.conversation_id]: conv } });
  const before = logText().length;
  const p = runNode(['reply.js', '--conversation', conv.conversation_id, '--reply-to', uuid(), ...args], { cwd: HERE, timeoutMs: 60000,
    env: { MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_GATEWAY_LOG: GLOG, MIXIN_API_BASE: api.url, MIXIN_BLAZE_URL: 'ws://127.0.0.1:9', MIXIN_BLAZE_SEND_TIMEOUT_MS: '3000',
      HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', MIXIN_CONTEXT_DIR: path.join(W, 'ctx'), MIXIN_CONV_CACHE_FILE: path.join(W, `c-${uuid()}.json`),
      ...(gw ? { MIXIN_SEND_SOCKET: gw.socketPath } : {}), ...env } });
  const r = await p.done; await api.close();
  const created = gw ? gw.bz.st.created.splice(0) : [];
  let json = null; try { json = JSON.parse(r.out.trim().split('\n').pop()); } catch (_) {}
  return { ...r, json, api: api.state, reqs: api.reqs, created, log: logText().slice(before), sentCount: api.state.messages.length + api.state.encrypted.length + created.length };
}
const card = (o) => ['--card', JSON.stringify(o)];
const V0 = { title: 'T', description: 'D', icon_url: 'https://x/i.png', action: 'https://mixin.one' };
const acts = (n, a = 'https://mixin.one') => Array.from({ length: n }, (_, i) => ({ label: `b${i}`, action: a }));

(async () => {
  // ---------------- A) cards (1:1) ----------------
  { const r = await run(contact, card(V0)); const m = r.api.messages[0]; const c = m && JSON.parse(plain(m));
    check('V0 card: sent as APP_CARD with shareable:true, legacy fields kept, app_id = bot', r.code === 0 && m.category === 'APP_CARD' && c.shareable === true && c.action === V0.action && c.icon_url === V0.icon_url && c.app_id === ks.app_id && !('actions' in c), { code: r.code, err: r.err.slice(-300), c }); }
  { const r = await run(contact, card({ ...V0, shareable: false })); const c = JSON.parse(plain(r.api.messages[0]));
    check('V0 card: explicit shareable:false preserved', r.code === 0 && c.shareable === false, c); }
  { const r = await run(contact, card({ ...V0, actions: acts(1) }));
    check('action + actions together -> exit 2, nothing sent', r.code === 2 && /not both/.test(r.err + r.out) && r.sentCount === 0, { code: r.code, err: r.err.slice(-200) }); }
  { const r = await run(contact, card({ title: 'New', description: 'card', cover_url: 'https://x/c.png', actions: acts(8) })); const c = r.api.messages[0] && JSON.parse(plain(r.api.messages[0]));
    check('V1 card: no action key, 8 actions allowed (no 6 limit), cover_url kept, shareable:true', r.code === 0 && c && !('action' in c) && c.actions.length === 8 && c.cover_url === 'https://x/c.png' && c.shareable === true && c.actions.every((x) => x.color === '#000000'), { code: r.code, err: r.err.slice(-300) }); }
  { const r = await run(contact, card({ description: 'only description', cover: { url: 'https://x/c.png', mime_type: 'image/png', width: 1280, height: 800, thumbnail: 'LEHV6nWB2yk8' }, actions: acts(1) })); const c = JSON.parse(plain(r.api.messages[0]));
    check('V1 card: description-only + cover object OK', r.code === 0 && c.cover.width === 1280 && c.shareable === true, { code: r.code, err: r.err.slice(-200) }); }
  { const r = await run(contact, card({ title: 'T', description: 'D https://x.com/a', cover_url: 'https://x/c.png' })); const c = r.api.messages[0] && JSON.parse(plain(r.api.messages[0]));
    const r2 = await run(contact, card({ title: 'T', cover: { url: 'https://x/c.png', mime_type: 'image/png', width: 600, height: 300, thumbnail: 'LEHV6nWB2yk8' }, actions: [] })); const c2 = r2.api.messages[0] && JSON.parse(plain(r2.api.messages[0]));
    check('V1 no-button card with cover: actions omitted or [] -> sent with actions:[], no action key, WARN logged', r.code === 0 && c && Array.isArray(c.actions) && c.actions.length === 0 && !('action' in c) && /no buttons/.test(r.err + r.out) && r2.code === 0 && c2 && c2.actions.length === 0 && c2.cover.url === 'https://x/c.png', { code: r.code, err: r.err.slice(-200) }); }
  { const r = await run(contact, card({ title: 'T', description: 'D', actions: [] }));
    check('V1 actions:[] without cover -> exit 2, nothing sent', r.code === 2 && r.sentCount === 0 && /without buttons needs/.test(r.err + r.out)); }
  { const a = await run(contact, card({ actions: acts(1) })); const b = await run(contact, card({ title: 'x', description: 'y' })); const c = await run(contact, card({ title: 'x', actions: acts(1), cover_url: 'http://insecure' })); const d = await run(contact, card({ ...V0, shareable: 'yes' }));
    check('V1 validation: needs title/description; needs action or actions; https cover; boolean shareable (exit 2, nothing sent)', [a, b, c, d].every((r) => r.code === 2 && r.sentCount === 0), [a, b, c, d].map((r) => [r.code, r.err.split('\n')[0].slice(0, 120)])); }
  { const r = await run(contact, card({ ...V0, description: 'd'.repeat(1000) }));
    const r2 = await run(contact, card({ ...V0, description: 'd'.repeat(1025) }));
    check('description warning threshold 1024 (1000: no warn; 1025: warn)', r.code === 0 && !/description >1024/.test(r.log) && r2.code === 0 && /WARN card description >1024/.test(r2.log), { a: r.code, b: r2.code }); }
  { const r = await run(contact, card({ title: 'Q', actions: [{ label: 'yes', action: 'input:yes' }, { label: 'web', action: 'https://mixin.one' }] }));
    const r0 = await run(contact, card({ ...V0, action: 'input:hello' }));
    check('input: action -> WARN cannot be forwarded (V1 and V0), still sent', r.code === 0 && /WARN card has an input: action; iOS cannot forward/.test(r.log) && r0.code === 0 && /iOS cannot forward/.test(r0.log)); }
  { const r = await run(contact, card({ title: 'Q', actions: [{ label: 'share', action: 'input:share' }] }));
    check('input:share -> extra WARN (does not exist)', r.code === 0 && /input:share" does not exist/.test(r.log)); }
  { const r = await run(contact, ['--buttons', JSON.stringify(acts(7))]);
    check('APP_BUTTON_GROUP still limited to 1..6', r.code === 2 && /1\.\.6 buttons/.test(r.err) && r.sentCount === 0, r.err.slice(-200)); }
  { const gw = await fakeGateway(); const r = await run(grp, card({ title: 'Q', actions: acts(1) }), { gw }); const r0 = await run(grp, card(V0), { gw }); await gw.close();
    check('groups still refuse cards (V0 and V1): exit 2, nothing sent', r.code === 2 && r0.code === 2 && /no encrypted form/.test(r.err) && r.sentCount === 0 && r0.sentCount === 0, { a: r.code, b: r0.code }); }

  // ---------------- B) --mention ----------------
  { const gw = await fakeGateway();
    const r = await run(grp, ['--text', '测试 @ 提及', '--mention', A, '--user', A], { gw });
    const m = r.created[0];
    check('group --mention: one ENCRYPTED_TEXT via gateway, Blaze mentions=[A], no recipient_id', r.code === 0 && r.created.length === 1 && m.category === 'ENCRYPTED_TEXT' && JSON.stringify(m.mentions) === JSON.stringify([A]) && !m.recipient_id && r.sentCount === 1 && /via=gateway mode=group-encrypted/.test(r.log), { code: r.code, err: r.err.slice(-300), m: m && { cat: m.category, mentions: m.mentions } });
    check('group --mention: every member decrypts "@7000123 测试 @ 提及"', m && dec(m, sA) === '@7000123 测试 @ 提及' && dec(m, sB) === '@7000123 测试 @ 提及');
    check('group --mention: stdout has mentions [{user_id, identity_number}]; endpoint logs mentions=1', r.json && r.json.ok && r.json.category === 'ENCRYPTED_TEXT' && JSON.stringify(r.json.mentions) === JSON.stringify([{ user_id: A, identity_number: '7000123' }]) && gw.logs.some((l) => /send endpoint msg=\S+ .*cat=ENCRYPTED_TEXT mentions=1 ok/.test(l)), { json: r.json, ep: gw.logs.filter((l) => /send endpoint/.test(l)) });
    check('group --mention: lookup was GET /users/<id> only (read-only)', r.reqs.filter((x) => x.url.startsWith('/users/')).every((x) => x.method === 'GET') && r.reqs.some((x) => x.url === `/users/${A}`));
    const r2 = await run(grp, ['--text', 'hi @7000123, see this', '--mention', A], { gw });
    check('text already has @7000123 -> not prefixed again', r2.code === 0 && dec(r2.created[0], sA) === 'hi @7000123, see this', r2.err.slice(-200));
    const r3 = await run(grp, ['--text', 'two', '--mention', `${A},${B}`, '--mention', A], { gw });
    check('repeatable + comma list, deduped, order kept: "@7000123 @37160854 two", mentions [A,B]', r3.code === 0 && dec(r3.created[0], sB) === '@7000123 @37160854 two' && JSON.stringify(r3.created[0].mentions) === JSON.stringify([A, B]), r3.err.slice(-200));
    const r4 = await run(grp, ['--text', '**bold** and\n- list', '--mention', A], { gw });
    check('markdown-looking text with --mention stays TEXT (clients parse mentions in _TEXT only)', r4.code === 0 && r4.created[0].category === 'ENCRYPTED_TEXT', r4.created[0] && r4.created[0].category);
    const r5 = await run(grp, ['--text', 'x', '--mention', OUT], { gw });
    check('mention of a non-member: sent, WARN logged', r5.code === 0 && /WARN --mention user not in the group/.test(r5.log));
    const r6 = await run(grp, ['--sticker', uuid(), '--text', 'hello', '--mention', A], { gw });
    check('multi-item reply: mentions only on the text message', r6.code === 0 && r6.created.length === 2 && !r6.created.find((x) => x.category === 'ENCRYPTED_STICKER').mentions && JSON.stringify(r6.created.find((x) => x.category === 'ENCRYPTED_TEXT').mentions) === JSON.stringify([A]), r6.err.slice(-200));
    // usage errors: nothing sent, no lookup
    const bads = [['--text', 'x', '--mention', 'nope'], ['--text', 'x', '--mention', ks.app_id], ['--sticker', uuid(), '--mention', A], ['--text', 'x', '--mention', '']];
    const br = []; for (const a of bads) br.push(await run(grp, a, { gw }));
    check('usage errors (bad uuid, bot itself, no --text, empty) -> exit 2, nothing sent', br.every((x) => x.code === 2 && x.sentCount === 0), br.map((x) => [x.code, x.err.split('\n')[0].slice(0, 100)]));
    const r7 = await run(grp, ['--text', 'x', '--mention', A], { gw, apiUsers: {} });
    check('lookup fails (404) -> exit 1 MENTION/lookup error, nothing sent', r7.code === 1 && /lookup failed|no identity_number/.test(r7.err) && r7.sentCount === 0, { code: r7.code, err: r7.err.slice(-200) });
    const r8 = await run(grp, ['--recall', uuid(), '--mention', A], { gw });
    check('--recall + --mention -> exit 2', r8.code === 2 && r8.sentCount === 0);
    // endpoint validation
    const p = { conversation_id: grp.conversation_id, message_id: uuid(), category: 'ENCRYPTED_TEXT', data_base64: 'eA' };
    const e1 = await sendViaEndpoint({ ...p, mentions: ['not-a-uuid'] }, { socketPath: gw.socketPath }).catch((e) => e);
    const e2 = await sendViaEndpoint({ ...p, mentions: Array.from({ length: 101 }, uuid) }, { socketPath: gw.socketPath }).catch((e) => e);
    check('endpoint rejects bad mentions (non-uuid, >100) as BAD_REQUEST, nothing sent', e1 && e1.code === 'BAD_REQUEST' && e2 && e2.code === 'BAD_REQUEST' && gw.bz.st.created.length === 0, { e1: e1 && e1.code, e2: e2 && e2.code });
    await gw.close(); }
  { const r = await run(contact, ['--text', 'hello', '--mention', A, '--user', A]); const m = r.api.messages[0];
    check('1:1 --mention: text prefixed, REST body has no mentions field (REST: text carries the mention)', r.code === 0 && m && plain(m) === '@7000123 hello' && !('mentions' in m) && m.category === 'PLAIN_TEXT', { code: r.code, err: r.err.slice(-200) }); }
  { const r = await run(contact, ['--text', 'plain']);
    check('without --mention: stdout unchanged (no mentions key)', r.code === 0 && r.json && !('mentions' in r.json) && Object.keys(r.json).join() === 'ok,message_id,category', r.json); }
  { const h = runNode(['reply.js', '--help'], { cwd: HERE }); const r = await h.done;
    check('--help documents --mention and the V0/V1 card rules', r.code === 0 && /--mention <user_id>/.test(r.out) && /new V1/.test(r.out) && /shareable/.test(r.out)); }
  fs.rmSync(W, { recursive: true, force: true });
  finish('builder');
})().catch((e) => { console.error('FAIL crash', e); process.exit(1); });
