'use strict';
// P0 features (offline; fake Mixin API, fake Blaze, in-process fake gateway; nothing real is contacted):
//  A) reply.js --recall: 1:1 via REST, own-message check (sent-log / context store / gateway.log), group refused by
//     default (MESSAGE_RECALL has no encrypted form), MIXIN_GROUP_RECALL=1 via the gateway endpoint (narrow allowlist,
//     own ids only), fallback to own Blaze with the CURRENTLY LIVE (old) gateway endpoint, comma/repeat, usage.
//  B) send-endpoint recall allowlist unit checks.
//  C) check-encryption.js / reply.js --check-encryption: JSON + exit 0/3/1/2, read-only.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { check, finish, uuid, fakeKeystore, ksJson, tmpdir, fakeMixinApi, fakeBlaze, runNode, curvePub } = require('./test-helpers');
const { v5: uuidv5 } = require('uuid');
require('./ws-shim');
const { createBlazeConn } = require('./blaze-conn');
const { createSendEndpoint, recallTarget, validate } = require('./send-endpoint');
const { uniqueConversationId } = require('./conversation-target');
const HERE = __dirname, NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const W = tmpdir('p0-');
// The new endpoint (MESSAGE_RECALL allowlist) needs a gateway restart; before that the deployed send-endpoint.js is the
// fix #4 one. Then the gateway-path cases are skipped and only the fallback is checked.
const NEW_EP = typeof recallTarget === 'function';
const skip = (name) => console.log('SKIP', name, '(send-endpoint.js without the P0 recall allowlist; needs the staged gateway files)');
const ks = fakeKeystore();
const A = uuid(), B = uuid(), C = uuid();
const mk = (user_id, key = true) => { const seed = crypto.randomBytes(32); return { user_id, session_id: uuid(), public_key: key ? curvePub(seed) : '' }; };
const botSess = { user_id: ks.app_id, session_id: ks.session_id, public_key: curvePub(ks._seed) };
const sA = mk(A), sB = mk(B), sC = mk(C);
const CONTACT = uniqueConversationId(ks.app_id, A);
const contactConv = { conversation_id: CONTACT, category: 'CONTACT', participants: [{ user_id: A }, { user_id: ks.app_id }], participant_sessions: [sA, botSess] };
const group = (sessions = [sA, sB, sC, botSess], users = [A, B, C]) => ({ conversation_id: uuid(), category: 'GROUP', participants: [...users, ks.app_id].map((u) => ({ user_id: u })), participant_sessions: sessions });
const SENT = path.join(W, 'sent-log.jsonl'), GLOG = path.join(W, 'g.log'), CTX = path.join(W, 'ctx');
process.env.MIXIN_SENT_LOG_FILE = SENT; process.env.MIXIN_GATEWAY_LOG = GLOG; process.env.MIXIN_CONTEXT_DIR = CTX; // in-process endpoint uses the same files
const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();

async function fakeGateway({ endpointModule = './send-endpoint', isOwn } = {}) {
  const bz = await fakeBlaze(); const logs = []; const log = (...a) => logs.push(a.join(' '));
  const conn = createBlazeConn({ keystore: JSON.parse(ksJson(ks)), url: bz.url, log, onDead: () => {}, handler: { onMessage: () => {} } });
  conn.start(); for (let i = 0; i < 50 && !(conn.current() && conn.current().open); i++) await new Promise((r) => setTimeout(r, 100));
  const socketPath = path.join(tmpdir('p0-sock-'), 'run', 'send.sock');
  const ep = require(endpointModule).createSendEndpoint({ blaze: conn, log, socketPath, botId: ks.app_id, ...(isOwn ? { isOwn } : {}) });
  for (let i = 0; i < 50 && !fs.existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 20));
  return { bz, logs, socketPath, close: async () => { ep.close(); conn.stop(); await bz.close(); } };
}
async function run(args, { convs = {}, sessions = { [A]: [sA] }, env = {}, gw = null, cwd = HERE } = {}) {
  const api = await fakeMixinApi({ sessions, conversations: convs, messageHook: (b) => { const arr = Array.isArray(b) ? b : [b]; if (arr.some((x) => !x.recipient_id)) return { status: 202, json: { error: { status: 202, code: 10002, description: 'bad', extra: { field: 'recipient_id' } } } }; return null; } });
  const bz = await fakeBlaze();
  const p = runNode([path.join(cwd, 'reply.js'), ...args], { cwd, timeoutMs: 60000, env: { MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_GATEWAY_LOG: GLOG, MIXIN_API_BASE: api.url, MIXIN_BLAZE_URL: bz.url, MIXIN_BLAZE_SEND_TIMEOUT_MS: '3000',
    HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', MIXIN_CONTEXT_DIR: CTX, MIXIN_SENT_LOG_FILE: SENT, MIXIN_CONV_CACHE_FILE: path.join(W, `c-${uuid()}.json`), ...(gw ? { MIXIN_SEND_SOCKET: gw.socketPath } : {}), ...env } });
  const r = await p.done; await api.close(); const bst = bz.st; await bz.close();
  let json = null; try { json = JSON.parse(r.out.trim().split('\n').pop()); } catch (_) {}
  let ejson = null; try { ejson = JSON.parse(r.err.trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch (_) {}
  return { ...r, api: api.state, reqs: api.reqs, blaze: bst, json, ejson };
}
const recallsIn = (list) => list.filter((m) => m.category === 'MESSAGE_RECALL');

(async () => {
  // ---------------- A) recall ----------------
  // a normal 1:1 reply records our message id in the sent-log
  const s1 = await run(['--conversation', CONTACT, '--user', A, '--reply-to', uuid(), '--text', '秘密内容一'], { convs: { [CONTACT]: contactConv } });
  const mine = s1.json && s1.json.message_id;
  const slog = fs.existsSync(SENT) ? fs.readFileSync(SENT, 'utf8') : '';
  check('sent-log: reply.js records its sent message (id, conv, category; 0600; no content)', s1.code === 0 && slog.includes(mine) && slog.includes(CONTACT) && !slog.includes('秘密内容一') && (fs.statSync(SENT).mode & 0o777) === 0o600, { code: s1.code, err: s1.err.slice(-300) });
  { const r = await run(['--conversation', CONTACT, '--user', A, '--recall', mine], { convs: { [CONTACT]: contactConv } }); const m = recallsIn(r.api.messages)[0];
    check('1:1 recall: MESSAGE_RECALL via REST /messages, recipient_id=--user, data {message_id}', r.code === 0 && m && m.recipient_id === A && m.conversation_id === CONTACT && JSON.parse(b64(m.data_base64)).message_id === mine && Object.keys(JSON.parse(b64(m.data_base64))).length === 1 && r.blaze.conns === 0, { code: r.code, err: r.err.slice(-300) });
    check('1:1 recall: id = UUIDv5(mixin-recall:<target>), stdout JSON, log line', m && m.message_id === uuidv5(`mixin-recall:${mine}`, NS) && r.json && r.json.ok && r.json.recalled[0].message_id === mine && r.json.recalled[0].recall_message_id === m.message_id && r.json.recalled[0].via === 'rest' && /reply recall sent target=\S+ msg=\S+ conv=\S+ via=rest mode=contact/.test(r.err)); }
  { const r = await run(['--conversation', CONTACT, '--recall', mine], { convs: { [CONTACT]: contactConv } }); const m = recallsIn(r.api.messages)[0];
    check('1:1 recall without --user: recipient = the other member of the conversation', r.code === 0 && m && m.recipient_id === A, r.err.slice(-300)); }
  { const other = uuid(); const r = await run(['--conversation', CONTACT, '--user', A, '--recall', `${mine},${other}`], { convs: { [CONTACT]: contactConv } });
    check('recall of a message that is not ours -> exit 2 NOT_OWN_MESSAGE, NOTHING sent (all-or-nothing)', r.code === 2 && r.ejson && r.ejson.code === 'NOT_OWN_MESSAGE' && r.ejson.message_ids.join() === other && r.api.messages.length === 0 && r.blaze.created.length === 0, r.err.slice(-300)); }
  { const g = group(); const r = await run(['--conversation', g.conversation_id, '--user', A, '--recall', mine], { convs: { [g.conversation_id]: g } });
    check('our message id but from ANOTHER conversation -> refused, nothing sent', r.code === 2 && r.ejson && r.ejson.code === 'NOT_OWN_MESSAGE' && r.api.messages.length === 0); }
  { const r = await run(['--conversation', CONTACT, '--user', A, '--recall', mine, '--text', 'x'], { convs: { [CONTACT]: contactConv } });
    const r2 = await run(['--conversation', CONTACT, '--recall', 'not-a-uuid'], { convs: { [CONTACT]: contactConv } });
    check('--recall + content flag -> usage exit 2; bad id -> exit 2; nothing sent', r.code === 2 && r2.code === 2 && r.api.messages.length === 0 && r2.api.messages.length === 0); }

  // group: our message ids (as reply.js would have recorded them)
  const sl = require('./sent-log');
  const g = group(); const G = g.conversation_id; const gm1 = uuid(), gm2 = uuid(), gm3 = uuid();
  for (const id of [gm1, gm2]) sl.record({ message_id: id, conversation_id: G, category: 'ENCRYPTED_TEXT', via: 'group' });
  { const gw = await fakeGateway(); const r = await run(['--conversation', G, '--user', A, '--recall', gm1], { convs: { [G]: g }, gw });
    check('GROUP recall refused by default: exit 2 GROUP_RECALL_REFUSED, nothing sent anywhere (gateway, own Blaze, REST)', r.code === 2 && r.ejson && r.ejson.code === 'GROUP_RECALL_REFUSED' && /no encrypted form/.test(r.ejson.error) && gw.bz.st.created.length === 0 && r.blaze.created.length === 0 && r.blaze.conns === 0 && r.api.messages.length === 0 && r.api.encrypted.length === 0 && /reply recall refused conv=\S+ reason=group_recall_plaintext/.test(r.err), r.err.slice(-300));
    await gw.close(); }
  if (!NEW_EP) skip('MIXIN_GROUP_RECALL=1 via gateway endpoint'); else { const gw = await fakeGateway(); const r = await run(['--conversation', G, '--recall', `${gm1},${gm2}`, '--recall', gm1], { convs: { [G]: g }, gw, env: { MIXIN_GROUP_RECALL: '1' } }); const c = gw.bz.st.created;
    check('MIXIN_GROUP_RECALL=1: recall sent on the gateway main connection (no recipient_id), deduped, own Blaze unused', r.code === 0 && c.length === 2 && c.every((m) => m.category === 'MESSAGE_RECALL' && !('recipient_id' in m) && m.conversation_id === G) && JSON.parse(b64(c[0].data_base64)).message_id === gm1 && JSON.parse(b64(c[1].data_base64)).message_id === gm2 && r.blaze.conns === 0 && r.api.messages.length === 0 && r.json.recalled.every((x) => x.via === 'gateway') && /mode=group-control/.test(r.err), { code: r.code, err: r.err.slice(-300) });
    check('gateway endpoint logs recall target, metadata only', gw.logs.some((l) => new RegExp(`cat=MESSAGE_RECALL target=${gm1} ok`).test(l)));
    await gw.close(); }
  if (!NEW_EP) skip('gateway refuses unverifiable recall'); else { const gw = await fakeGateway({ isOwn: () => false }); const r = await run(['--conversation', G, '--recall', gm1], { convs: { [G]: g }, gw, env: { MIXIN_GROUP_RECALL: '1' } });
    check('gateway refuses a recall it cannot verify -> exit 1 NOT_OWN_MESSAGE, NO fallback to own Blaze', r.code === 1 && r.ejson && r.ejson.code === 'NOT_OWN_MESSAGE' && gw.bz.st.created.length === 0 && r.blaze.created.length === 0 && r.blaze.conns === 0, r.err.slice(-300));
    await gw.close(); }
  { const gw = await fakeGateway({ endpointModule: './test-old-send-endpoint' }); // fix #4 endpoint = the gateway running before the P0 restart
    const r = await run(['--conversation', G, '--recall', gm2], { convs: { [G]: g }, gw, env: { MIXIN_GROUP_RECALL: '1' } });
    check('old endpoint rejects MESSAGE_RECALL (BAD_REQUEST) -> exit 1 ENDPOINT_UNAVAILABLE, not retried, NO own Blaze, nothing sent', r.code === 1 && r.ejson && r.ejson.code === 'ENDPOINT_UNAVAILABLE' && gw.bz.st.created.length === 0 && r.blaze.created.length === 0 && r.blaze.conns === 0 && /code=BAD_REQUEST -> giving up/.test(r.err) && !/try=1/.test(r.err), r.err.slice(-300));
    await gw.close(); }
  { // other proof sources: context store (from_bot) and gateway.log "reply sent" lines
    const cs = require('./context-store'); cs.append({ conversation_id: G, user_id: ks.app_id, message_id: gm3, text: '[x]', created_at: new Date().toISOString(), from_bot: true }, { dir: CTX });
    const gm4 = uuid(); fs.appendFileSync(GLOG, `[2026-10-18T00:00:00.000Z] reply sent msg=${gm4} conv=${G} cat=ENCRYPTED_TEXT via=gateway mode=group-encrypted sessions=3\n`);
    const ok3 = sl.isOwn(G, gm3, { botId: ks.app_id }), ok4 = sl.isOwn(G, gm4), no = sl.isOwn(G, uuid()), wrongConv = sl.isOwn(uuid(), gm4);
    check('own-message proof: context store (from_bot) and gateway.log "reply sent" lines accepted; unknown / wrong conversation rejected', ok3.own && ok3.source === 'context' && ok4.own && ok4.source === 'gateway-log' && !no.own && !wrongConv.own, { ok3, ok4 }); }
  { const gw = await fakeGateway(); const g5 = group(); const r = await run(['--conversation', g5.conversation_id, '--user', A, '--reply-to', uuid(), '--text', '群内容'], { convs: { [g5.conversation_id]: g5 }, gw });
    const all = [...gw.bz.st.created, ...r.blaze.created, ...r.api.messages, ...r.api.encrypted];
    const rec = fs.readFileSync(SENT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.conversation_id === g5.conversation_id);
    check('group reply still encrypted only (never plain) and recorded in the sent-log as ENCRYPTED_TEXT via=group', r.code === 0 && all.length === 1 && all[0].category === 'ENCRYPTED_TEXT' && rec && rec.category === 'ENCRYPTED_TEXT' && rec.via === 'group', r.err.slice(-300));
    await gw.close(); }

  // ---------------- B) endpoint allowlist unit ----------------
  if (!NEW_EP) skip('endpoint allowlist unit checks'); else { const base = { conversation_id: G, message_id: uuid(), category: 'MESSAGE_RECALL', status: 'SENT' };
    const d = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    check('endpoint: MESSAGE_RECALL with exactly {message_id} accepted', validate({ action: 'CREATE_MESSAGE', params: { ...base, data_base64: d({ message_id: gm1 }) } }) === null && recallTarget({ ...base, data_base64: d({ message_id: gm1 }) }) === gm1);
    check('endpoint: MESSAGE_RECALL with extra data, recipient_id, quote or bad id rejected', [
      { ...base, data_base64: d({ message_id: gm1, text: 'x' }) }, { ...base, recipient_id: A, data_base64: d({ message_id: gm1 }) },
      { ...base, quote_message_id: gm1, data_base64: d({ message_id: gm1 }) }, { ...base, data_base64: d({ message_id: 'x' }) }, { ...base, data_base64: 'bm90IGpzb24' },
    ].every((p) => validate({ action: 'CREATE_MESSAGE', params: p }) !== null));
    check('endpoint: PLAIN_TEXT / APP_CARD still rejected', ['PLAIN_TEXT', 'APP_CARD', 'PLAIN_POST'].every((cat) => validate({ action: 'CREATE_MESSAGE', params: { ...base, category: cat, data_base64: 'eA' } }) !== null)); }

  // ---------------- C) check-encryption ----------------
  const ce = async (args, convs, sessions = {}, via = 'script') => {
    const api = await fakeMixinApi({ sessions, conversations: convs });
    const p = runNode(via === 'script' ? ['check-encryption.js', ...args] : ['reply.js', '--check-encryption', ...args], { cwd: HERE, env: { MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_GATEWAY_LOG: GLOG, MIXIN_API_BASE: api.url, HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', MIXIN_CONV_CACHE_FILE: path.join(W, `c-${uuid()}.json`) } });
    const r = await p.done; await api.close();
    let json = null; try { json = JSON.parse(r.out.trim()); } catch (_) {}
    return { ...r, json, writes: api.reqs.filter((x) => x.method !== 'GET' && x.url !== '/sessions/fetch') };
  };
  { const g1 = group(); const r = await ce(['--conversation', g1.conversation_id], { [g1.conversation_id]: g1 });
    check('check-encryption: everyone can receive -> exit 0, JSON, bot not listed, nothing written', r.code === 0 && r.json && r.json.all_can_receive === true && r.json.members_total === 3 && r.json.members.every((m) => m.can_receive && m.sessions === 1 && m.sessions_with_key === 1) && !r.json.members.some((m) => m.user_id === ks.app_id) && r.writes.length === 0, { code: r.code, out: r.out.slice(0, 300), err: r.err.slice(-200) }); }
  { const D = uuid(); const g2 = group([sA, mk(B, false), botSess], [A, B, C, D]); const r = await ce(['--conversation', g2.conversation_id], { [g2.conversation_id]: g2 }, { [C]: [sC] });
    const by = r.json ? Object.fromEntries(r.json.members.map((m) => [m.user_id, m])) : {};
    check('check-encryption: session without key / no session -> exit 3, reasons; /sessions/fetch fills a lagging member', r.code === 3 && r.json.all_can_receive === false && by[B].reason === 'no_public_key' && by[D].reason === 'no_session' && by[C].can_receive === true && by[A].can_receive && r.json.missing.sort().join() === [B, D].sort().join(), r.json); }
  { const g3 = group(); const r = await ce(['--conversation', g3.conversation_id], { [g3.conversation_id]: g3 }, {}, 'reply');
    check('reply.js --check-encryption = same JSON + exit code', r.code === 0 && r.json && r.json.conversation_id === g3.conversation_id && r.json.all_can_receive === true, r.err.slice(-200)); }
  { const r = await ce(['--conversation', uuid()], {}); const u = await ce([], {}); const ur = await ce([], {}, {}, 'reply');
    check('check-encryption: unknown conversation -> exit 1 JSON error; missing --conversation -> exit 2', r.code === 1 && /"ok":false/.test(r.err) && u.code === 2 && ur.code === 2, { r: r.code, u: u.code, ur: ur.code }); }
  check('logs contain no message content', !fs.readFileSync(GLOG, 'utf8').includes('秘密内容一'));
  finish('p0');
})().catch((e) => { console.error(e); process.exit(1); });
