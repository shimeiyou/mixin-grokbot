'use strict';
// End-to-end gateway tests with fake Blaze + fake webhook + fake Mixin API (no real network, clean env).
//  A) OLD gateway (*.bak-s2) vs NEW gateway with all flags OFF -> identical webhook payloads (context off and on).
//  B) NEW gateway with all flags ON -> structured fields, lookups, media download/decrypt, recall/system, quote.
//  C) Persistent queue: webhook down, SIGKILL the gateway, restart -> everything delivered from disk.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const H = require('./test-helpers');
const { check, finish, uuid, fakeKeystore, ksJson, tmpdir, waitFor, sleep, fakeBlaze, blazeMsg, httpServer, fakeMixinApi, runNode, encryptFor } = H;
const mc = require('./mixin-crypto');
const { encryptAttachment } = require('./attachment-crypto');
const HERE = __dirname, LIVE = path.join(__dirname, 'test-baseline'); // frozen old code (pre-refactor snapshot)

// ---- old code tree from the *.bak-s2 backups ----
const OLD = tmpdir('gw-old-');
for (const [src, dst] of [['gateway.js', 'gateway.js'], ['blaze-conn.js', 'blaze-conn.js'], ['context-store.js', 'context-store.js'], ['common.js', 'common.js'], ['mixin-crypto.js', 'mixin-crypto.js'], ['ws-shim.js', 'ws-shim.js']]) fs.copyFileSync(path.join(LIVE, src), path.join(OLD, dst));
fs.symlinkSync(path.join(HERE, 'node_modules'), path.join(OLD, 'node_modules'));

const ks = fakeKeystore(); const U = uuid(), U2 = uuid(), CONTACT = uuid(), STICKER = uuid(), C = uuid(), G = uuid();
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 10, 0, 0, 0, 7]), crypto.randomBytes(300)]);
const OGG = Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(400)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), crypto.randomBytes(400)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(100)]);
const att = { img: uuid(), enc: uuid(), ogg: uuid(), mp4: uuid(), pdf: uuid(), exe: uuid() };
const encImg = encryptAttachment(PNG);
const blobs = { [att.img]: PNG, [att.enc]: encImg.data, [att.ogg]: OGG, [att.mp4]: MP4, [att.pdf]: PDF, [att.exe]: Buffer.from('MZ fake') };
const created = new Date(Date.now() - 5000).toISOString();
const M = (category, data, extra = {}) => blazeMsg({ category, data, user_id: U, conversation_id: C, created_at: created, ...extra });
const E = (category, obj) => M(category, mc.b64urlDecode(encryptFor(typeof obj === 'string' ? obj : JSON.stringify(obj), ks)));
const KEYB64 = encImg.key.toString('base64'), DIGB64 = encImg.digest.toString('base64');
function fixtures() {
  const t1 = M('PLAIN_TEXT', 'hello first');
  const list = [
    t1,
    M('PLAIN_TEXT', 'second, quoting', { quote_message_id: t1.message_id }),
    M('PLAIN_POST', '# title\n- item'),
    M('PLAIN_IMAGE', { attachment_id: att.img, mime_type: 'image/png', width: 10, height: 7, size: PNG.length, thumbnail: 'AAAA' }),
    E('ENCRYPTED_IMAGE', { attachment_id: att.enc, mime_type: 'image/png', width: 10, height: 7, size: PNG.length, key: KEYB64, digest: DIGB64 }),
    M('PLAIN_AUDIO', { attachment_id: att.ogg, mime_type: 'audio/ogg', size: OGG.length, duration: 3000 }),
    M('PLAIN_VIDEO', { attachment_id: att.mp4, mime_type: 'video/mp4', size: MP4.length, duration: 4000, width: 320, height: 240 }),
    M('PLAIN_DATA', { attachment_id: att.pdf, mime_type: 'application/pdf', size: PDF.length, name: 'doc.pdf' }),
    M('PLAIN_DATA', { attachment_id: att.exe, mime_type: 'application/x-msdownload', size: 7, name: 'evil.exe' }),
    M('PLAIN_STICKER', { sticker_id: STICKER }),
    M('PLAIN_CONTACT', { user_id: CONTACT }),
    M('PLAIN_LOCATION', { latitude: 31.23, longitude: 121.47, name: '上海' }),
    M('APP_CARD', { app_id: uuid(), title: 'Card', description: 'Desc', icon_url: 'https://x/i.png', action: 'https://x' }),
    M('APP_BUTTON_GROUP', [{ label: 'Yes', color: '#00ff00', action: 'input:yes' }]),
    M('PLAIN_LIVE', { url: 'https://l/x.m3u8', thumb_url: 'https://l/t.jpg', width: 1, height: 1 }),
    M('PLAIN_TRANSCRIPT', [{ message_id: uuid(), user_full_name: 'A', category: 'PLAIN_TEXT', content: 'old chat' }]),
    M('MESSAGE_PIN', { action: 'PIN', message_ids: [t1.message_id] }),
    E('ENCRYPTED_TEXT', '加密你好'),
    M('ENCRYPTED_TEXT', crypto.randomBytes(120)),
    M('PLAIN_NEW_CATEGORY', { x: 1 }),
    M('MESSAGE_RECALL', { message_id: t1.message_id }),
    M('SYSTEM_CONVERSATION', { action: 'ADD', participant_id: uuid(), user_id: U }),
    blazeMsg({ category: 'PLAIN_TEXT', data: 'blocked user', user_id: U2, conversation_id: G, created_at: created }),
    blazeMsg({ category: 'PLAIN_TEXT', data: 'from bot', user_id: ks.app_id, conversation_id: C, created_at: created }),
  ];
  return { list, t1 };
}
const FX = fixtures(); // same fixtures (same ids) for every run

async function runGateway({ dir, flags = {}, old = false, hookStatus = () => 200, expectHooks, keepDirs = {}, killWith = 'SIGTERM', blazeOpts = {}, msgs = FX.list, waitAcks = true, during = null, apiOpts = {} }) {
  const blaze = await fakeBlaze(blazeOpts); blaze.add(msgs.map((m) => ({ ...m })));
  const hooks = [];
  const hook = await httpServer((r) => { if (r.method === 'POST') { const st = hookStatus(); if (st === 200) hooks.push({ body: JSON.parse(r.body), raw: r.body.toString(), headers: r.headers }); return { status: st, body: '' }; } });
  const api = await fakeMixinApi({ blobs, users: { [U]: { user_id: U, full_name: 'Alice', identity_number: '7000001' }, [CONTACT]: { user_id: CONTACT, full_name: '张三', identity_number: '7000123' } }, stickers: { [STICKER]: { sticker_id: STICKER, name: 'wave', asset_url: 'https://s/wave.webp', asset_type: 'webp', asset_width: 128, asset_height: 128 } }, onAck: (ids) => blaze.ackHttp(ids), ...apiOpts });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'allow.json'), JSON.stringify([U]));
  const env = {
    MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_WEBHOOK_URL: hook.url + '/hook', MIXIN_WEBHOOK_KEY: 'test-webhook-key',
    MIXIN_ALLOWLIST_FILE: path.join(dir, 'allow.json'), MIXIN_SEEN_FILE: path.join(dir, 'seen.json'), MIXIN_GATEWAY_LOG: path.join(dir, 'gateway.log'),
    MIXIN_CONTEXT_DIR: keepDirs.context || path.join(dir, 'context'), MIXIN_QUEUE_DIR: keepDirs.queue || path.join(dir, 'queue'), MIXIN_MEDIA_DIR: path.join(dir, 'media'),
    MIXIN_LOOKUP_CACHE_FILE: path.join(dir, 'lookup-cache.json'), MIXIN_API_BASE: api.url, TEST_BLAZE_URL: blaze.url,
    MIXIN_SEND_SOCKET: path.join(dir, 'run', 'send.sock'),
    MIXIN_CONV_CACHE_FILE: path.join(dir, 'conv-cache.json'), MIXIN_MEMBER_ALERT_STATE_FILE: path.join(dir, 'member-alert-state.json'),
    MIXIN_MEMBER_ALERT_DELAY_MS: '200', MIXIN_MEMBER_ALERT_RECHECK_MS: '400',
    MIXIN_WEBHOOK_COALESCE_MS: '0', MIXIN_WEBHOOK_DROP_CATEGORIES: '', // 2026-10-19 usage features off here: old-vs-new stays byte-identical (covered by test-webhook-usage.js)
    HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', ...flags, // any accidental real https call fails
  };
  const cwd = old ? OLD : HERE;
  const p = runNode(['-r', path.join(HERE, 'test-redirect-ws.js'), 'gateway.js'], { env, cwd, timeoutMs: 120000 });
  const allIds = msgs.map((m) => m.message_id);
  if (waitAcks) await waitFor(() => allIds.every((id) => blaze.st.acked.has(id)), 20000);
  // dedupe check: redeliver the first message after it was ACKed
  if (msgs.length) { blaze.add([{ ...msgs[0] }]); blaze.pushAll(); await waitFor(() => blaze.st.acked.has(msgs[0].message_id) && blaze.st.pending.size === 0, 5000); }
  if (expectHooks != null) await waitFor(() => hooks.length >= expectHooks, 20000);
  if (during) await during({ env, blaze });
  await sleep(700);
  p.child.kill(killWith); const res = await p.done;
  await blaze.close(); await hook.close(); await api.close();
  const log = fs.existsSync(env.MIXIN_GATEWAY_LOG) ? fs.readFileSync(env.MIXIN_GATEWAY_LOG, 'utf8') : '';
  return { hooks, blaze, api, log, env, res, acked: allIds.filter((id) => blaze.st.acked.has(id)).length };
}
const byId = (hooks) => Object.fromEntries(hooks.map((h) => [h.body.message_id, h.body]));

(async () => {
  const base = tmpdir('gwtest-');
  const N_LEGACY = FX.list.length - 4; // minus recall, system, blocked, bot
  for (const ctx of ['0', '1']) {
    const o = await runGateway({ dir: path.join(base, `old-ctx${ctx}`), old: true, flags: { MIXIN_WEBHOOK_CONTEXT: ctx }, expectHooks: N_LEGACY });
    const n = await runGateway({ dir: path.join(base, `new-ctx${ctx}`), flags: { MIXIN_WEBHOOK_CONTEXT: ctx }, expectHooks: N_LEGACY });
    const ob = byId(o.hooks), nb = byId(n.hooks);
    const diffs = Object.keys({ ...ob, ...nb }).filter((id) => JSON.stringify(ob[id]) !== JSON.stringify(nb[id]));
    check(`[ctx=${ctx}] old and new both ACK all ${FX.list.length} msgs`, o.acked === FX.list.length && n.acked === FX.list.length, { o: o.acked, n: n.acked });
    check(`[ctx=${ctx}] same webhook count (${N_LEGACY}), dup suppressed`, o.hooks.length === N_LEGACY && n.hooks.length === N_LEGACY && /dup msg=/.test(n.log), { o: o.hooks.length, n: n.hooks.length });
    check(`[ctx=${ctx}] flags OFF: payloads byte-identical to old gateway`, diffs.length === 0, diffs.slice(0, 2).map((id) => ({ old: ob[id], new: nb[id] })));
    const oh = o.hooks[0].headers, nh = n.hooks[0].headers;
    check(`[ctx=${ctx}] same auth headers`, oh.authorization === nh.authorization && oh['x-webhook-key'] === nh['x-webhook-key'] && nh.authorization === 'Bearer test-webhook-key');
    const strip = (l) => l.split('\n').map((x) => x.replace(/^\[[^\]]+\] /, '').replace(/[0-9a-f-]{36}/g, 'ID').replace(/gen=\d+/, 'gen=N')).filter((x) => /^(recv|webhook|blocked|dup|decrypt)/.test(x)).sort().join('\n');
    // Since 2026-10-18 the webhook queue is ON by default: the only log difference is the " via=queue" suffix.
    const noVia = (l) => l.replace(/ via=queue( attempt=\d+)?/g, '');
    check(`[ctx=${ctx}] same recv/webhook/blocked/dup/decrypt log lines (modulo via=queue)`, strip(o.log) === noVia(strip(n.log)));
    check(`[ctx=${ctx}] queue ON by default (no MIXIN_WEBHOOK_QUEUE): delivered via=queue, features queue=1`, /webhook ok .*via=queue/.test(n.log) && /gateway features .*queue=1/.test(n.log) && !/via=queue/.test(o.log));
  }

  // ---- B) all flags on ----
  { // queue opt-out and boot safety (default ON since 2026-10-18)
    const off = await runGateway({ dir: path.join(base, 'queue-off'), flags: { MIXIN_WEBHOOK_QUEUE: '0' }, expectHooks: N_LEGACY });
    check('MIXIN_WEBHOOK_QUEUE=0 -> in-memory delivery (no via=queue), features queue=0', off.hooks.length === N_LEGACY && !/via=queue/.test(off.log) && /gateway features .*queue=0/.test(off.log) && /queue_active=0/.test(off.log), { hooks: off.hooks.length });
    const blocker = path.join(base, 'not-a-dir'); fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(blocker, 'x');
    const bad = await runGateway({ dir: path.join(base, 'queue-bad'), keepDirs: { queue: path.join(blocker, 'q') }, expectHooks: N_LEGACY });
    check('unusable queue dir at boot -> WARN + in-memory delivery, gateway still runs and ACKs all', /WARN queue disabled: cannot use dir/.test(bad.log) && /queue_active=0/.test(bad.log) && bad.hooks.length === N_LEGACY && bad.acked === FX.list.length && !/via=queue/.test(bad.log), { hooks: bad.hooks.length, acked: bad.acked, log: bad.log.split('\n').filter((l) => /queue/.test(l)).slice(0, 3) });
  }
  const ON = { MIXIN_PAYLOAD_V2: '1', MIXIN_PAYLOAD_TEXT_V2: '1', MIXIN_PAYLOAD_LOOKUP: '1', MIXIN_MEDIA_DOWNLOAD: '1', MIXIN_MEDIA_VIEW_URL: '1', MIXIN_FORWARD_RECALL: '1', MIXIN_FORWARD_SYSTEM: '1', MIXIN_WEBHOOK_QUEUE: '1', MIXIN_WEBHOOK_CONTEXT: '1' };
  const r = await runGateway({ dir: path.join(base, 'on'), flags: ON, expectHooks: FX.list.length - 2 });
  const b = byId(r.hooks); const L = FX.list; const at = (i) => b[L[i].message_id] || {};
  check('all flags: webhook count (all but blocked+bot)', r.hooks.length === L.length - 2, r.hooks.length);
  check('features log line', /gateway features payload_v2=1 text_v2=1 lookup=1 media=1 view_url=1 recall=1 system=1 queue=1 context=1/.test(r.log));
  check('startup line: receipt_log=1 queue_active=1 reconnect_max_ms=60000 reconnect_reset_ms=120000', /gateway receipt_log=1 queue_active=1 reconnect_max_ms=60000 reconnect_reset_ms=120000/.test(r.log));
  check('old fields all still present', r.hooks.every((h) => ['conversation_id', 'user_id', 'message_id', 'category', 'text', 'created_at', 'encrypted', 'original_category', 'context'].every((k) => k in h.body)));
  check('delay_ms (~5s) + received_at', r.hooks.every((h) => h.body.delay_ms >= 5000 && h.body.delay_ms < 60000 && h.body.received_at), at(0).delay_ms);
  check('sender_name + identity via cached lookup', at(0).sender_name === 'Alice' && at(0).sender_identity_number === '7000001');
  check('lookup cached (GET /users/U called once)', r.api.reqs.filter((q) => q.url === `/users/${U}`).length === 1, r.api.reqs.filter((q) => q.url === `/users/${U}`).length);
  check('quote_message_id + quoted content', at(1).quote_message_id === L[0].message_id && at(1).quote && at(1).quote.text === 'hello first', at(1).quote);
  check('plain image downloaded (local_path, local_mime, sha256, view_url)', at(3).attachment && fs.readFileSync(at(3).attachment.local_path).equals(PNG) && at(3).attachment.local_mime === 'image/png' && at(3).attachment.sha256 && /\/blob\//.test(at(3).attachment.view_url || ''), at(3).attachment);
  check('TEXT_V2: text = display_text', at(3).text === at(3).display_text && at(3).text.startsWith('[图片 10x7 image/png'), at(3).text);
  check('encrypted image decrypted to disk, category normalized, no view_url', at(4).category === 'PLAIN_IMAGE' && at(4).encrypted === true && fs.readFileSync(at(4).attachment.local_path).equals(PNG) && !at(4).attachment.view_url, at(4).attachment);
  check('key/digest never in any webhook body', r.hooks.every((h) => !h.raw.includes(KEYB64) && !h.raw.includes(DIGB64) && !/"key"|"digest"/.test(h.raw)));
  check('key/digest never on disk in queue/ after delivery', !fs.existsSync(path.join(r.env.MIXIN_QUEUE_DIR)) || fs.readdirSync(r.env.MIXIN_QUEUE_DIR).filter((f) => f.endsWith('.json')).length === 0);
  check('audio/video/pdf downloaded with sniffed mime', at(5).attachment.local_mime === 'audio/ogg' && at(6).attachment.local_mime === 'video/mp4' && at(7).attachment.local_mime === 'application/pdf' && at(7).attachment.local_path.endsWith('.pdf'));
  check('disallowed type -> download_error, still delivered', /type not allowed/.test(at(8).attachment.download_error || '') && !at(8).attachment.local_path);
  check('media dir 0700, files 0600', (fs.statSync(r.env.MIXIN_MEDIA_DIR).mode & 0o777) === 0o700 && fs.readdirSync(r.env.MIXIN_MEDIA_DIR).every((f) => (fs.statSync(path.join(r.env.MIXIN_MEDIA_DIR, f)).mode & 0o777) === 0o600));
  check('sticker asset via lookup', at(9).sticker.asset_url === 'https://s/wave.webp' && at(9).text === '[表情 wave]', at(9).sticker);
  check('contact name via lookup', at(10).contact.full_name === '张三' && at(10).text === '[联系人 张三 (7000123)]', at(10).text);
  check('location/card/buttons/live/transcript/pin', at(11).location.name === '上海' && at(12).app_card.title === 'Card' && at(13).buttons[0].label === 'Yes' && at(14).live.url && at(15).transcript[0].content === 'old chat' && at(16).pin.action === 'PIN');
  check('ENCRYPTED_TEXT decrypted', at(17).category === 'PLAIN_TEXT' && at(17).text === '加密你好');
  check('broken encrypted -> decrypt_error', at(18).decrypt_error === true && at(18).text === '[加密消息，暂不支持]');
  check('unknown category forwarded', at(19).category === 'PLAIN_NEW_CATEGORY');
  check('recall forwarded with recalled_message_id', at(20).category === 'MESSAGE_RECALL' && at(20).recalled_message_id === L[0].message_id);
  const ctxFile = path.join(r.env.MIXIN_CONTEXT_DIR, `${C}.json`);
  check('recall removed message from context store', fs.existsSync(ctxFile) && !JSON.parse(fs.readFileSync(ctxFile)).some((m) => m.message_id === L[0].message_id));
  check('system message forwarded', at(21).category === 'SYSTEM_CONVERSATION' && at(21).system.action === 'ADD');
  check('blocked + bot messages not forwarded', !b[L[22].message_id] && !b[L[23].message_id]);
  check('delivered via queue', /via=queue/.test(r.log));
  const bodies = ['hello first', 'second, quoting', '加密你好', 'old chat', '上海', '张三', 'Alice'];
  check('gateway.log contains no message text / names', bodies.every((t) => !r.log.includes(t)));

  // ---- C) queue survives SIGKILL ----
  const qdir = path.join(base, 'q-persist');
  const k = await runGateway({ dir: path.join(base, 'kill1'), flags: { MIXIN_WEBHOOK_QUEUE: '1', MIXIN_PAYLOAD_V2: '1' }, hookStatus: () => 503, keepDirs: { queue: qdir }, killWith: 'SIGKILL' });
  const qfiles = fs.readdirSync(qdir).filter((f) => f.endsWith('.json'));
  check('webhook down: all msgs ACKed to Mixin and queued on disk', k.acked === L.length && qfiles.length === N_LEGACY && k.hooks.length === 0, { acked: k.acked, q: qfiles.length });
  check('SIGKILL leaves queue intact (0600 files)', qfiles.every((f) => (fs.statSync(path.join(qdir, f)).mode & 0o777) === 0o600) && k.res.sig === 'SIGKILL');
  // restart: Mixin has nothing pending (all ACKed); webhook is back
  const k2 = await runGateway({ dir: path.join(base, 'kill2'), flags: { MIXIN_WEBHOOK_QUEUE: '1', MIXIN_PAYLOAD_V2: '1' }, keepDirs: { queue: qdir }, msgs: [], expectHooks: N_LEGACY, waitAcks: false });
  const ids = new Set(k2.hooks.map((h) => h.body.message_id));
  check('after restart: every queued payload delivered once from disk', k2.hooks.length === N_LEGACY && ids.size === N_LEGACY && /queue loaded pending=/.test(k2.log), k2.hooks.length);
  check('queue empty after delivery', fs.readdirSync(qdir).filter((f) => f.endsWith('.json')).length === 0);

  // ---- D) payload cap (payload-cap.js): big CJK context, all flags on, real gateway process ----
  const CC = uuid(), CC2 = uuid(); const cdir = path.join(base, 'cap-context'); fs.mkdirSync(cdir, { recursive: true, mode: 0o700 });
  const CJK = '我们今天讨论一下这个网关的上下文截断问题，看看会不会丢字段。';
  const seeded = Array.from({ length: 20 }, (_, i) => ({ user_id: i % 2 ? ks.app_id : U, message_id: uuid(), text: `#${i} ` + CJK.repeat(50), created_at: new Date(Date.now() - (30 - i) * 60000).toISOString(), from_bot: i % 2 === 1 }));
  fs.writeFileSync(path.join(cdir, `${CC}.json`), JSON.stringify(seeded), { mode: 0o600 });
  const capCreated = new Date(Date.now() - 4000).toISOString();
  const cm = (category, data, extra = {}) => blazeMsg({ category, data, user_id: U, conversation_id: CC, created_at: capCreated, ...extra });
  const capMsgs = [
    cm('PLAIN_TEXT', '请总结一下上面的讨论', { quote_message_id: seeded[18].message_id }),
    cm('PLAIN_IMAGE', { attachment_id: att.img, mime_type: 'image/png', width: 10, height: 7, size: PNG.length, thumbnail: 'AAAA' }),
    blazeMsg({ category: 'PLAIN_POST', data: CJK.repeat(300), user_id: U, conversation_id: CC2, created_at: capCreated }), // ~27KB, no context
  ];
  const cr = await runGateway({ dir: path.join(base, 'cap'), flags: ON, keepDirs: { context: cdir }, msgs: capMsgs, expectHooks: capMsgs.length });
  const cb = byId(cr.hooks); const cat = (i) => cb[capMsgs[i].message_id] || {}; const craw = (i) => (cr.hooks.find((h) => h.body.message_id === capMsgs[i].message_id) || {}).raw || '';
  check('[cap] all 3 delivered', cr.hooks.length === 3, cr.hooks.length);
  check('[cap] every webhook body <= 6000 UTF-8 bytes', cr.hooks.every((h) => Buffer.byteLength(h.raw, 'utf8') <= 6000), cr.hooks.map((h) => Buffer.byteLength(h.raw, 'utf8')));
  check('[cap] context is the last key; oldest items dropped, counted', [0, 1].every((i) => Object.keys(cat(i)).pop() === 'context' && cat(i).context.length > 0 && cat(i).context_truncated === true && cat(i).context_dropped === 20 - cat(i).context.length && cat(i).context.every((m) => Array.from(m.text).length <= 500)), [0, 1].map((i) => ({ kept: (cat(i).context || []).length, dropped: cat(i).context_dropped })));
  check('[cap] newest context kept (last item = previous message)', cat(1).context[cat(1).context.length - 1].message_id === capMsgs[0].message_id);
  check('[cap] display_text, delay_ms, sender_name, quote all present before context', cat(0).display_text === '请总结一下上面的讨论' && cat(0).delay_ms >= 4000 && cat(0).sender_name === 'Alice' && cat(0).quote && cat(0).quote.message_id === seeded[18].message_id && Array.from(cat(0).quote.text).length === 500 && cat(0).quote.text_truncated === true && seeded[18].text.startsWith(cat(0).quote.text) && ['display_text', 'delay_ms', 'sender_name', 'quote'].every((k) => craw(0).indexOf(`"${k}"`) < craw(0).indexOf('"context"')));
  check('[cap] attachment.local_path (media download) kept, before context', cat(1).attachment && fs.readFileSync(cat(1).attachment.local_path).equals(PNG) && craw(1).indexOf('"local_path"') < craw(1).indexOf('"context"'));
  check('[cap] no-context huge post: text+display_text cut, truncated:true', cat(2).truncated === true && CJK.repeat(300).startsWith(cat(2).text) && cat(2).text.length > 500 && cat(2).text === cat(2).display_text && Array.isArray(cat(2).context) && cat(2).context.length === 0);
  check('[cap] log: payload capped lines (sizes only) + startup line, no text', /payload capped msg=\S+ bytes=\d+->\d+ max=6000/.test(cr.log) && /gateway payload_cap max_bytes=6000 context_item_max_chars=500/.test(cr.log) && !cr.log.includes('我们') && !cr.log.includes('请总结'));
  { // fix #4: local send endpoint on the gateway's main Blaze connection
    const { sendViaEndpoint } = require('./send-endpoint'); let r = null, mode = null, created = 0, conns = 0;
    const g = await runGateway({ dir: path.join(base, 'endpoint'), msgs: [], waitAcks: false, during: async ({ env, blaze }) => {
      await waitFor(() => fs.existsSync(env.MIXIN_SEND_SOCKET), 10000); mode = (fs.statSync(env.MIXIN_SEND_SOCKET).mode & 0o777).toString(8);
      conns = blaze.st.conns;
      r = await sendViaEndpoint({ conversation_id: uuid(), message_id: uuid(), category: 'ENCRYPTED_TEXT', data_base64: 'eA', status: 'SENT' }, { socketPath: env.MIXIN_SEND_SOCKET }).catch((e) => e);
      created = blaze.st.created.length; conns = blaze.st.conns - conns;
    } });
    check('gateway: send endpoint listening (0600), CREATE_MESSAGE sent on the main connection (no new socket)', r && !(r instanceof Error) && created === 1 && conns === 0 && mode === '600' && /send endpoint listening socket=/.test(g.log) && /send endpoint msg=\S+ conv=\S+ cat=ENCRYPTED_TEXT ok/.test(g.log), { r: r && r.message, created, conns, mode });
    check('gateway: socket removed on shutdown', !fs.existsSync(g.env.MIXIN_SEND_SOCKET));
  }
  { // P0: member change -> conv cache invalidated + additive kind:"member_alert" webhook event
    const { curvePub } = H; const G2 = uuid(), X = uuid(), Y = uuid(); const seedU = crypto.randomBytes(32);
    const sessU = { user_id: U, session_id: uuid(), public_key: curvePub(seedU) };
    const conv = { conversation_id: G2, category: 'GROUP', participants: [{ user_id: U }, { user_id: X }, { user_id: ks.app_id }], participant_sessions: [sessU, { user_id: ks.app_id, session_id: ks.session_id, public_key: curvePub(ks._seed) }] };
    const sys = (data, extra = {}) => blazeMsg({ category: 'SYSTEM_CONVERSATION', data, user_id: U, conversation_id: G2, created_at: created, ...extra });
    const txt = blazeMsg({ category: 'PLAIN_TEXT', data: 'normal text', user_id: U, conversation_id: G2, created_at: created });
    const add = sys({ action: 'ADD', participant_id: X, user_id: U });
    const seedCache = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'conv-cache.json'), JSON.stringify({ [G2]: { category: 'GROUP', at: 1 }, [C]: { category: 'GROUP', at: 1 } })); };
    const d1 = path.join(base, 'member1'); seedCache(d1);
    const r = await runGateway({ dir: d1, msgs: [txt, add], expectHooks: 2, apiOpts: { conversations: { [G2]: conv } }, during: async () => { await sleep(1500); } });
    const alert = r.hooks.map((h) => h.body).find((b) => b.kind === 'member_alert');
    const normal = r.hooks.map((h) => h.body).find((b) => b.message_id === txt.message_id);
    check('member alert: additive webhook event kind=member_alert for a member without session', alert && alert.conversation_id === G2 && alert.category === 'SYSTEM_CONVERSATION' && alert.member_alert.new_missing.length === 1 && alert.member_alert.new_missing[0] === X && alert.member_alert.missing[0].reason === 'no_session' && alert.member_alert.trigger.action === 'ADD' && alert.member_alert.trigger.participant_id === X && alert.member_alert.members_total === 2 && typeof alert.text === 'string' && alert.user_id === U, alert);
    check('member alert: normal payloads unchanged (no kind field); system msg itself not forwarded (FORWARD_SYSTEM off)', normal && !('kind' in normal) && !r.hooks.some((h) => h.body.message_id === add.message_id) && r.hooks.length === 2);
    const cache = JSON.parse(fs.readFileSync(path.join(d1, 'conv-cache.json'), 'utf8'));
    check('member change: conv-cache entry of that group invalidated (then refreshed by the re-check), others kept', (!cache[G2] || cache[G2].at > 1) && cache[C] && cache[C].at === 1 && /member change conv=\S+ action=ADD participant=\S+ msg=\S+ cache=invalidated/.test(r.log), cache);
    check('member alert: logs ids/counts only, state file 0600', /member alert conv=\S+ new_missing=\S+ missing=1/.test(r.log) && !r.log.includes('normal text') && (fs.statSync(path.join(d1, 'member-alert-state.json')).mode & 0o777) === 0o600);
    // same group again (state kept): another event, X still missing -> no duplicate alert; a NEW missing member -> alert
    conv.participants.push({ user_id: Y });
    const r2 = await runGateway({ dir: d1, msgs: [sys({ action: 'ROLE', participant_id: U, role: 'ADMIN', user_id: U }), sys({ action: 'JOIN', participant_id: Y, user_id: Y })], expectHooks: 1, apiOpts: { conversations: { [G2]: conv }, sessions: {} }, during: async () => { await sleep(2500); } });
    const a2 = r2.hooks.map((h) => h.body).filter((b) => b.kind === 'member_alert');
    check('member alert: only NEW missing members alert again (X not repeated, Y alerted after recheck)', a2.length === 1 && a2[0].member_alert.new_missing.join() === Y && a2[0].member_alert.missing_total === 2 && /rechecking in 400ms/.test(r2.log), { n: a2.length, a: a2[0] && a2[0].member_alert });
    // MIXIN_MEMBER_ALERT=0: cache still invalidated, no alert; FORWARD_SYSTEM=1 still forwards the system message unchanged
    const d3 = path.join(base, 'member3'); seedCache(d3); conv.participants = conv.participants.filter((p) => p.user_id !== Y);
    const add3 = sys({ action: 'ADD', participant_id: X, user_id: U });
    const r3 = await runGateway({ dir: d3, msgs: [add3], expectHooks: 1, flags: { MIXIN_MEMBER_ALERT: '0', MIXIN_FORWARD_SYSTEM: '1' }, apiOpts: { conversations: { [G2]: conv } }, during: async () => { await sleep(1200); } });
    check('MIXIN_MEMBER_ALERT=0: no alert, cache still invalidated; MIXIN_FORWARD_SYSTEM=1 forwards the system message as before', r3.hooks.length === 1 && r3.hooks[0].body.message_id === add3.message_id && r3.hooks[0].body.system.action === 'ADD' && !('kind' in r3.hooks[0].body) && !JSON.parse(fs.readFileSync(path.join(d3, 'conv-cache.json'), 'utf8'))[G2] && /gateway member_alert=0/.test(r3.log), r3.hooks.map((h) => h.body.kind || h.body.category));
    // group without any allowlisted member -> no alert
    const G3 = uuid(); const conv3 = { conversation_id: G3, category: 'GROUP', participants: [{ user_id: X }, { user_id: ks.app_id }], participant_sessions: [] };
    const r4 = await runGateway({ dir: path.join(base, 'member4'), msgs: [blazeMsg({ category: 'SYSTEM_CONVERSATION', data: { action: 'ADD', participant_id: X }, user_id: X, conversation_id: G3, created_at: created })], waitAcks: true, apiOpts: { conversations: { [G3]: conv3 } }, during: async () => { await sleep(1200); } });
    check('member check skipped for groups without an allowlisted member (no alert)', r4.hooks.length === 0 && /member check skipped conv=\S+ reason=no_allowlisted_member/.test(r4.log));
  }
  finish('gateway');
})().catch((e) => { console.error(e); process.exit(1); });
