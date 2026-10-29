'use strict';
// Steps 4 + 5 (outbound): reply.js against a fake Mixin API (clean env, no real network).
//  A) old reply.js (*.bak-s2) vs new reply.js with the OLD arguments -> same requests, same stdout/exit codes.
//  B) new flags: --quote --sticker --location --contact --card --buttons --silent --seq, plain + encrypted.
//  C) attachments: --image --video --audio --file, plain upload and encrypted (ciphertext upload + key/digest).
//  D) --help / -h: usage with every flag on stdout, exit 0 at once; no stdin read, no keystore, no network, no log.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const { execFileSync } = require('child_process');
const { check, finish, uuid, fakeKeystore, ksJson, tmpdir, fakeMixinApi, fakeBlaze, runNode, curvePub, sleep } = require('./test-helpers');
const mc = require('./mixin-crypto');
const { decryptAttachment } = require('./attachment-crypto');
const HERE = __dirname, LIVE = path.join(__dirname, 'test-baseline'); // frozen old code (pre-refactor snapshot)
const OLD = tmpdir('reply-old-');
for (const [s, d] of [['reply.js', 'reply.js'], ['context-store.js', 'context-store.js'], ['common.js', 'common.js'], ['mixin-crypto.js', 'mixin-crypto.js'], ['ws-shim.js', 'ws-shim.js']]) fs.copyFileSync(path.join(LIVE, s), path.join(OLD, d));
fs.symlinkSync(path.join(HERE, 'node_modules'), path.join(OLD, 'node_modules'));

const { uniqueConversationId } = require('./conversation-target');
const ks = fakeKeystore(); const USER = uuid(), IN = uuid();
const CONV = uniqueConversationId(ks.app_id, USER); // a real 1:1 (CONTACT) id: the old behaviour must be unchanged here
const rSeed = crypto.randomBytes(32); const rSess = { session_id: uuid(), public_key: curvePub(rSeed), user_id: USER };
const dec = (req) => mc.decryptMessageData(req.data_base64, rSess.session_id, rSeed);
const plainData = (req) => Buffer.from(req.data_base64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const W = tmpdir('reply-work-');

async function run(args, { old = false, input = null, apiOpts = {}, env = {} } = {}) {
  const api = await fakeMixinApi({ sessions: { [USER]: [rSess] }, conversations: { [CONV]: { conversation_id: CONV, category: 'CONTACT', participants: [{ user_id: USER }, { user_id: ks.app_id }], participant_sessions: [rSess, { user_id: ks.app_id, session_id: ks.session_id, public_key: curvePub(ks._seed) }] } }, ...apiOpts });
  const p = runNode([...(old ? ['-r', path.join(HERE, 'test-redirect-api.js')] : []), 'reply.js', ...args], { cwd: old ? OLD : HERE, input, timeoutMs: 60000,
    env: { MIXIN_ATTACH_DIRS: W, MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_GATEWAY_LOG: path.join(W, old ? 'old.log' : 'new.log'), MIXIN_API_BASE: api.url, TEST_API_BASE: api.url, HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', MIXIN_CONTEXT_DIR: path.join(W, 'ctx'), MIXIN_CONV_CACHE_FILE: path.join(W, 'conv-cache.json'), MIXIN_BLAZE_URL: 'ws://127.0.0.1:9', ...env } });
  const r = await p.done; await api.close();
  return { ...r, api: api.state, reqs: api.reqs, json: (() => { try { return JSON.parse(r.out.trim().split('\n').pop()); } catch (_) { return null; } })() };
}
const base = ['--conversation', CONV, '--reply-to', IN];
const norm = (m) => ({ ...m, data_base64: undefined });

(async () => {
  // ---------- A) compatibility with the old arguments ----------
  const cases = [
    ['plain text', [...base, '--user', USER, '--text', 'hello']],
    ['markdown -> POST', [...base, '--text', '# Title\n- item']],
    ['stdin text', [...base, '--user', USER], 'from stdin\n'],
    ['--text - (stdin)', [...base, '--text', '-'], 'dash stdin'],
    ['encrypted with --user', [...base, '--user', USER, '--text', '加密回复', '--encrypted']],
    ['encrypted via --incoming-category, no --user (participants)', [...base, '--text', 'conv sessions', '--incoming-category', 'ENCRYPTED_TEXT']],
  ];
  for (const [name, args, input] of cases) {
    const o = await run(args, { old: true, input }), n = await run(args, { input });
    const om = [...o.api.messages, ...o.api.encrypted], nm = [...n.api.messages, ...n.api.encrypted];
    const sameShape = JSON.stringify(om.map(norm)) === JSON.stringify(nm.map(norm));
    const sameData = om.length === nm.length && om.every((m, i) => (m.category.startsWith('ENCRYPTED_') ? dec(m).equals(dec(nm[i])) : m.data_base64 === nm[i].data_base64));
    check(`compat: ${name}`, o.code === 0 && n.code === 0 && sameShape && sameData && o.out === n.out, { o: o.out, n: n.out, om: om.map(norm), nm: nm.map(norm), oe: o.err.slice(-300), ne: n.err.slice(-300) });
  }
  { const o = await run(['--conversation', CONV], { old: true }), n = await run(['--conversation', CONV]);
    check('compat: missing args -> exit 2 + usage', o.code === 2 && n.code === 2 && /usage:/.test(n.err)); }
  { const hook = (b, enc) => (enc ? { json: { data: b.map((x) => ({ message_id: x.message_id, state: 'FAILED' })) } } : null);
    const o = await run([...base, '--user', USER, '--text', 'x', '--encrypted'], { old: true, apiOpts: { messageHook: hook } }), n = await run([...base, '--user', USER, '--text', 'x', '--encrypted'], { apiOpts: { messageHook: hook } });
    check('compat: encrypted FAILED (also after one session refresh) -> plain fallback, same stdout', o.out === n.out && n.json.category === 'PLAIN_TEXT' && o.api.encrypted.length === 1 && n.api.encrypted.length === 2 && n.api.messages.length === 1 && /reply contact sessions refreshed code=ENC_FAILED sessions=1, retrying encrypted once/.test(n.err), n.err.slice(-400)); }
  { // 2026-10-18 hardening (mixin_bot post_encrypted_messages): FAILED -> refetch sessions, retry encrypted once
    let k = 0; const hook = (b, enc) => (enc && k++ === 0 ? { json: { data: b.map((x) => ({ message_id: x.message_id, state: 'FAILED' })) } } : null);
    const n = await run([...base, '--user', USER, '--text', '刷新后重试', '--encrypted'], { apiOpts: { messageHook: hook } });
    const fetches = n.reqs.filter((r) => r.method === 'POST' && r.url.split('?')[0] === '/sessions/fetch').length;
    check('1:1 encrypted FAILED once -> /sessions/fetch again, re-encrypted retry succeeds (ENCRYPTED_TEXT, no plain)', n.code === 0 && n.json.category === 'ENCRYPTED_TEXT' && n.api.encrypted.length === 2 && n.api.messages.length === 0 && fetches === 2 && n.api.encrypted[0].message_id === n.api.encrypted[1].message_id && dec(n.api.encrypted[1]).toString() === '刷新后重试', { code: n.code, out: n.out, fetches, err: n.err.slice(-300) });
  }
  { // no --user: sessions come from the cached conversation -> the cache entry is dropped and GET /conversations refetched
    let k = 0; const hook = (b, enc) => (enc && k++ === 0 ? { json: { data: b.map((x) => ({ message_id: x.message_id, state: 'FAILED' })) } } : null);
    fs.rmSync(path.join(W, 'conv-cache.json'), { force: true });
    const n = await run([...base, '--text', 'conv refresh', '--incoming-category', 'ENCRYPTED_TEXT'], { apiOpts: { messageHook: hook } });
    const gets = n.reqs.filter((r) => r.method === 'GET' && r.url.split('?')[0] === `/conversations/${CONV}`).length;
    check('1:1 no --user: FAILED -> conversation cache invalidated + refetched, encrypted retry succeeds', n.code === 0 && n.json.category === 'ENCRYPTED_TEXT' && n.api.encrypted.length === 2 && gets >= 2, { code: n.code, gets, err: n.err.slice(-300) });
  }
  { // HTTP 4xx rejection of the encrypted send behaves the same (refresh once, then plain); transient 5xx still uses the retry loop
    const hook = (b, enc) => (enc ? { status: 403, json: { error: { code: 403, status: 403, description: 'forbidden' } } } : null);
    const n = await run([...base, '--user', USER, '--text', 'x', '--encrypted'], { apiOpts: { messageHook: hook } });
    check('1:1 encrypted HTTP 403 twice -> one refresh, then plain fallback (exit 0)', n.code === 0 && n.json.category === 'PLAIN_TEXT' && n.api.encrypted.length === 2 && n.api.messages.length === 1, { code: n.code, err: n.err.slice(-300) });
  }
  { let k = 0; const hook = () => (k++ === 0 ? { status: 429, json: { error: { code: 429, status: 429, description: 'slow down' } } } : null);
    const n = await run([...base, '--text', 'retry me'], { apiOpts: { messageHook: hook } });
    check('HTTP 429 -> retry -> ok (fixes old: it gave up on a real HTTP 429)', n.code === 0 && n.api.messages.length === 2 && /reply retry code=ERR_BAD_REQUEST/.test(n.err), n.err.slice(-300)); }
  { let k = 0; const hook = () => (k++ === 0 ? { status: 200, json: { error: { code: 429, status: 429, description: 'slow down' } } } : null);
    const o = await run([...base, '--text', 'retry body'], { old: true, apiOpts: { messageHook: hook } }); k = 0; const n = await run([...base, '--text', 'retry body'], { apiOpts: { messageHook: hook } });
    check('compat: API error body code 429 -> retry (old and new)', o.code === 0 && n.code === 0 && o.out === n.out && /reply retry code=429/.test(n.err)); }
  { let k = 0; const hook = () => (k++ === 0 ? { status: 502, body: 'bad gateway' } : null);
    const n = await run([...base, '--text', 'retry 502'], { apiOpts: { messageHook: hook } });
    check('HTTP 502 -> retry -> ok', n.code === 0 && n.api.messages.length === 2); }
  { const hook = () => ({ status: 403, json: { error: { code: 403, status: 403, description: 'forbidden' } } });
    const o = await run([...base, '--text', 'nope'], { old: true, apiOpts: { messageHook: hook } }), n = await run([...base, '--text', 'nope'], { apiOpts: { messageHook: hook } });
    check('compat: 403 -> same error JSON + exit 1', o.code === 1 && n.code === 1 && o.err.split('\n').filter((l) => l.startsWith('{')).join() === n.err.split('\n').filter((l) => l.startsWith('{')).join(), { o: o.err.slice(-200), n: n.err.slice(-200) }); }
  { // context recording identical
    const env = { MIXIN_WEBHOOK_CONTEXT: '1' };
    fs.rmSync(path.join(W, 'ctx'), { recursive: true, force: true }); await run([...base, '--text', 'ctx text'], { old: true, env });
    const oc = JSON.parse(fs.readFileSync(path.join(W, 'ctx', `${CONV}.json`))); fs.rmSync(path.join(W, 'ctx'), { recursive: true, force: true });
    await run([...base, '--text', 'ctx text'], { env }); const nc = JSON.parse(fs.readFileSync(path.join(W, 'ctx', `${CONV}.json`)));
    const s = (c) => JSON.stringify(c.map(({ created_at, ...r }) => r));
    check('compat: context store record identical', s(oc) === s(nc), { oc, nc });
  }

  // ---------- B) new non-attachment flags ----------
  const STK = uuid(), CT = uuid(), Q = uuid();
  { const n = await run([...base, '--text', 'quoted', '--quote', Q, '--silent']);
    const m = n.api.messages[0];
    check('--quote + --silent', n.code === 0 && m.quote_message_id === Q && m.silent === true && n.out.trim() === JSON.stringify({ ok: true, message_id: m.message_id, category: 'PLAIN_TEXT' }), m); }
  { const n = await run([...base, '--sticker', STK]); const m = n.api.messages[0];
    check('--sticker plain', m.category === 'PLAIN_STICKER' && JSON.parse(plainData(m)).sticker_id === STK && n.json.messages[0].kind === 'sticker'); }
  { const n = await run([...base, '--user', USER, '--sticker', STK, '--encrypted']); const m = n.api.encrypted[0];
    check('--sticker encrypted', m.category === 'ENCRYPTED_STICKER' && JSON.parse(dec(m)).sticker_id === STK && m.recipient_sessions[0].session_id === rSess.session_id); }
  { const n = await run([...base, '--location', '31.23,121.47,上海,人民广场, 1号']); const m = n.api.messages[0]; const d = JSON.parse(plainData(m));
    check('--location plain (name + address with comma)', m.category === 'PLAIN_LOCATION' && d.latitude === 31.23 && d.longitude === 121.47 && d.name === '上海' && d.address === '人民广场, 1号', d); }
  { const n = await run([...base, '--user', USER, '--location', '{"latitude":1.5,"longitude":2.5,"name":"X"}', '--encrypted']); const m = n.api.encrypted[0];
    check('--location JSON encrypted', m.category === 'ENCRYPTED_LOCATION' && JSON.parse(dec(m)).name === 'X'); }
  { const n = await run([...base, '--location', '95,10']); check('--location invalid -> exit 2, nothing sent', n.code === 2 && n.api.messages.length === 0 && /lat/.test(n.err)); }
  { const n = await run([...base, '--contact', CT]); const m = n.api.messages[0];
    check('--contact plain', m.category === 'PLAIN_CONTACT' && JSON.parse(plainData(m)).user_id === CT); }
  { const n = await run([...base, '--user', USER, '--contact', CT, '--encrypted']); check('--contact encrypted', n.api.encrypted[0].category === 'ENCRYPTED_CONTACT' && JSON.parse(dec(n.api.encrypted[0])).user_id === CT); }
  const card = { title: '标题', description: '说明', icon_url: 'https://x/icon.png', action: 'https://example.com', shareable: true };
  { const n = await run([...base, '--user', USER, '--card', JSON.stringify(card), '--encrypted']); const m = n.api.messages[0]; const d = m && JSON.parse(plainData(m));
    check('--card -> APP_CARD (plain even with --encrypted), app_id = bot', m && m.category === 'APP_CARD' && d.app_id === ks.app_id && d.title === '标题' && n.api.encrypted.length === 0, { m, err: n.err.slice(-300) }); }
  { const cf = path.join(W, 'card.json'); fs.writeFileSync(cf, JSON.stringify(card)); const n = await run([...base, '--card', '@' + cf]); check('--card @file', n.code === 0 && n.api.messages[0].category === 'APP_CARD'); }
  { const n = await run([...base, '--card', JSON.stringify({ ...card, app_id: uuid() })]); check('--card foreign app_id -> exit 2', n.code === 2 && n.api.messages.length === 0); }
  { const n = await run([...base, '--card', JSON.stringify({ ...card, action: 'javascript:alert(1)' })]); check('--card bad action -> exit 2', n.code === 2); }
  const btns = [{ label: '是', action: 'input:yes', color: '#00AA00' }, { label: '官网', action: 'https://mixin.one' }];
  { const n = await run([...base, '--buttons', JSON.stringify(btns)]); const m = n.api.messages[0]; const d = JSON.parse(plainData(m));
    check('--buttons -> APP_BUTTON_GROUP, default color', m.category === 'APP_BUTTON_GROUP' && d.length === 2 && d[1].color === '#000000'); }
  { const n = await run([...base, '--buttons', JSON.stringify(Array(7).fill(btns[0]))]); check('--buttons >6 -> exit 2', n.code === 2 && n.api.messages.length === 0); }
  { const n = await run([...base, '--quote', 'not-a-uuid', '--text', 'x']); check('--quote invalid -> exit 2', n.code === 2); }

  // ---------- C) attachments ----------
  const png = path.join(W, 'a.png'), wav = path.join(W, 'a.wav'), mp4 = path.join(W, 'a.mp4'), pdf = path.join(W, 'doc.pdf');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=1', '-frames:v', '1', png]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', wav]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', mp4]);
  fs.writeFileSync(pdf, Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(500)]));
  const PNGB = fs.readFileSync(png);
  { const n = await run([...base, '--image', png, '--caption', '看图']); const m = n.api.messages[0]; const d = JSON.parse(plainData(m));
    const up = n.api.uploads[d.attachment_id];
    check('--image plain: POST /attachments, PUT plaintext, PLAIN_IMAGE meta', m.category === 'PLAIN_IMAGE' && up && up.equals(PNGB) && d.width === 160 && d.height === 120 && d.mime_type === 'image/png' && d.size === PNGB.length && d.caption === '看图' && !d.key, d);
    check('upload headers octet-stream + x-amz-acl public-read', n.api.uploadHeaders['content-type'] === 'application/octet-stream' && n.api.uploadHeaders['x-amz-acl'] === 'public-read');
    check('thumbnail generated (base64 jpeg)', typeof d.thumbnail === 'string' && Buffer.from(d.thumbnail, 'base64')[0] === 0xff); }
  { const n = await run([...base, '--user', USER, '--image', png, '--encrypted']); const m = n.api.encrypted[0]; const d = JSON.parse(dec(m));
    const up = n.api.uploads[d.attachment_id];
    check('--image encrypted: ENCRYPTED_IMAGE, ciphertext uploaded, key/digest decrypt to the file', m.category === 'ENCRYPTED_IMAGE' && !up.equals(PNGB) && decryptAttachment(up, d.key, d.digest).equals(PNGB) && Buffer.from(d.key, 'base64').length === 64 && d.size === PNGB.length, Object.keys(d)); }
  { const hook = (b, enc) => (enc ? { json: { data: b.map((x) => ({ message_id: x.message_id, state: 'FAILED' })) } } : null);
    const n = await run([...base, '--user', USER, '--image', png, '--encrypted'], { apiOpts: { messageHook: hook } }); const m = n.api.messages[0]; const d = JSON.parse(plainData(m));
    check('--image encrypted rejected -> plaintext re-upload + PLAIN_IMAGE', m.category === 'PLAIN_IMAGE' && n.api.uploads[d.attachment_id].equals(PNGB) && n.api.created.length === 2 && !d.key); }
  { const n = await run([...base, '--audio', wav]); const m = n.api.messages[0]; const d = JSON.parse(plainData(m)); const up = n.api.uploads[d.attachment_id];
    check('--audio wav -> converted to ogg/opus, duration ms', m.category === 'PLAIN_AUDIO' && d.mime_type === 'audio/ogg' && up.subarray(0, 4).toString() === 'OggS' && d.duration >= 1400 && d.duration <= 1700, d); }
  { const n = await run([...base, '--user', USER, '--audio', wav, '--encrypted']); const d = JSON.parse(dec(n.api.encrypted[0]));
    check('--audio encrypted', n.api.encrypted[0].category === 'ENCRYPTED_AUDIO' && decryptAttachment(n.api.uploads[d.attachment_id], d.key, d.digest).subarray(0, 4).toString() === 'OggS'); }
  { const n = await run([...base, '--video', mp4]); const d = JSON.parse(plainData(n.api.messages[0]));
    check('--video meta (w/h/duration/thumbnail)', n.api.messages[0].category === 'PLAIN_VIDEO' && d.width === 320 && d.height === 240 && d.duration >= 1900 && d.duration <= 2100 && d.mime_type === 'video/mp4' && d.thumbnail, d); }
  { const n = await run([...base, '--file', pdf, '--name', '报告.pdf']); const d = JSON.parse(plainData(n.api.messages[0]));
    check('--file -> PLAIN_DATA with name/mime', n.api.messages[0].category === 'PLAIN_DATA' && d.name === '报告.pdf' && d.mime_type === 'application/pdf' && n.api.uploads[d.attachment_id].equals(fs.readFileSync(pdf))); }
  { const n = await run([...base, '--user', USER, '--file', pdf, '--encrypted']); const d = JSON.parse(dec(n.api.encrypted[0]));
    check('--file encrypted -> ENCRYPTED_DATA', n.api.encrypted[0].category === 'ENCRYPTED_DATA' && decryptAttachment(n.api.uploads[d.attachment_id], d.key, d.digest).equals(fs.readFileSync(pdf))); }
  { const n = await run([...base, '--image', pdf]); check('--image with a non-image -> exit 2', n.code === 2 && n.api.created.length === 0); }
  { const n = await run([...base, '--file', '/nonexistent/x']); check('--file missing -> exit 2', n.code === 2); }

  // ---------- combined + ids ----------
  { const args = [...base, '--text', '这是图', '--image', png, '--buttons', JSON.stringify(btns), '--quote', Q];
    const n = await run(args), n2 = await run(args);
    const ms = n.api.messages; const ids = ms.map((m) => m.message_id);
    check('combined: 3 messages in CLI order, quote only on first', ms.map((m) => m.category).join() === 'PLAIN_TEXT,PLAIN_IMAGE,APP_BUTTON_GROUP' && ms[0].quote_message_id === Q && !ms[1].quote_message_id && n.json.messages.length === 3);
    check('combined: deterministic distinct ids; text id == legacy id', new Set(ids).size === 3 && JSON.stringify(ids) === JSON.stringify(n2.api.messages.map((m) => m.message_id)) && ids[0] === (await run([...base, '--text', 'x'])).api.messages[0].message_id);
    const s = await run([...args, '--seq', '2']); check('--seq changes every id', s.api.messages.every((m) => !ids.includes(m.message_id))); }
  { // with a content flag and no --text, stdin must not be read (would hang with an open stdin)
    const { spawn } = require('child_process');
    const api = await fakeMixinApi({}); const bz = await fakeBlaze(); // unknown conversation -> Blaze (fake)
    const c = spawn(process.execPath, ['reply.js', ...base, '--sticker', STK], { cwd: HERE, env: { PATH: process.env.PATH, MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_API_BASE: api.url, MIXIN_GATEWAY_LOG: path.join(W, 'x.log'), MIXIN_CONV_CACHE_FILE: path.join(W, 'conv-cache.json'), MIXIN_SENT_LOG_FILE: path.join(W, 'sent-log.jsonl'), MIXIN_BLAZE_URL: bz.url, HTTPS_PROXY: 'http://127.0.0.1:9' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const code = await Promise.race([new Promise((r) => c.on('exit', r)), sleep(15000).then(() => 'hang')]);
    if (code === 'hang') c.kill('SIGKILL'); await api.close(); await bz.close();
    check('content flag without --text does not wait on stdin', code === 0, code); }
  { const n = await run([...base, '--sticker', STK]); check('reply log has no message content', !fs.readFileSync(path.join(W, 'new.log'), 'utf8').includes('看图') && !fs.readFileSync(path.join(W, 'new.log'), 'utf8').includes('这是图')); }
  // ---- D) --help / -h ----
  { const { spawn } = require('child_process'); const W2 = tmpdir('reply-help-');
    const src = ['reply.js', 'reply-args.js', 'reply-items.js', 'reply-send.js'].map((f) => fs.readFileSync(path.join(HERE, f), 'utf8')).join('\n');
    const content = JSON.parse(src.match(/const CONTENT = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
    const flags = [...new Set([...src.matchAll(/\bo\.([a-z]+)\b|o\['([a-z-]+)'\]/g)].map((m) => m[1] || m[2]).concat(content))]; // every flag reply.js reads
    const runHelp = (args) => new Promise((res) => {
      const t0 = Date.now(); // stdin stays OPEN (never ended) and no keystore: a stdin read or a send attempt would hang/fail
      const c = spawn(process.execPath, ['reply.js', ...args], { cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: W2, MIXIN_GATEWAY_LOG: path.join(W2, 'g.log'), HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', MIXIN_API_BASE: 'http://127.0.0.1:9', MIXIN_SEND_SOCKET: path.join(W2, 'none.sock'), MIXIN_SENT_LOG_FILE: path.join(W2, 'sent-log.jsonl') } });
      let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      const k = setTimeout(() => c.kill('SIGKILL'), 5000);
      c.on('exit', (code, sig) => { clearTimeout(k); res({ code, sig, out, err, ms: Date.now() - t0 }); });
    });
    for (const args of [['--help'], ['-h'], ['--conversation', uuid(), '--help'], ['--encrypted', '-h', '--text', 'x']]) {
      const r = await runHelp(args);
      const missing = flags.filter((f) => !r.out.includes(`--${f}`));
      check(`--help: ${args.join(' ')} -> usage on stdout, exit 0 fast, no stdin read`, r.code === 0 && !r.sig && r.ms < 3000 && /^usage: node reply\.js/m.test(r.out) && r.err === '', { code: r.code, sig: r.sig, ms: r.ms, err: r.err.slice(0, 200) });
      check(`--help: ${args.join(' ')} lists every flag (${flags.length}) + -h`, flags.length >= 20 && missing.length === 0 && r.out.includes('-h'), missing);
    }
    check('--help: nothing logged, no network/keystore needed', !fs.existsSync(path.join(W2, 'g.log')));
    const v = await runHelp(['--conversation', uuid(), '--reply-to', uuid(), '--text', '--help']);
    check('--text --help is a value, not the help flag', v.code !== 0 && !/^usage: node reply\.js --conversation <id> --reply-to/m.test(v.out), { code: v.code, out: v.out.slice(0, 100) }); }
  finish('reply');
})().catch((e) => { console.error(e); process.exit(1); });
