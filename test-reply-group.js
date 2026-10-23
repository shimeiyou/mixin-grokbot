'use strict';
// Group replies (fix #3) against a fake Mixin REST API + fake Blaze (clean env, nothing real is contacted).
//  GROUP: ALWAYS ENCRYPTED_* over Blaze CREATE_MESSAGE, no recipient_id, encrypted to every member session (bot excluded),
//         conversation_checksum = md5(all participant session ids); 20140 -> refresh + retry once.
//  FALLBACK: private ENCRYPTED to --user via REST /encrypted_messages (recipient_id=--user). Never plain in a group.
//  CONTACT: unchanged.
//  fix #4 + W-6 (2026-10-18): group sends go ONLY through the gateway's send endpoint (its MAIN Blaze connection,
//         via=gateway). reply.js never opens a Blaze socket; endpoint unreachable -> exit 1 ENDPOINT_UNAVAILABLE, nothing
//         sent. Mixin rejections still fall back to the private encrypted REST message.
//  Every run() here gets an in-process fake gateway (endpoint + blaze-conn to a fake Blaze) unless gw/noGateway is given;
//  reply.js is also pointed at a second fake Blaze ("own") that must never see a connection.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const { execFileSync } = require('child_process');
const { check, finish, uuid, fakeKeystore, ksJson, tmpdir, fakeMixinApi, fakeBlaze, runNode, curvePub } = require('./test-helpers');
const mc = require('./mixin-crypto');
const { decryptAttachment } = require('./attachment-crypto');
const { uniqueConversationId } = require('./conversation-target');
const HERE = __dirname;
require('./ws-shim');
const { createBlazeConn } = require('./blaze-conn');
const { createSendEndpoint, sendViaEndpoint } = require('./send-endpoint');
const ks = fakeKeystore();
const mk = (user_id) => { const seed = crypto.randomBytes(32); return { user_id, session_id: uuid(), public_key: curvePub(seed), _seed: seed }; };
const pub = (s) => { const { _seed, ...r } = s; return r; };
const A = uuid(), B = uuid(), C = uuid();
const W = tmpdir('reply-group3-');
const botSess = { user_id: ks.app_id, session_id: ks.session_id, public_key: curvePub(ks._seed), _seed: ks._seed };
const sA = mk(A), sB1 = mk(B), sB2 = mk(B), sC = mk(C); const members = [sA, sB1, sB2, sC];
function group(sessions = [...members, botSess], extraUsers = []) {
  const users = [...new Set([ks.app_id, ...sessions.map((s) => s.user_id), ...extraUsers])];
  return { conversation_id: uuid(), category: 'GROUP', participants: users.map((u) => ({ user_id: u })), participant_sessions: sessions.map(pub) };
}
const md5 = (list) => crypto.createHash('md5').update(list.map((s) => s.session_id || s).sort().join('')).digest('hex');
const dec = (m, s) => mc.decryptMessageData(m.data_base64, s.session_id, s._seed);
const header = (m) => { const b = mc.b64urlDecode(m.data_base64); const n = b.readUInt16LE(1); return [...Array(n)].map((_, i) => mc.bytesUuid(b.subarray(35 + i * 64, 51 + i * 64))); };
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const E10002 = { status: 202, code: 10002, description: 'The request data has invalid field.', extra: { field: 'recipient_id', reason: 'recipient id is not a valid uuid' } };
const E20140 = { status: 202, code: 20140, description: 'Conversation checksum invalid.' };
const FAILED = (b) => ({ json: { data: b.map((x) => ({ message_id: x.message_id, state: 'FAILED' })) } });

// In-process stand-in for the gateway: its main Blaze connection (blaze-conn.js) to a fake Blaze + the real send endpoint.
async function fakeGateway({ blazeOpts = {}, waitOpenMs = 10000, startBlaze = true } = {}) {
  const bz = await fakeBlaze(blazeOpts); const logs = []; const log = (...a) => logs.push(a.join(' '));
  const conn = createBlazeConn({ keystore: JSON.parse(ksJson(ks)), url: bz.url, log, onDead: () => {}, handler: { onMessage: () => {} } });
  if (startBlaze) { conn.start(); for (let i = 0; i < 50 && !(conn.current() && conn.current().open); i++) await new Promise((r) => setTimeout(r, 100)); }
  const socketPath = path.join(tmpdir('gw-sock-'), 'run', 'send.sock');
  const ep = createSendEndpoint({ blaze: conn, log, socketPath, waitOpenMs });
  for (let i = 0; i < 50 && !fs.existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 20));
  return { bz, logs, socketPath, conn, close: async () => { ep.close(); conn.stop(); await bz.close(); } };
}

async function run(conv, args, { apiOpts = {}, blazeOpts = {}, noBlaze = false, env = {}, sessions = { [A]: [pub(sA)] }, gw = null } = {}) {
  const autoGw = !gw && !noBlaze ? await fakeGateway({ blazeOpts }) : null;
  if (gw || autoGw) env = { MIXIN_SEND_SOCKET: (gw || autoGw).socketPath, ...env };
  else env = { MIXIN_SEND_SOCKET: path.join(W, 'no-gateway', 'send.sock'), ...env };
  const userHook = apiOpts.messageHook;
  const messageHook = (b, enc) => { const arr = Array.isArray(b) ? b : [b]; if (arr.some((x) => !x.recipient_id)) return { status: 202, json: { error: E10002 } }; return userHook ? userHook(b, enc) : null; };
  const api = await fakeMixinApi({ sessions, ...apiOpts, conversations: apiOpts.conversations || { [conv.conversation_id]: conv }, messageHook });
  const bz = await fakeBlaze(); // "own" Blaze: reply.js must never connect to it (W-6)
  const p = runNode(['reply.js', '--conversation', conv.conversation_id, '--reply-to', uuid(), ...args], { cwd: HERE, timeoutMs: 60000,
    env: { MIXIN_ATTACH_DIRS: W, MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_GATEWAY_LOG: path.join(W, 'g.log'), MIXIN_API_BASE: api.url, MIXIN_BLAZE_URL: bz.url, MIXIN_SEND_ENDPOINT_TRIES: '2', MIXIN_BLAZE_SEND_TIMEOUT_MS: '3000',
      HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', MIXIN_CONTEXT_DIR: path.join(W, 'ctx'), MIXIN_CONV_CACHE_FILE: path.join(W, `c-${uuid()}.json`), ...env } });
  const r = await p.done; await api.close(); const own = { ...bz.st }; await bz.close();
  const bst = autoGw ? { ...autoGw.bz.st, created: [...autoGw.bz.st.created], conns: own.conns } : { created: [], lists: 0, conns: own.conns, wsAcks: 0 };
  if (autoGw) await autoGw.close();
  const gets = api.reqs.filter((x) => x.method === 'GET' && x.url.startsWith('/conversations/')).length;
  const all = [...bst.created, ...api.state.messages, ...api.state.encrypted];
  return { ...r, api: api.state, blaze: bst, gets, noPlain: all.every((m) => String(m.category).startsWith('ENCRYPTED_')) && api.state.messages.length === 0,
    json: (() => { try { return JSON.parse(r.out.trim().split('\n').pop()); } catch (_) { return null; } })() };
}

(async () => {
  // ---- encrypted group success ----
  { const g = group(); const n = await run(g, ['--user', A, '--text', '群加密回复']); const m = n.blaze.created[0];
    check('group: ENCRYPTED_TEXT over Blaze CREATE_MESSAGE (even without --encrypted)', n.code === 0 && n.blaze.created.length === 1 && m.category === 'ENCRYPTED_TEXT', { m: m && m.category, err: n.err.slice(-400) });
    check('group: no recipient_id / recipient_sessions / checksum on the Blaze params', !('recipient_id' in m) && !('recipient_sessions' in m) && !('checksum' in m));
    check('group: encrypted to every member session, bot session excluded', sameSet(header(m), members.map((s) => s.session_id)) && !header(m).includes(ks.session_id));
    check('group: every member session decrypts it', members.every((s) => dec(m, s).toString() === '群加密回复'));
    check('group: conversation_checksum = md5(all participant session ids incl. bot)', m.conversation_checksum === md5([...members, botSess]));
    check('group: nothing via REST, nothing plain; stdout unchanged', n.noPlain && n.api.encrypted.length === 0 && n.out.trim() === JSON.stringify({ ok: true, message_id: m.message_id, category: 'ENCRYPTED_TEXT' }));
    check('group: via the gateway endpoint only (reply.js opened no Blaze socket), log mode=group-encrypted', n.blaze.conns === 0 && /via=gateway mode=group-encrypted sessions=4/.test(n.err), n.err.slice(-300)); }
  { const g = group(); const n = await run(g, ['--text', 'no user', '--incoming-category', 'ENCRYPTED_TEXT']);
    check('group without --user: encrypted Blaze send', n.code === 0 && n.blaze.created[0].category === 'ENCRYPTED_TEXT' && n.noPlain); }
  { const g = group(); const n = await run(g, ['--user', A, '--text', '# T\n- x', '--silent']); const m = n.blaze.created[0];
    check('group: ENCRYPTED_POST + silent', m.category === 'ENCRYPTED_POST' && m.silent === true); }

  // ---- checksum retry ----
  { const g = group(); const sNew = mk(C); let k = 0;
    const n = await run(g, ['--user', A, '--text', 'retry'], { blazeOpts: { onCreate: () => { if (k++ === 0) { g.participant_sessions.push(pub(sNew)); return { error: E20140 }; } return null; } } });
    const [m1, m2] = n.blaze.created;
    check('20140 -> fresh GET /conversations -> re-encrypted incl. new session -> ok', n.code === 0 && n.blaze.created.length === 2 && n.gets === 2 && m2.conversation_checksum === md5([...members, botSess, sNew]) && m1.conversation_checksum !== m2.conversation_checksum && dec(m2, sNew).toString() === 'retry' && m1.message_id === m2.message_id && n.noPlain && /group sessions refreshed code=20140/.test(n.err), n.err.slice(-500)); }
  { const g = group(); const n = await run(g, ['--user', A, '--text', 'twice'], { blazeOpts: { onCreate: () => ({ error: E20140 }) } });
    const p = n.api.encrypted[0];
    check('20140 twice -> FALLBACK private encrypted (recipient_id=--user, --user sessions only)', n.code === 0 && n.blaze.created.length === 2 && p && p.recipient_id === A && p.category === 'ENCRYPTED_TEXT' && sameSet(p.recipient_sessions.map((x) => x.session_id), [sA.session_id]) && p.checksum === md5([sA]) && dec(p, sA).toString() === 'twice' && n.noPlain, n.err.slice(-400));
    check('fallback logged: FALLBACK reason=group_send_rejected code=20140', /reply FALLBACK reason=group_send_rejected code=20140 conv=\S+ mode=private-encrypted recipient_id=/.test(n.err) && /via=rest mode=private-encrypted/.test(n.err)); }

  // ---- rejection -> private encrypted fallback ----
  { const g = group(); const n = await run(g, ['--user', A, '--text', 'a', '--sticker', uuid()], { blazeOpts: { onCreate: () => ({ error: E10002 }) } });
    check('Blaze 10002 -> private encrypted fallback, sticky for the 2nd item, nothing plain', n.code === 0 && n.blaze.created.length === 1 && n.api.encrypted.length === 2 && n.api.encrypted.every((m) => m.recipient_id === A && m.category.startsWith('ENCRYPTED_')) && n.noPlain && /reason=group_send_rejected code=10002 field=recipient_id/.test(n.err)); }
  { const g = group(); const n = await run(g, ['--user', A, '--text', 'down'], { noBlaze: true });
    check('no gateway (endpoint socket missing) -> retried, then exit 1 ENDPOINT_UNAVAILABLE, NOTHING sent (no private fallback, no own Blaze)', n.code === 1 && /"code":"ENDPOINT_UNAVAILABLE"/.test(n.err) && n.api.encrypted.length === 0 && n.api.messages.length === 0 && n.blaze.conns === 0 && /gateway endpoint unavailable code=ENOENT try=1\/2/.test(n.err) && /giving up \(no second Blaze connection/.test(n.err), n.err.slice(-400)); }

  // ---- missing pubkey ----
  { const g = group(); g.participant_sessions.find((s) => s.session_id === sC.session_id).public_key = '';
    const n = await run(g, ['--user', A, '--text', 'nokey']);
    check('member without public key -> no Blaze send, private encrypted fallback, member logged', n.code === 0 && n.blaze.created.length === 0 && n.api.encrypted.length === 1 && n.api.encrypted[0].recipient_id === A && n.noPlain && new RegExp(`reason=member_without_pubkey users=${C}`).test(n.err), n.err.slice(-400)); }
  { const D = uuid(); const g = group(undefined, [D]); const n = await run(g, ['--user', A, '--text', 'nosession']);
    check('member with no session at all -> private encrypted fallback naming that member', n.code === 0 && n.blaze.created.length === 0 && n.api.encrypted.length === 1 && n.noPlain && n.err.includes(`users=${D}`)); }

  // ---- private fallback failing ----
  { const g = group(); const n = await run(g, ['--user', A, '--text', 'fail'], { blazeOpts: { onCreate: () => ({ error: E10002 }) }, apiOpts: { messageHook: () => ({ status: 403, json: { error: { code: 403, status: 403, description: 'forbidden' } } }) } });
    check('private fallback rejected -> exit 1, error JSON, NOTHING plain', n.code === 1 && /"ok":false/.test(n.err) && /nothing sent plain/.test(n.err) && n.noPlain && n.api.encrypted.length === 1, n.err.slice(-300)); }
  { const g = group(); let k = 0; const n = await run(g, ['--user', A, '--text', 'pf'], { blazeOpts: { onCreate: () => ({ error: E10002 }) }, apiOpts: { messageHook: (b, enc) => (enc && k++ === 0 ? FAILED(b) : null) } });
    check('private fallback state FAILED -> refresh --user sessions -> retry once -> ok', n.code === 0 && n.api.encrypted.length === 2 && n.noPlain && /private sessions refreshed/.test(n.err)); }
  { const g = group(); const n = await run(g, ['--user', A, '--text', 'pf2'], { blazeOpts: { onCreate: () => ({ error: E10002 }) }, apiOpts: { messageHook: (b, enc) => (enc ? FAILED(b) : null) } });
    check('private fallback FAILED twice -> exit 1, nothing plain', n.code === 1 && n.api.encrypted.length === 2 && n.noPlain); }
  { const g = group(); const n = await run(g, ['--text', 'nouser'], { blazeOpts: { onCreate: () => ({ error: E10002 }) } });
    check('rejected and no --user -> exit 1 NO_PRIVATE_TARGET, nothing plain', n.code === 1 && /NO_PRIVATE_TARGET/.test(n.err) && n.noPlain && n.api.encrypted.length === 0); }
  { const g = group(); g.participant_sessions[0].public_key = ''; const n = await run(g, ['--user', A, '--text', 'x'], { sessions: {} });
    check('--user has no session with key -> exit 1 NO_PRIVATE_SESSIONS, nothing sent', n.code === 1 && /NO_PRIVATE_SESSIONS/.test(n.err) && n.blaze.created.length === 0 && n.api.encrypted.length === 0 && n.api.messages.length === 0); }

  // ---- switches / unknown / non-encryptable ----
  { const g = group(); const n = await run(g, ['--user', A, '--text', 'off'], { env: { MIXIN_GROUP_ENCRYPT: '0' } });
    check('MIXIN_GROUP_ENCRYPT=0 -> private ENCRYPTED, never plain', n.code === 0 && n.blaze.created.length === 0 && n.api.encrypted.length === 1 && n.noPlain && /reason=group_encrypt_disabled/.test(n.err)); }
  { const g = group(); const n = await run({ ...g, conversation_id: uuid() }, ['--user', A, '--text', 'u'], { apiOpts: { conversations: {} } });
    check('unknown conversation -> private encrypted fallback, nothing plain', n.code === 0 && n.blaze.created.length === 0 && n.api.encrypted.length === 1 && n.noPlain && /reason=conversation_lookup_failed/.test(n.err)); }
  { const g = group(); const n = await run(g, ['--user', A, '--card', JSON.stringify({ title: 't', description: 'd', icon_url: 'https://x/i.png', action: 'https://x' })]);
    check('--card in a group -> exit 2, nothing sent (no encrypted form)', n.code === 2 && n.blaze.created.length === 0 && n.api.messages.length === 0 && n.api.encrypted.length === 0 && /no encrypted form/.test(n.err)); }
  { const g = group(); const n = await run(g, ['--user', A, '--text', 'x', '--buttons', JSON.stringify([{ label: 'ok', action: 'input:ok' }])]);
    check('--buttons in a group -> exit 2 before anything is sent', n.code === 2 && n.blaze.created.length === 0); }

  // ---- --quote + attachments ----
  const png = path.join(W, 'a.png'); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=1', '-frames:v', '1', png]); const PNGB = fs.readFileSync(png);
  const Q = uuid();
  { const g = group(); const n = await run(g, ['--user', A, '--text', '看图', '--image', png, '--quote', Q]);
    const [t, im] = n.blaze.created; const d = im && JSON.parse(dec(im, sB2));
    check('group --quote + --image: ENCRYPTED_TEXT(quote) + ENCRYPTED_IMAGE over Blaze', n.code === 0 && t.category === 'ENCRYPTED_TEXT' && t.quote_message_id === Q && im.category === 'ENCRYPTED_IMAGE' && !im.quote_message_id && n.noPlain && n.json.messages.length === 2, n.err.slice(-300));
    check('group image: ciphertext uploaded, every member can open key/digest', d && !n.api.uploads[d.attachment_id].equals(PNGB) && decryptAttachment(n.api.uploads[d.attachment_id], d.key, d.digest).equals(PNGB) && members.every((s) => JSON.parse(dec(im, s)).attachment_id === d.attachment_id)); }
  { const g = group(); const n = await run(g, ['--user', A, '--image', png, '--quote', Q], { blazeOpts: { onCreate: () => ({ error: E10002 }) } });
    const p = n.api.encrypted[0]; const d = p && JSON.parse(dec(p, sA));
    check('image fallback: private ENCRYPTED_IMAGE keeps quote, same ciphertext upload (no re-upload)', p && p.category === 'ENCRYPTED_IMAGE' && p.quote_message_id === Q && p.recipient_id === A && n.api.created.length === 1 && decryptAttachment(n.api.uploads[d.attachment_id], d.key, d.digest).equals(PNGB) && n.noPlain); }

  // ---- fix #4: via the gateway's main connection ----
  { const gw = await fakeGateway(); const g = group(); const n = await run(g, ['--user', A, '--text', '经网关加密'], { gw }); const m = gw.bz.st.created[0];
    check('gateway endpoint: sent on the gateway\'s main connection, reply.js opens NO Blaze socket', n.code === 0 && gw.bz.st.created.length === 1 && n.blaze.conns === 0 && n.blaze.created.length === 0, { err: n.err.slice(-400), conns: n.blaze.conns });
    check('gateway endpoint: same encrypted params (no recipient_id, all member sessions, checksum)', m.category === 'ENCRYPTED_TEXT' && !('recipient_id' in m) && sameSet(header(m), members.map((x) => x.session_id)) && members.every((x) => dec(m, x).toString() === '经网关加密') && m.conversation_checksum === md5([...members, botSess]));
    check('gateway endpoint: log via=gateway mode=group-encrypted, stdout unchanged, nothing plain', /reply sent msg=\S+ conv=\S+ cat=ENCRYPTED_TEXT via=gateway mode=group-encrypted sessions=4/.test(n.err) && n.out.trim() === JSON.stringify({ ok: true, message_id: m.message_id, category: 'ENCRYPTED_TEXT' }) && n.noPlain && n.api.encrypted.length === 0);
    check('gateway endpoint: gateway logs metadata only', gw.logs.some((l) => new RegExp(`send endpoint msg=${m.message_id} conv=${g.conversation_id} cat=ENCRYPTED_TEXT ok`).test(l)) && !gw.logs.some((l) => l.includes(m.data_base64) || l.includes('经网关加密')));
    const st = fs.statSync(gw.socketPath), dt = fs.statSync(path.dirname(gw.socketPath));
    check('gateway endpoint: socket 0600 in a 0700 dir', (st.mode & 0o777) === 0o600 && (dt.mode & 0o777) === 0o700 && st.isSocket(), { s: (st.mode & 0o777).toString(8), d: (dt.mode & 0o777).toString(8) });
    let e = null; await sendViaEndpoint({ conversation_id: g.conversation_id, message_id: uuid(), category: 'PLAIN_TEXT', data_base64: 'eA' }, { socketPath: gw.socketPath }).catch((x) => { e = x; });
    check('gateway endpoint refuses non-ENCRYPTED categories (never plain), nothing sent', e && e.code === 'BAD_REQUEST' && gw.bz.st.created.length === 1);
    await gw.close(); }
  { const gw = await fakeGateway(); const g = group(); const n = await run(g, ['--user', A, '--text', 'x', '--image', png], { gw });
    check('gateway endpoint: text + image both via=gateway', n.code === 0 && gw.bz.st.created.length === 2 && gw.bz.st.created[1].category === 'ENCRYPTED_IMAGE' && n.blaze.conns === 0 && (n.err.match(/via=gateway mode=group-encrypted/g) || []).length === 2, n.err.slice(-300));
    await gw.close(); }
  { const g = group(); const n = await run(g, ['--user', A, '--text', 'nogw'], { noBlaze: true, env: { MIXIN_SEND_ENDPOINT: '0' } });
    check('MIXIN_SEND_ENDPOINT=0 -> exit 1 ENDPOINT_UNAVAILABLE at once (not retried), nothing sent', n.code === 1 && /ENDPOINT_UNAVAILABLE/.test(n.err) && /code=ENDPOINT_DISABLED -> giving up/.test(n.err) && !/try=1/.test(n.err) && n.api.encrypted.length === 0 && n.blaze.conns === 0, n.err.slice(-300)); }
  { const g = group(); const n = await run(g, ['--user', A, '--text', 'badcfg'], { noBlaze: true, env: { MIXIN_SEND_ENDPOINT: 'tcp://1.2.3.4:80' } });
    check('malformed MIXIN_SEND_ENDPOINT -> exit 1 ENDPOINT_UNAVAILABLE (ENDPOINT_CONFIG), nothing sent', n.code === 1 && /ENDPOINT_UNAVAILABLE/.test(n.err) && /code=ENDPOINT_CONFIG/.test(n.err) && n.api.encrypted.length === 0, n.err.slice(-300)); }
  { const gw = await fakeGateway({ startBlaze: false, waitOpenMs: 600 }); const g = group(); const n = await run(g, ['--user', A, '--text', 'gwdown', '--sticker', uuid()], { gw });
    const j = (() => { try { return JSON.parse(n.err.trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch (_) { return null; } })();
    check('gateway up but its Blaze not connected -> NOT_CONNECTED, retried, exit 1 ENDPOINT_UNAVAILABLE, nothing sent, no own Blaze', n.code === 1 && gw.bz.st.created.length === 0 && n.blaze.conns === 0 && (n.err.match(/gateway endpoint unavailable code=NOT_CONNECTED/g) || []).length === 2 && j && j.code === 'ENDPOINT_UNAVAILABLE' && Array.isArray(j.sent) && j.sent.length === 0 && n.api.encrypted.length === 0, n.err.slice(-400));
    await gw.close(); }
  { const gw = await fakeGateway(); const g = group(); let k = 0; const n = await run(g, ['--user', A, '--text', 'first', '--sticker', uuid()], { gw, env: { MIXIN_SEND_ENDPOINT_TRIES: '1' } });
    check('baseline 2 items via gateway', n.code === 0 && gw.bz.st.created.length === 2); await gw.close(); void k; }
  { const sNew = mk(C); const g = group(); let k = 0;
    const gw = await fakeGateway({ blazeOpts: { onCreate: () => { if (k++ === 0) { g.participant_sessions.push(pub(sNew)); return { error: E20140 }; } return null; } } });
    const n = await run(g, ['--user', A, '--text', 'gw retry'], { gw }); const [m1, m2] = gw.bz.st.created;
    check('endpoint error propagation: 20140 via gateway -> refresh -> re-encrypted retry via gateway -> ok', n.code === 0 && gw.bz.st.created.length === 2 && n.gets === 2 && m2.conversation_checksum === md5([...members, botSess, sNew]) && m1.conversation_checksum !== m2.conversation_checksum && dec(m2, sNew).toString() === 'gw retry' && n.blaze.conns === 0 && /group sessions refreshed code=20140/.test(n.err) && /via=gateway mode=group-encrypted sessions=5/.test(n.err) && n.noPlain, n.err.slice(-500));
    await gw.close(); }
  { const gw = await fakeGateway({ blazeOpts: { onCreate: () => ({ error: E20140 }) } }); const g = group(); const n = await run(g, ['--user', A, '--text', 'gw twice'], { gw }); const p = n.api.encrypted[0];
    check('20140 twice via gateway -> FALLBACK private encrypted, own Blaze not used', n.code === 0 && gw.bz.st.created.length === 2 && n.blaze.conns === 0 && p && p.recipient_id === A && dec(p, sA).toString() === 'gw twice' && /reply FALLBACK reason=group_send_rejected code=20140 conv=\S+ mode=private-encrypted/.test(n.err) && n.noPlain, n.err.slice(-400));
    await gw.close(); }
  { const gw = await fakeGateway({ blazeOpts: { onCreate: () => ({ error: E10002 }) } }); const g = group(); const n = await run(g, ['--user', A, '--text', 'gw 10002'], { gw });
    check('10002 via gateway (with extra.field) -> FALLBACK private encrypted, nothing plain', n.code === 0 && gw.bz.st.created.length === 1 && n.blaze.conns === 0 && n.api.encrypted.length === 1 && /reason=group_send_rejected code=10002 field=recipient_id/.test(n.err) && n.noPlain, n.err.slice(-400));
    await gw.close(); }

  // ---- CONTACT unchanged ----
  { const cid = uniqueConversationId(ks.app_id, A); const c = { conversation_id: cid, category: 'CONTACT', participants: [{ user_id: A }, { user_id: ks.app_id }], participant_sessions: [pub(sA), pub(botSess)] };
    const n = await run(c, ['--user', A, '--text', 'dm']);
    check('contact: plain REST with recipient_id, no Blaze, no GET', n.code === 0 && n.api.messages[0].category === 'PLAIN_TEXT' && n.api.messages[0].recipient_id === A && n.blaze.conns === 0 && n.gets === 0);
    const e = await run(c, ['--user', A, '--text', 'dm enc', '--encrypted']); const em = e.api.encrypted[0];
    check('contact encrypted: /encrypted_messages recipient_id + --user sessions', em.recipient_id === A && em.checksum === md5([sA]) && dec(em, sA).toString() === 'dm enc' && e.blaze.conns === 0);
    const f = await run(c, ['--user', A, '--text', 'dm f', '--encrypted'], { apiOpts: { messageHook: (b, enc) => (enc ? FAILED(b) : null) } });
    check('contact FAILED -> one session refresh + encrypted retry, then plain', f.api.encrypted.length === 2 && f.api.messages.length === 1 && f.api.messages[0].recipient_id === A);
    const card = await run(c, ['--user', A, '--card', JSON.stringify({ title: 't', description: 'd', icon_url: 'https://x/i.png', action: 'https://x' })]);
    check('contact --card still allowed (APP_CARD)', card.code === 0 && card.api.messages[0].category === 'APP_CARD'); }
  { const log = fs.readFileSync(path.join(W, 'g.log'), 'utf8'); check('log has no message content', !/群加密回复|看图|dm enc|经网关加密/.test(log)); }
  finish('reply-group');
})().catch((e) => { console.error(e); process.exit(1); });
