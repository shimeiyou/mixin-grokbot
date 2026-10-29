'use strict';
// Remote send endpoint (2026-10-18 VPS migration): reply.js / recall.js on host A reach the gateway's unix send socket on
// host B through `ssh -W <path> -- <host>` (OpenSSH streamlocal over stdio). Here `ssh` is test-fake-ssh.js (same argv
// contract, pipes stdio to the socket), the gateway is in-process (real send-endpoint.js + blaze-conn.js -> fake Blaze).
// Also: W-6 (no second Blaze connection, ever), RECORD mirroring (sent-log / context on the gateway host), errors.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { check, finish, uuid, fakeKeystore, ksJson, tmpdir, fakeMixinApi, fakeBlaze, runNode, curvePub, sleep } = require('./test-helpers');
const mc = require('./mixin-crypto');
const { uniqueConversationId } = require('./conversation-target');
const HERE = __dirname;
const W = tmpdir('ssh-ep-');
// gateway-host state (this process = "VPS"), set before the gateway modules read it
const GW_SENT = path.join(W, 'gw-sent-log.jsonl'), GW_CTX = path.join(W, 'gw-ctx');
process.env.MIXIN_SENT_LOG_FILE = GW_SENT; process.env.MIXIN_WEBHOOK_CONTEXT = '1'; process.env.MIXIN_CONTEXT_DIR = GW_CTX; process.env.MIXIN_GATEWAY_LOG = path.join(W, 'gw.log');
// client-host state (reply.js children)
const CLIENT_SENT = path.join(W, 'client-sent-log.jsonl'), CLIENT_CTX = path.join(W, 'client-ctx'), SSHLOG = path.join(W, 'ssh-argv.jsonl');
require('./ws-shim');
const { createBlazeConn } = require('./blaze-conn');
const ep = require('./send-endpoint');
const ks = fakeKeystore();
const mk = (user_id) => { const seed = crypto.randomBytes(32); return { user_id, session_id: uuid(), public_key: curvePub(seed), _seed: seed }; };
const pub = (s) => { const { _seed, ...r } = s; return r; };
const A = uuid(), B = uuid(); const sA = mk(A), sB = mk(B);
const botSess = { user_id: ks.app_id, session_id: ks.session_id, public_key: curvePub(ks._seed), _seed: ks._seed };
const grp = { conversation_id: uuid(), category: 'GROUP', participants: [ks.app_id, A, B].map((u) => ({ user_id: u })), participant_sessions: [sA, sB, botSess].map(pub) };
const contact = { conversation_id: uniqueConversationId(ks.app_id, A), category: 'CONTACT', participants: [{ user_id: A }, { user_id: ks.app_id }], participant_sessions: [pub(sA), pub(botSess)] };
const dec = (m, s) => mc.decryptMessageData(m.data_base64, s.session_id, s._seed).toString('utf8');
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

async function fakeGateway({ startBlaze = true, waitOpenMs = 10000 } = {}) {
  const bz = await fakeBlaze(); const logs = []; const log = (...a) => logs.push(a.join(' '));
  const conn = createBlazeConn({ keystore: JSON.parse(ksJson(ks)), url: bz.url, log, onDead: () => {}, handler: { onMessage: () => {} } });
  if (startBlaze) { conn.start(); for (let i = 0; i < 50 && !(conn.current() && conn.current().open); i++) await sleep(100); }
  const socketPath = path.join(tmpdir('gw-sock-'), 'run', 'send.sock');
  const e = ep.createSendEndpoint({ blaze: conn, log, socketPath, waitOpenMs, botId: ks.app_id });
  for (let i = 0; i < 50 && !fs.existsSync(socketPath); i++) await sleep(20);
  return { bz, logs, socketPath, close: async () => { e.close(); conn.stop(); await bz.close(); } };
}
async function run(conv, args, { gw = null, sockPath = null, env = {}, host = 'vps' } = {}) {
  const api = await fakeMixinApi({ users: { [A]: { user_id: A, identity_number: '7000123' } }, sessions: { [A]: [pub(sA)], [B]: [pub(sB)] }, conversations: { [conv.conversation_id]: conv } });
  const own = await fakeBlaze(); // reply.js must never connect here
  const before = gw ? gw.bz.st.created.length : 0;
  const p = runNode(['reply.js', '--conversation', conv.conversation_id, ...args], { cwd: HERE, timeoutMs: 60000, env: {
    MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_GATEWAY_LOG: path.join(W, 'client.log'), MIXIN_API_BASE: api.url, MIXIN_BLAZE_URL: own.url,
    HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', MIXIN_CONV_CACHE_FILE: path.join(W, `c-${uuid()}.json`),
    MIXIN_SENT_LOG_FILE: CLIENT_SENT, MIXIN_CONTEXT_DIR: CLIENT_CTX, MIXIN_WEBHOOK_CONTEXT: '1', MIXIN_SSH_BIN: path.join(HERE, 'test-fake-ssh.js'), MOCK_SSH_LOG: SSHLOG,
    MIXIN_SEND_ENDPOINT: `ssh:${host}:${sockPath || (gw ? gw.socketPath : path.join(W, 'nope', 'send.sock'))}`, MIXIN_SEND_ENDPOINT_TRIES: '2', ...env } });
  const r = await p.done; await api.close(); const ownConns = own.st.conns; await own.close();
  let json = null; try { json = JSON.parse(r.out.trim().split('\n').pop()); } catch (_) {}
  let ejson = null; try { ejson = JSON.parse(r.err.trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch (_) {}
  return { ...r, json, ejson, api: api.state, ownConns, created: gw ? gw.bz.st.created.slice(before) : [] };
}

// The host's real deploy/MIGRATED_TO_VPS (present on a client host) must not leak into these tests.
if (!process.env.MIXIN_MIGRATION_MARKER) process.env.MIXIN_MIGRATION_MARKER = '/nonexistent/mixin-test/MIGRATED_TO_VPS';
(async () => {
  // ---- parseEndpoint / ssh argv ----
  { const P = (v, o) => { try { return ep.parseEndpoint(v, o); } catch (e) { return { err: e.code }; } };
    const d = P(undefined), d2 = P('', { socketPath: '/x/run/send.sock' }), u = P('unix:/a/b.sock'), a = P('/a/c.sock'), o = P('0'), s = P('ssh:vps:/home/deploy/mixin-gateway/run/send.sock'), s2 = P('ssh:deploy@1.2.3.4:/s.sock');
    check('parseEndpoint: unset -> local default socket; unix:/abs; /abs; 0 -> off; ssh:host:/abs; ssh:user@host:/abs', d.type === 'unix' && d.path.endsWith('send.sock') && d2.path === '/x/run/send.sock' && u.type === 'unix' && u.path === '/a/b.sock' && a.path === '/a/c.sock' && o.type === 'off' && s.type === 'ssh' && s.host === 'vps' && s.path === '/home/deploy/mixin-gateway/run/send.sock' && s2.host === 'deploy@1.2.3.4', { d, s, s2 });
    const bad = ['ssh:-oProxyCommand=evil:/s.sock', 'ssh:vps:relative/send.sock', 'ssh:vps:/a b.sock', "ssh:vps:/a'b", 'ssh::/s', 'ssh:vps', 'tcp://1.2.3.4:80', 'unix:rel', 'ssh:v ps:/s'];
    check('parseEndpoint rejects option-injection hosts, relative/space/quote paths, unknown schemes (ENDPOINT_CONFIG)', bad.every((v) => P(v).err === 'ENDPOINT_CONFIG'), bad.map((v) => [v, P(v).err]));
    const av = ep.sshArgs(s);
    check('ssh argv: BatchMode=yes, ConnectTimeout, ExitOnForwardFailure, ClearAllForwardings, no ControlMaster, -W <path>, "--" then host last', av.includes('BatchMode=yes') && av.some((x) => /^ConnectTimeout=\d+$/.test(x)) && av.includes('ExitOnForwardFailure=yes') && av.includes('ClearAllForwardings=yes') && av.includes('ControlPath=none') && av[av.indexOf('-W') + 1] === s.path && av[av.length - 2] === '--' && av[av.length - 1] === 'vps' && !av.some((x) => /ProxyCommand|LocalCommand|PermitLocalCommand=yes/i.test(x)), av); }
  { const src = ['reply.js', 'reply-args.js', 'reply-items.js', 'reply-send.js', 'recall.js'].map((f) => fs.readFileSync(path.join(HERE, f), 'utf8')).join('\n');
    check('W-6: reply.js / recall.js contain no Blaze client (no blaze-send / blaze-conn / ws / BlazeKeystoreClient), blaze-send.js removed', !/blaze-send|blaze-conn|require\('ws'\)|BlazeKeystoreClient|createBlazeSender/.test(src) && !fs.existsSync(path.join(HERE, 'blaze-send.js'))); }

  const gw = await fakeGateway();
  // ---- group send over the ssh channel ----
  let groupMsg;
  { const r = await run(grp, ['--reply-to', uuid(), '--user', A, '--text', '网关已迁移到 VPS 测试'], { gw }); const m = r.created[0]; groupMsg = m && m.message_id;
    check('group via ssh endpoint: one ENCRYPTED_TEXT on the gateway connection, members decrypt it', r.code === 0 && r.created.length === 1 && m.category === 'ENCRYPTED_TEXT' && !m.recipient_id && dec(m, sA) === '网关已迁移到 VPS 测试' && dec(m, sB) === '网关已迁移到 VPS 测试', { code: r.code, err: r.err.slice(-400) });
    check('group via ssh: stdout unchanged {ok,message_id,category}; log via=gateway ... endpoint=ssh:vps; reply.js opened NO Blaze socket', r.json && Object.keys(r.json).join() === 'ok,message_id,category' && /via=gateway mode=group-encrypted sessions=2 endpoint=ssh:vps/.test(r.err) && r.ownConns === 0, { json: r.json, own: r.ownConns });
    const calls = readJsonl(SSHLOG);
    check('ssh invoked as: … -W <gateway socket> -- vps (twice: send + RECORD), BatchMode', calls.length === 2 && calls.every((c) => c.argv.includes('BatchMode=yes') && c.argv[c.argv.indexOf('-W') + 1] === gw.socketPath && c.argv[c.argv.length - 1] === 'vps'), calls.map((c) => c.argv.slice(-4)));
    await sleep(300);
    check('ssh children exited after the reply (no leftover ssh processes)', calls.every((c) => !alive(c.pid)));
    const gs = readJsonl(GW_SENT).find((x) => x.message_id === m.message_id), bs = readJsonl(CLIENT_SENT).find((x) => x.message_id === m.message_id);
    const gctx = require('./context-store').recent(grp.conversation_id, null).find((x) => x.message_id === m.message_id);
    check('RECORD mirrored to the gateway host: sent-log (ids/category/via) + context (from_bot, text) ; client sent-log still written', gs && gs.category === 'ENCRYPTED_TEXT' && gs.via === 'group' && bs && gctx && gctx.from_bot === true && gctx.user_id === ks.app_id && gctx.text === '网关已迁移到 VPS 测试', { gs, bs: !!bs, gctx: !!gctx });
    check('gateway logs RECORD metadata only (no text)', gw.logs.some((l) => /send endpoint record items=1 recorded=1 context=1/.test(l)) && !gw.logs.some((l) => l.includes('网关已迁移'))); }
  // ---- 1:1 with an ssh endpoint: REST send, RECORD mirrored ----
  { fs.writeFileSync(SSHLOG, ''); const r = await run(contact, ['--reply-to', uuid(), '--user', A, '--text', 'dm via rest'], { gw });
    const m = r.api.messages[0]; const gs = m && readJsonl(GW_SENT).find((x) => x.message_id === m.message_id);
    check('1:1 with ssh endpoint: sent by REST from this host (no Blaze anywhere), recorded on the gateway host via=contact', r.code === 0 && m && m.category === 'PLAIN_TEXT' && r.created.length === 0 && r.ownConns === 0 && gs && gs.via === 'contact' && readJsonl(SSHLOG).length === 1, { code: r.code, err: r.err.slice(-300) }); }
  { const r = await run(contact, ['--reply-to', uuid(), '--user', A, '--text', 'dm, ssh down'], { gw, env: { MOCK_SSH_MODE: 'auth' } });
    check('1:1 while ssh fails: still sent (exit 0), WARN record remote failed code=SSH_FAILED', r.code === 0 && r.api.messages.length === 1 && /WARN reply record remote failed code=SSH_FAILED/.test(r.err), r.err.slice(-300)); }
  // ---- group failures: clear error, non-zero, nothing sent, no own Blaze ----
  for (const [name, opt, code] of [['ssh auth failure', { env: { MOCK_SSH_MODE: 'auth' } }, 'SSH_FAILED'], ['ssh host unreachable', { env: { MOCK_SSH_MODE: 'refused' } }, 'SSH_FAILED'],
    ['remote socket missing (gateway down)', { sockPath: path.join(W, 'gone', 'send.sock') }, 'ENDPOINT_DOWN']]) {
    const r = await run(grp, ['--reply-to', uuid(), '--user', A, '--text', 'x'], { gw, ...opt });
    check(`group, ${name} -> retried, exit 1 ENDPOINT_UNAVAILABLE (${code}), nothing sent, no private fallback, no own Blaze`, r.code === 1 && r.ejson && r.ejson.code === 'ENDPOINT_UNAVAILABLE' && new RegExp(`code=${code} try=1/2`).test(r.err) && new RegExp(`code=${code} -> giving up`).test(r.err) && r.created.length === 0 && r.api.encrypted.length === 0 && r.api.messages.length === 0 && r.ownConns === 0, { code: r.code, err: r.err.slice(-400) });
  }
  { fs.writeFileSync(SSHLOG, ''); const t0 = Date.now(); const r = await run(grp, ['--reply-to', uuid(), '--user', A, '--text', 'x'], { gw, env: { MOCK_SSH_MODE: 'hang', MIXIN_SEND_ENDPOINT_TIMEOUT_MS: '1200' } });
    await sleep(3500); const calls = readJsonl(SSHLOG);
    check('group, ssh hangs -> ETIMEDOUT per try, exit 1 ENDPOINT_UNAVAILABLE, hung ssh children killed', r.code === 1 && /code=ETIMEDOUT -> giving up/.test(r.err) && r.created.length === 0 && Date.now() - t0 < 20000 && calls.length === 2 && calls.every((c) => !alive(c.pid)), { err: r.err.slice(-300), alive: calls.map((c) => alive(c.pid)) }); }
  { const gw2 = await fakeGateway({ startBlaze: false, waitOpenMs: 500 });
    const r = await run(grp, ['--reply-to', uuid(), '--user', A, '--text', 'x'], { gw: gw2 });
    check('group, gateway up but its Blaze down -> NOT_CONNECTED over ssh, exit 1 ENDPOINT_UNAVAILABLE, nothing sent', r.code === 1 && /code=NOT_CONNECTED -> giving up/.test(r.err) && gw2.bz.st.created.length === 0 && r.ownConns === 0, r.err.slice(-300));
    await gw2.close(); }
  // ---- recall over ssh: ownership checked on the gateway host from the mirrored sent-log ----
  { const r = await run(grp, ['--recall', groupMsg], { gw, env: { MIXIN_GROUP_RECALL: '1' } }); const c = r.created[0];
    const gctx = require('./context-store').recent(grp.conversation_id, null).find((x) => x.message_id === groupMsg);
    check('group recall via ssh: accepted by the gateway (own message, from mirrored sent-log), MESSAGE_RECALL sent, no recipient_id', r.code === 0 && c && c.category === 'MESSAGE_RECALL' && !c.recipient_id && r.json && r.json.recalled[0].via === 'gateway' && r.ownConns === 0, { code: r.code, err: r.err.slice(-300) });
    check('recall mirrored: gateway context no longer has the recalled message', !gctx && gw.logs.some((l) => /send endpoint record items=1 recorded=0 context=0 removed=1/.test(l))); }
  { const r = await run(grp, ['--recall', groupMsg], { gw, env: { MIXIN_GROUP_RECALL: '1', MOCK_SSH_MODE: 'auth' } });
    check('group recall, ssh fails -> exit 1 ENDPOINT_UNAVAILABLE, no own Blaze', r.code === 1 && r.ejson && r.ejson.code === 'ENDPOINT_UNAVAILABLE' && r.ownConns === 0, r.err.slice(-300)); }
  // ---- migration marker: the caller.s unchanged command (no MIXIN_SEND_ENDPOINT / MIXIN_SEND_SOCKET) reaches the remote gateway ----
  { const MK = path.join(W, 'MIGRATED_TO_VPS'); fs.writeFileSync(MK, `# migrated 2026-10-18\nssh:vps:${gw.socketPath}\n`);
    fs.writeFileSync(SSHLOG, ''); const noEnv = { MIXIN_SEND_ENDPOINT: '', MIXIN_SEND_SOCKET: '', MIXIN_MIGRATION_MARKER: MK };
    const r = await run(grp, ['--reply-to', uuid(), '--user', A, '--text', 'marker default'], { gw, env: noEnv });
    check('marker present, no endpoint env: group reply goes over ssh to the marker endpoint (unchanged caller command), stdout unchanged', r.code === 0 && r.created.length === 1 && /endpoint=ssh:vps/.test(r.err) && readJsonl(SSHLOG).length === 2 && r.json && Object.keys(r.json).join() === 'ok,message_id,category' && r.ownConns === 0, { code: r.code, err: r.err.slice(-300) });
    const rc = await run(grp, ['--recall', r.created[0] && r.created[0].message_id], { gw, env: { ...noEnv, MIXIN_GROUP_RECALL: '1' } });
    check('marker present: recall also goes over ssh', rc.code === 0 && rc.created[0] && rc.created[0].category === 'MESSAGE_RECALL', rc.err.slice(-300));
    const ov = await run(grp, ['--reply-to', uuid(), '--user', A, '--text', 'env wins'], { gw, env: { ...noEnv, MIXIN_SEND_ENDPOINT: `unix:${gw.socketPath}` } });
    check('MIXIN_SEND_ENDPOINT overrides the marker (unix, no ssh)', ov.code === 0 && ov.created.length === 1 && !/endpoint=ssh/.test(ov.err));
    const so = await run(grp, ['--reply-to', uuid(), '--user', A, '--text', 'sock wins'], { gw, env: { ...noEnv, MIXIN_SEND_SOCKET: gw.socketPath } });
    check('explicit MIXIN_SEND_SOCKET overrides the marker (tests / local)', so.code === 0 && so.created.length === 1 && !/endpoint=ssh/.test(so.err));
    fs.writeFileSync(MK, '# migrated, endpoint line missing\n');
    const bad = await run(grp, ['--reply-to', uuid(), '--user', A, '--text', 'x'], { gw, env: noEnv });
    check('marker without an endpoint line -> fail closed: exit 1 ENDPOINT_UNAVAILABLE (ENDPOINT_CONFIG), nothing sent, local socket NOT used', bad.code === 1 && /ENDPOINT_CONFIG/.test(bad.err) && bad.created.length === 0, bad.err.slice(-300));
    const P = (o) => { const k = process.env.MIXIN_SEND_SOCKET, km = process.env.MIXIN_MIGRATION_MARKER; delete process.env.MIXIN_SEND_SOCKET; process.env.MIXIN_MIGRATION_MARKER = o; try { return ep.parseEndpoint(undefined); } finally { if (km != null) process.env.MIXIN_MIGRATION_MARKER = km; else delete process.env.MIXIN_MIGRATION_MARKER; if (k != null) process.env.MIXIN_SEND_SOCKET = k; } };
    const none = P(path.join(W, 'absent'));
    check('no marker, no env -> local default socket (gateway host)', none.type === 'unix' && none.path.endsWith(path.join('run', 'send.sock')) && (() => { const km = process.env.MIXIN_MIGRATION_MARKER; delete process.env.MIXIN_MIGRATION_MARKER; try { return ep.markerPath() === path.join(__dirname, 'deploy', 'MIGRATED_TO_VPS'); } finally { if (km != null) process.env.MIXIN_MIGRATION_MARKER = km; } })());
    fs.rmSync(MK); }
  // ---- RECORD validation (server) ----
  { const sp = { socketPath: gw.socketPath }; const it = { message_id: uuid(), conversation_id: uuid(), category: 'ENCRYPTED_TEXT', via: 'group' };
    const bad = [[], Array.from({ length: 51 }, () => it), [{ ...it, data_base64: 'x' }], [{ ...it, message_id: 'x' }], [{ ...it, category: 'bad cat' }], [{ ...it, context: { text: 'y'.repeat(8001), created_at: new Date().toISOString() } }], [{ ...it, context: { text: 'a' } }], [{ ...it, remove_context: 'yes' }]];
    const res = []; for (const b of bad) res.push(await ep.recordViaEndpoint(b, sp).then(() => 'ok', (e) => e.code));
    const before = gw.bz.st.created.length; const ok = await ep.recordViaEndpoint([it], sp);
    check('RECORD validation: empty / >50 / unknown field / bad uuid / bad category / long or malformed context / non-bool -> BAD_REQUEST; valid -> recorded, no Blaze send', res.every((x) => x === 'BAD_REQUEST') && ok.recorded === 1 && gw.bz.st.created.length === before && readJsonl(GW_SENT).some((x) => x.message_id === it.message_id), res); }
  { const r = await ep.endpointRequest({ action: 'RECORD', items: [{ message_id: uuid(), conversation_id: uuid(), category: 'ENCRYPTED_TEXT' }], extra: 1 }, { socketPath: gw.socketPath }).then(() => 'ok', (e) => e.code);
    check('RECORD with extra top-level keys -> BAD_REQUEST', r === 'BAD_REQUEST'); }
  { const log = fs.readFileSync(path.join(W, 'client.log'), 'utf8'); check('client log has no message text', !/网关已迁移|dm via rest/.test(log)); }
  await gw.close();
  fs.rmSync(W, { recursive: true, force: true });
  finish('ssh-endpoint');
})().catch((e) => { console.error('FAIL crash', e); process.exit(1); });
