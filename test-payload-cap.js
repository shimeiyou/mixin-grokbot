'use strict';
// payload-cap.js: key order (context last), per-item text cap, UTF-8 byte cap (oldest context dropped first),
// no-context text fallback, idempotency, and the persistent queue storing the final capped payload.
const fs = require('fs'); const path = require('path');
const { capPayload, createFinalizer, ORDER } = require('./payload-cap');
const { createDelivery } = require('./webhook-queue');
const { check, finish, tmpdir, httpServer, waitFor, sleep, uuid } = require('./test-helpers');
const B = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const CJK = '我们今天讨论一下这个网关的上下文截断问题，看看会不会丢字段。';
const cjk = (n) => CJK.repeat(Math.ceil(n / CJK.length)).slice(0, n);
const now = Date.now();
const ctxItems = (n, chars) => Array.from({ length: n }, (_, i) => ({ user_id: uuid(), message_id: uuid(), text: `#${i} ` + cjk(chars), created_at: new Date(now - (n - i) * 60000).toISOString(), from_bot: i % 2 === 1 }));
// Payload built the way gateway.js builds it: context inserted BEFORE the V2 fields (the original bug).
function v2Payload({ context, text = '请看这张图 ' + cjk(40), extra = {} } = {}) {
  const p = { conversation_id: uuid(), user_id: uuid(), message_id: uuid(), category: 'PLAIN_IMAGE', text, created_at: new Date(now - 3000).toISOString(), encrypted: false, original_category: 'PLAIN_IMAGE' };
  if (context) p.context = context;
  Object.assign(p, { quote_message_id: uuid(), attachment: { attachment_id: uuid(), mime_type: 'image/png', size: 1234, width: 10, height: 7, thumbnail: 'A'.repeat(300) } });
  p.display_text = text; p.received_at = new Date(now).toISOString(); p.delay_ms = 3000;
  p.quote = { message_id: p.quote_message_id, user_id: uuid(), text: '被引用的消息', created_at: new Date(now - 9000).toISOString(), from_bot: false };
  p.sender_name = '南希'; p.sender_identity_number = '7000001';
  p.attachment.local_path = '/srv/mixin-media/x.png'; p.attachment.local_mime = 'image/png'; p.attachment.sha256 = 'f'.repeat(64);
  Object.assign(p, extra);
  return p;
}

(async () => {
  // 1) large CJK context: 20 items x 1500 CJK chars (~4.5KB each, ~90KB of context)
  const big = v2Payload({ context: ctxItems(20, 1500) });
  check('fixture is large (> 60KB, CJK)', B(big) > 60000, B(big));
  const { payload: c, info } = capPayload(big, { maxBytes: 6000, itemMaxChars: 500 });
  const raw = JSON.stringify(c);
  check('capped body <= 6000 UTF-8 bytes', Buffer.byteLength(raw, 'utf8') <= 6000 && info.after === Buffer.byteLength(raw), info);
  check('measured in UTF-8 bytes, not chars (CJK = 3 bytes)', raw.length < Buffer.byteLength(raw, 'utf8'));
  const keys = Object.keys(c);
  check('context is the LAST key', keys[keys.length - 1] === 'context', keys);
  const known = keys.filter((k) => ORDER.includes(k));
  check('fixed order for core + V2 fields', JSON.stringify(known) === JSON.stringify(ORDER.filter((k) => known.includes(k))), keys);
  check('core fields lead in the old order', keys.slice(0, 8).join() === 'conversation_id,user_id,message_id,category,text,created_at,encrypted,original_category', keys);
  check('display_text/delay_ms/sender_*/quote/attachment(local_path) all kept, unchanged',
    c.display_text === big.display_text && c.delay_ms === 3000 && c.sender_name === '南希' && c.sender_identity_number === '7000001' && c.quote.text === '被引用的消息' && c.quote_message_id === big.quote_message_id && c.attachment.local_path === big.attachment.local_path && c.attachment.sha256 === big.attachment.sha256);
  check('...and they are all serialized before "context"', ['display_text', 'delay_ms', 'sender_name', 'quote', 'attachment', 'local_path'].every((k) => raw.indexOf(`"${k}"`) > 0 && raw.indexOf(`"${k}"`) < raw.indexOf('"context"')));
  check('attachment.thumbnail moved last inside attachment', Object.keys(c.attachment).pop() === 'thumbnail' && c.attachment.thumbnail === big.attachment.thumbnail);
  check('each context item text <= 500 chars, marked text_truncated', c.context.length > 0 && c.context.every((m) => Array.from(m.text).length <= 500 && m.text_truncated === true));
  check('oldest dropped first (kept = newest, contiguous, in order)', JSON.stringify(c.context.map((m) => m.message_id)) === JSON.stringify(big.context.slice(-c.context.length).map((m) => m.message_id)));
  check('context_truncated + context_dropped count', c.context_truncated === true && c.context_dropped === 20 - c.context.length && c.context_dropped === info.dropped && info.dropped > 0, { kept: c.context.length, dropped: c.context_dropped });
  check('maximal: one more (older) item would not fit', B(capPayload({ ...big }, { maxBytes: 6000 + 1, itemMaxChars: 500 }).payload) <= 6001 && (() => { const one = { ...c, context: big.context.slice(-c.context.length - 1).map((m) => ({ ...m, text: Array.from(m.text).slice(0, 500).join(''), text_truncated: true })), context_dropped: c.context_dropped - 1 }; return B(one) > 6000; })());
  check('no field removed or renamed', Object.keys(big).every((k) => k in c) && Object.keys(big.attachment).every((k) => k in c.attachment) && Object.keys(big.context[0]).every((k) => k in c.context[0]));
  check('input not mutated', big.context.length === 20 && Array.from(big.context[0].text).length > 500 && !('context_dropped' in big));
  check('no text truncation needed when context alone was the problem', !('truncated' in c) && c.text === big.text);
  // idempotent: capping a capped payload again changes nothing
  const again = capPayload(c, { maxBytes: 6000, itemMaxChars: 500 }).payload;
  check('idempotent (re-cap = same bytes, same dropped count)', JSON.stringify(again) === raw);
  // after enrichment adds fields, re-cap drops more and the counts add up
  const enriched = { ...c, sender_name: '南'.repeat(700) };
  const re = capPayload(enriched, { maxBytes: 6000, itemMaxChars: 500 }).payload;
  check('re-cap after enrichment: <= cap, cumulative context_dropped', B(re) <= 6000 && re.context_dropped === 20 - re.context.length && re.context.length < c.context.length);

  // quote.text from the context store can be 2000 chars: cut like a context item
  const qbig = v2Payload({ context: ctxItems(3, 50) }); qbig.quote = { ...qbig.quote, text: cjk(1800) };
  const qc = capPayload(qbig, { maxBytes: 6000, itemMaxChars: 500 }).payload;
  check('quote.text cut to 500 chars, quote.text_truncated, other quote fields kept, input untouched', Array.from(qc.quote.text).length === 500 && qc.quote.text_truncated === true && qc.quote.message_id === qbig.quote.message_id && qbig.quote.text.length === 1800 && qc.context.length === 3);

  // 2) small payload: untouched apart from order, no flags
  const small = v2Payload({ context: ctxItems(2, 20) });
  const s = capPayload(small, { maxBytes: 6000, itemMaxChars: 500 }).payload;
  check('small payload: same content, no truncation flags', B(s) === B(small) && !('context_truncated' in s) && !('context_dropped' in s) && !('truncated' in s) && s.context.length === 2);
  check('small payload: context moved to the end', Object.keys(small).indexOf('context') < Object.keys(small).length - 1 && Object.keys(s).pop() === 'context');
  const legacy = { conversation_id: 'c', user_id: 'u', message_id: 'm', category: 'PLAIN_TEXT', text: 'hi', created_at: 't', encrypted: false, original_category: 'PLAIN_TEXT' };
  check('legacy (flags off) payload byte-identical', JSON.stringify(capPayload(legacy).payload) === JSON.stringify(legacy));
  const legacyCtx = { ...legacy, context: [] };
  check('legacy + empty context byte-identical', JSON.stringify(capPayload(legacyCtx).payload) === JSON.stringify(legacyCtx));
  check('item cap alone sets context_truncated (no drop count)', (() => { const p = capPayload(v2Payload({ context: ctxItems(1, 800) })).payload; return p.context_truncated === true && !('context_dropped' in p) && Array.from(p.context[0].text).length === 500; })());
  check('surrogate pairs not split by item cap', (() => { const p = capPayload({ ...legacy, context: [{ message_id: 'x', text: '😀'.repeat(600) }] }).payload; return Array.from(p.context[0].text).length === 500 && !/[\ud800-\udbff]$/.test(p.context[0].text); })());

  // 3) no-context fallback: text/display_text alone exceed the cap
  const huge = cjk(5000); // ~15KB of CJK
  for (const withCtx of [false, true]) {
    const p = v2Payload({ text: huge, context: withCtx ? ctxItems(5, 300) : undefined });
    const { payload: h, info: hi } = capPayload(p, { maxBytes: 6000, itemMaxChars: 500 });
    const tag = withCtx ? '[ctx dropped to []]' : '[no context field]';
    check(`${tag} fallback: <= 6000 bytes, truncated:true`, B(h) <= 6000 && h.truncated === true && hi.textCut, { b: B(h) });
    check(`${tag} text and display_text are prefixes of the original`, h.text.length > 100 && huge.startsWith(h.text) && huge.startsWith(h.display_text) && h.text.length < huge.length);
    check(`${tag} uses the space (within 60 bytes of the cap)`, B(h) > 6000 - 60, B(h));
    check(`${tag} other fields intact`, h.sender_name === '南希' && h.attachment.local_path === p.attachment.local_path && h.quote.text === '被引用的消息');
    if (withCtx) check('[ctx] all context dropped first, counts set', Array.isArray(h.context) && h.context.length === 0 && h.context_dropped === 5 && h.context_truncated === true && Object.keys(h).pop() === 'context');
    else check('[no ctx] no context fields invented', !('context' in h) && !('context_dropped' in h));
  }
  // legacy flags-off long text (only `text`)
  const lt = capPayload({ ...legacy, text: huge }, { maxBytes: 6000 }).payload;
  check('legacy long text cut to fit, truncated:true, no display_text invented', B(lt) <= 6000 && lt.truncated === true && !('display_text' in lt) && huge.startsWith(lt.text));
  // env knobs + disable
  check('maxBytes<=0 disables the byte cap (order + item cap still applied)', (() => { const p = capPayload(big, { maxBytes: 0, itemMaxChars: 500 }).payload; return p.context.length === 20 && !('context_dropped' in p) && Object.keys(p).pop() === 'context'; })());
  process.env.MIXIN_WEBHOOK_MAX_BYTES = '3000'; process.env.MIXIN_CONTEXT_ITEM_MAX_CHARS = '100';
  const logs = []; const f = createFinalizer({ log: (l) => logs.push(l) });
  const fe = f(big);
  check('env MIXIN_WEBHOOK_MAX_BYTES / MIXIN_CONTEXT_ITEM_MAX_CHARS honoured', B(fe) <= 3000 && fe.context.every((m) => Array.from(m.text).length <= 100));
  check('finalizer logs sizes only (no text)', logs.length === 1 && /payload capped msg=\S+ bytes=\d+->\d+ max=3000 context_dropped=\d+/.test(logs[0]) && !logs[0].includes('我们') && !logs[0].includes('南希'), logs);
  delete process.env.MIXIN_WEBHOOK_MAX_BYTES; delete process.env.MIXIN_CONTEXT_ITEM_MAX_CHARS;

  // 4) persistent queue stores the FINAL capped payload
  let status = 503; const got = [];
  const hook = await httpServer((r) => { if (r.method === 'POST') { if (status === 200) got.push({ raw: r.body.toString(), body: JSON.parse(r.body) }); return { status, body: '' }; } });
  const fin = createFinalizer({ maxBytes: 6000, itemMaxChars: 500 });
  const qdir = path.join(tmpdir('qcap-'), 'queue');
  const mk = (extra = {}) => createDelivery({ url: hook.url, log: () => {}, headers: () => ({ 'Content-Type': 'application/json' }), finalize: fin, queue: { enabled: true, dir: qdir, baseBackoffMs: 50, maxBackoffMs: 100, scanMs: 50 }, ...extra });
  const d1 = mk(); const qp = v2Payload({ context: ctxItems(20, 1500) });
  check('queue submit -> queued', d1.submit(qp, null, false) === 'queued');
  const recOf = (id) => JSON.parse(fs.readFileSync(path.join(qdir, `${id}.json`), 'utf8'));
  const r1 = recOf(qp.message_id);
  check('on-disk record holds the capped payload (<= 6000 bytes, context last)', B(r1.payload) <= 6000 && r1.payload.context_dropped > 0 && Object.keys(r1.payload).pop() === 'context' && r1.capped === true, B(r1.payload));
  // enrichment path: raw until enriched, then capped + persisted before the first POST
  const d2 = mk({ enrich: async (p) => { p.sender_name = '南希'; p.attachment.local_path = '/m/y.png'; } });
  const ep = v2Payload({ context: ctxItems(20, 1500) }); delete ep.sender_name; delete ep.attachment.local_path;
  d2.submit(ep, { key: 'K' }, true);
  await waitFor(() => { try { return recOf(ep.message_id).enriched && recOf(ep.message_id).attempts >= 1; } catch (_) { return false; } }, 3000);
  const r2 = recOf(ep.message_id);
  check('enriched record re-persisted capped (sender_name + local_path kept, <= 6000)', r2.capped && B(r2.payload) <= 6000 && r2.payload.sender_name === '南希' && r2.payload.attachment.local_path === '/m/y.png' && Object.keys(r2.payload).pop() === 'context' && !r2.priv);
  // legacy record already on disk (written before payload-cap): upgraded before sending
  const lp = v2Payload({ context: ctxItems(20, 1500) }); const lid = lp.message_id;
  d1.stop(); d2.stop(); await sleep(150);
  fs.writeFileSync(path.join(qdir, `${lid}.json`), JSON.stringify({ v: 1, id: lid, enqueued_at: Date.now(), next_at: Date.now(), attempts: 0, needs_enrich: false, enriched: true, priv: null, payload: lp }), { mode: 0o600 });
  status = 200;
  const d3 = mk();
  await waitFor(() => got.length >= 3, 5000);
  check('all 3 delivered', got.length === 3 && [qp.message_id, ep.message_id, lid].every((id) => got.some((g) => g.body.message_id === id)), got.length);
  check('every delivered body <= 6000 UTF-8 bytes, context last', got.every((g) => Buffer.byteLength(g.raw, 'utf8') <= 6000 && Object.keys(g.body).pop() === 'context'), got.map((g) => Buffer.byteLength(g.raw)));
  check('pre-existing (old-format) queue record capped before send', (() => { const g = got.find((x) => x.body.message_id === lid); return g && g.body.context_dropped > 0; })());
  d3.stop();
  // memory path (queue off) also capped, after enrichment
  got.length = 0;
  const d4 = createDelivery({ url: hook.url, log: () => {}, headers: () => ({}), finalize: fin, enrich: async (p) => { p.sender_name = 'Z'; }, queue: { enabled: false } });
  d4.submit(v2Payload({ context: ctxItems(20, 1500) }), null, true);
  await waitFor(() => got.length >= 1, 3000);
  check('queue off: in-memory delivery capped too (after enrichment)', got.length === 1 && Buffer.byteLength(got[0].raw) <= 6000 && got[0].body.sender_name === 'Z' && Object.keys(got[0].body).pop() === 'context');
  await hook.close(); finish('payload-cap');
})().catch((e) => { console.error(e); process.exit(1); });
