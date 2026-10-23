'use strict';
// 2026-10-19 AI-usage batch: webhook filter, coalescing (timing, persistence, recall), retry/backoff + Retry-After,
// persisted sent-id dedupe, merged payload size cap; plus gateway.js end to end with fake Blaze + fake webhook.
// Offline only (local fake servers, temp dirs, fake keystore, clean env).
const fs = require('fs'); const path = require('path');
const { createDelivery } = require('./webhook-queue');
const { createFinalizer } = require('./payload-cap');
const H = require('./test-helpers');
const { check, finish, uuid, fakeKeystore, ksJson, tmpdir, waitFor, sleep, fakeBlaze, blazeMsg, httpServer, fakeMixinApi, runNode } = H;
const HERE = __dirname; const W = tmpdir('wh-usage-');

(async () => {
  let status = 200, extraHeaders = {}; const hits = [];
  const hook = await httpServer((r) => { if (r.method === 'POST') { hits.push({ t: Date.now(), body: JSON.parse(r.body), st: status }); return { status, body: '', headers: status === 200 ? {} : extraHeaders }; } });
  let n = 0;
  const mk = (extra = {}, co = { idleMs: 300, maxMs: 1000, maxItems: 20 }) => { const logs = []; const dir = extra.dir || path.join(W, `q${++n}`);
    const d = createDelivery({ url: hook.url, log: (...a) => logs.push(a.join(' ')), headers: () => ({ 'Content-Type': 'application/json' }), coalesce: co, maxBytes: extra.maxBytes ?? 6000,
      finalize: extra.finalize || null, random: extra.random || Math.random, enrich: extra.enrich || null,
      queue: { enabled: true, dir, baseBackoffMs: extra.base ?? 50, maxBackoffMs: extra.maxBackoff ?? 400, scanMs: 50, maxAttempts: extra.maxAttempts ?? 50 } });
    return { d, logs, dir }; };
  const C = uuid(), U = uuid(), U2 = uuid();
  const pl = (text, o = {}) => ({ conversation_id: o.c || C, user_id: o.u || U, message_id: uuid(), category: o.cat || 'PLAIN_TEXT', text, created_at: new Date().toISOString(), encrypted: false, original_category: o.cat || 'PLAIN_TEXT', display_text: text, ...(o.extra || {}) });
  const key = (p) => `${p.conversation_id}:${p.user_id}`;
  const reset = () => { hits.length = 0; status = 200; extraHeaders = {}; };

  // ---------- coalescing ----------
  { reset(); const t = mk(); const ps = [pl('a'), pl('b', { cat: 'PLAIN_STICKER', extra: { sticker: { sticker_id: uuid() } } }), pl('c', { extra: { attachment: { attachment_id: uuid(), thumbnail: 'T'.repeat(50), local_path: '/x' }, context: [{ text: 'old' }] } })];
    const t0 = Date.now(); for (const p of ps) { t.d.submit(p, null, false, { coalesceKey: key(p) }); await sleep(100); }
    await waitFor(() => hits.length >= 1, 3000); await sleep(500);
    const b = hits[0] && hits[0].body; const latest = ps[2];
    check('3 messages (same conv+sender) within the window -> ONE webhook', hits.length === 1 && b.merged_count === 3, hits.map((h) => h.body.message_id));
    check('top-level fields = the LATEST message exactly as today (incl. context)', b && Object.keys(latest).every((k) => JSON.stringify(b[k]) === JSON.stringify(latest[k])));
    check('merged_messages oldest first incl. latest, with message_id/category/created_at/text', b && b.merged_messages.map((m) => m.message_id).join() === ps.map((p) => p.message_id).join() && b.merged_messages.every((m, i) => m.category === ps[i].category && m.text === ps[i].text && m.created_at === ps[i].created_at));
    check('merged items keep data fields (sticker, attachment) but not context / thumbnail / conversation_id', b.merged_messages[1].sticker && b.merged_messages[2].attachment.local_path === '/x' && !('thumbnail' in b.merged_messages[2].attachment) && !('context' in b.merged_messages[2]) && !('conversation_id' in b.merged_messages[0]));
    check('flushed ~idle after the LAST message (debounce), before the max window', hits[0].t - t0 >= 500 && hits[0].t - t0 < 1300, hits[0].t - t0);
    check('log: coalesce hold x2, coalesced merged=3, webhook ok … merged=3', t.logs.filter((l) => /webhook coalesce hold/.test(l)).length === 2 && t.logs.some((l) => /webhook coalesced group=\S+ msg=\S+ merged=3/.test(l)) && t.logs.some((l) => new RegExp(`webhook ok msg=${latest.message_id} status=200 via=queue attempt=1 merged=3`).test(l)), t.logs);
    check('queue dir empty after delivery (followers removed)', fs.readdirSync(t.dir).filter((f) => f.endsWith('.json')).length === 0);
    check('counters: pushed=1 merged_webhooks=1 merged_messages=3', JSON.stringify(t.d.stats().counters).includes('"pushed":1') && t.d.stats().counters.merged_messages === 3);
    t.d.stop(); }
  { reset(); const t = mk(); const p = pl('solo'); const t0 = Date.now(); t.d.submit(p, null, false, { coalesceKey: key(p) });
    await waitFor(() => hits.length >= 1, 3000);
    check('single message -> payload unchanged (no merged_* fields), after ~idle', hits.length === 1 && JSON.stringify(hits[0].body) === JSON.stringify(p) && hits[0].t - t0 >= 250, hits[0] && hits[0].t - t0);
    t.d.stop(); }
  { reset(); const t = mk(); const a = pl('a'), b = pl('b', { u: U2 }), c = pl('c', { c: uuid() });
    for (const p of [a, b, c]) t.d.submit(p, null, false, { coalesceKey: key(p) });
    await waitFor(() => hits.length >= 3, 3000); await sleep(300);
    check('different sender / different conversation -> separate webhooks', hits.length === 3 && hits.every((h) => !('merged_count' in h.body)));
    t.d.stop(); }
  { reset(); const t = mk(); const t0 = Date.now(); const ps = [];
    for (let i = 0; i < 12; i++) { const p = pl(`m${i}`); ps.push(p); t.d.submit(p, null, false, { coalesceKey: key(p) }); await sleep(200); } // gap 200 < idle 300: debounce alone would never fire
    await waitFor(() => hits.length >= 2, 4000); await sleep(800);
    const first = hits[0];
    check('max window: flushed at ~maxMs after the FIRST message even while messages keep coming (no endless extension)', first && first.t - t0 >= 950 && first.t - t0 < 1500 && first.body.merged_count >= 4, first && { dt: first.t - t0, n: first.body.merged_count });
    const all = hits.flatMap((h) => (h.body.merged_messages ? h.body.merged_messages.map((m) => m.message_id) : [h.body.message_id]));
    check('every message delivered exactly once across the groups', all.length === 12 && new Set(all).size === 12 && ps.every((p) => all.includes(p.message_id)), all.length);
    t.d.stop(); }
  { reset(); const t = mk({}, { idleMs: 5000, maxMs: 10000, maxItems: 3 }); const t0 = Date.now();
    for (let i = 0; i < 3; i++) { const p = pl(`x${i}`); t.d.submit(p, null, false, { coalesceKey: key(p) }); }
    await waitFor(() => hits.length >= 1, 3000);
    check('maxItems reached -> flushed at once', hits.length === 1 && hits[0].body.merged_count === 3 && hits[0].t - t0 < 1000);
    t.d.stop(); }
  { reset(); status = 503; const dir = path.join(W, 'crash'); const t = mk({ dir }, { idleMs: 5000, maxMs: 10000, maxItems: 20 });
    const a = pl('a'), b = pl('b'); t.d.submit(a, null, false, { coalesceKey: key(a) }); t.d.submit(b, null, false, { coalesceKey: key(b) });
    const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    t.d.stop(); status = 200; // "crash" while the group is still held
    const t2 = mk({ dir }); await waitFor(() => hits.length >= 1, 3000); await sleep(300);
    check('held group is on disk (2 records) and survives a crash: delivered once, merged, after restart', onDisk === 2 && hits.length === 1 && hits[0].body.merged_count === 2 && hits[0].body.merged_messages.map((m) => m.text).join() === 'a,b', { onDisk, n: hits.length });
    t2.d.stop(); }
  { reset(); const t = mk(); const a = pl('a'), b = pl('b'), c = pl('c');
    for (const p of [a, b, c]) t.d.submit(p, null, false, { coalesceKey: key(p) });
    check('retract (recall) a held follower -> true', t.d.retract(b.message_id) === true);
    await waitFor(() => hits.length >= 1, 3000); await sleep(200);
    check('recalled follower is not in the merged webhook', hits.length === 1 && hits[0].body.merged_messages.map((m) => m.text).join() === 'a,c' && hits[0].body.merged_count === 2);
    const s = pl('alone'); t.d.submit(s, null, false, { coalesceKey: key(s) }); t.d.retract(s.message_id); await sleep(800);
    check('recalled single message still waiting -> never pushed', hits.length === 1 && t.logs.some((l) => /webhook skipped msg=\S+ \(recalled/.test(l)));
    const l1 = pl('l1'), l2 = pl('l2'); t.d.submit(l1, null, false, { coalesceKey: key(l1) }); t.d.submit(l2, null, false, { coalesceKey: key(l2) }); t.d.retract(l1.message_id);
    await waitFor(() => hits.length >= 2, 3000);
    check('recalled LEADER: the remaining message goes out alone and unchanged', hits.length === 2 && JSON.stringify(hits[1].body) === JSON.stringify(l2));
    t.d.stop(); }

  // ---------- retry / backoff / Retry-After ----------
  { reset(); status = 429; extraHeaders = { 'Retry-After': '2' }; const t = mk({ base: 50 }); const p = pl('r'); t.d.submit(p, null, false);
    await waitFor(() => hits.length >= 1, 2000); setTimeout(() => { status = 200; }, 2500);
    await waitFor(() => hits.some((h) => h.st === 200), 6000);
    const gap = hits[1] && hits[1].t - hits[0].t;
    check('429 + Retry-After: 2 -> next attempt waits >= 2s (base backoff is 50ms)', gap >= 1950 && t.logs.some((l) => /retryable status=429 .*retry_after=2s/.test(l)), { gap });
    t.d.stop(); }
  { reset(); status = 503; extraHeaders = { 'Retry-After': new Date(Date.now() + 3000).toUTCString() }; const t = mk({ base: 50 }); t.d.submit(pl('d'), null, false);
    await waitFor(() => hits.length >= 2, 7000);
    check('Retry-After as HTTP-date honoured', hits[1] && hits[1].t - hits[0].t >= 1500, hits[1] && hits[1].t - hits[0].t); t.d.stop(); }
  { reset(); status = 503; const t = mk({ base: 40, maxBackoff: 320, random: () => 0.5 }); t.d.submit(pl('b'), null, false);
    await waitFor(() => hits.length >= 6, 5000); t.d.stop();
    const gaps = hits.slice(1, 6).map((h, i) => h.t - hits[i].t);
    check('exponential backoff 40,80,160,320,320 (cap) with random=0.5 (jitter factor 1.0)', gaps.every((g, i) => g >= [40, 80, 160, 320, 320][i] - 15 && g <= [40, 80, 160, 320, 320][i] + 120), gaps); }
  { reset(); status = 503; const draws = [0, 0.999]; let k = 0; const t = mk({ base: 200, maxBackoff: 200, random: () => draws[k++ % 2] }); t.d.submit(pl('j'), null, false);
    await waitFor(() => hits.length >= 3, 3000); t.d.stop();
    const g1 = hits[1].t - hits[0].t, g2 = hits[2].t - hits[1].t;
    check('jitter range x0.8..x1.2 (random 0 -> 160ms, ~1 -> 240ms)', g1 >= 150 && g1 < 215 && g2 >= 230 && g2 < 320, { g1, g2 }); }
  { reset(); status = 500; const t = mk({ base: 10, maxAttempts: 3 }); t.d.submit(pl('g'), null, false);
    await waitFor(() => t.logs.some((l) => /GAVE UP/.test(l)), 3000);
    check('max attempts -> GAVE UP -> dead/, counters.failed=1 retried=2', fs.readdirSync(path.join(t.dir, 'dead')).length === 1 && t.d.stats().counters.failed === 1 && t.d.stats().counters.retried === 2, t.d.stats().counters); t.d.stop(); }

  // ---------- dedupe ----------
  { reset(); const dir = path.join(W, 'dedupe'); const t = mk({ dir }); const p = pl('once'); const a = pl('ma'), b = pl('mb');
    t.d.submit(p, null, false); t.d.submit(a, null, false, { coalesceKey: key(a) }); t.d.submit(b, null, false, { coalesceKey: key(b) });
    await waitFor(() => hits.length >= 2, 3000); await sleep(200); t.d.stop();
    const t2 = mk({ dir });
    const r = [t2.d.submit({ ...p }, null, false), t2.d.submit({ ...a }, null, false, { coalesceKey: key(a) }), t2.d.submit({ ...b }, null, false)];
    await sleep(800);
    check('after restart: already-delivered ids (single + both merged ones) -> sent-dup, never pushed twice', r.join() === 'sent-dup,sent-dup,sent-dup' && hits.length === 2 && t2.logs.filter((l) => /webhook dedupe skip/.test(l)).length === 3, { r, n: hits.length });
    { const f = path.join(dir, 'sent-ids.txt'); const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      check('sent-ids.txt persisted 0600 (3 ids)', (fs.statSync(f).mode & 0o777) === 0o600 && lines.length === 3, { mode: (fs.statSync(f).mode & 0o777).toString(8), n: lines.length }); }
    t2.d.stop(); }
  { const dir = path.join(W, 'compact'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'sent-ids.txt'), Array.from({ length: 30 }, () => uuid()).join('\n') + '\n');
    const d = createDelivery({ url: hook.url, log: () => {}, headers: () => ({}), queue: { enabled: true, dir, sentKeep: 10 } }); d.stop();
    check('sent-ids compaction keeps the last sentKeep ids', fs.readFileSync(path.join(dir, 'sent-ids.txt'), 'utf8').split('\n').filter(Boolean).length === 10); }

  // ---------- size cap for merged payloads ----------
  { reset(); const fin = createFinalizer({ log: () => {}, maxBytes: 6000, itemMaxChars: 500 }); const t = mk({ finalize: fin });
    const ps = [pl('长'.repeat(1500)), pl('x'.repeat(3000)), pl('最新消息 latest')]; ps[2].context = Array.from({ length: 10 }, (_, i) => ({ text: 'ctx'.repeat(100), message_id: uuid(), i }));
    for (const p of ps) t.d.submit(p, null, false, { coalesceKey: key(p) });
    await waitFor(() => hits.length >= 1, 3000);
    const b = hits[0].body; const sz = Buffer.byteLength(JSON.stringify(b));
    check('merged payload <= 6000 bytes, latest top-level text intact, long items cut with text_truncated', sz <= 6000 && b.text === '最新消息 latest' && b.merged_messages[0].text_truncated && b.merged_messages[1].text_truncated && b.merged_messages[2].text === '最新消息 latest', { sz, t: b.text });
    check('context stays LAST and is what gets dropped first', Object.keys(b).pop() === 'context' || !('context' in b)); t.d.stop(); }
  await hook.close();

  // ---------- gateway.js end to end: filter + coalesce + recall ----------
  const ks = fakeKeystore(); const GU = uuid(), GC = uuid(), GG = uuid();
  { const dir = path.join(W, 'e2e'); fs.mkdirSync(path.join(dir, 'run'), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(dir, 'allow.json'), JSON.stringify([GU]));
    const hooks = []; const wh = await httpServer((r) => { if (r.method === 'POST') { hooks.push({ t: Date.now(), body: JSON.parse(r.body) }); return { status: 200, body: '' }; } });
    const api = await fakeMixinApi({}); const bz = await fakeBlaze();
    const now = Date.now(); const M = (category, data, extra = {}) => blazeMsg({ category, data, user_id: GU, conversation_id: GC, created_at: new Date(now).toISOString(), ...extra });
    const t1 = M('PLAIN_TEXT', 'first part'), t2 = M('PLAIN_TEXT', 'second part'), st = M('PLAIN_STICKER', { sticker_id: uuid() });
    const pin = M('MESSAGE_PIN', { action: 'PIN', message_ids: [t1.message_id] }), react = M('MESSAGE_REACTION', { emoji: 'x' }), sys = M('SYSTEM_CONVERSATION', { action: 'ADD', participant_id: uuid(), user_id: GU });
    const other = M('PLAIN_TEXT', 'other conv', { conversation_id: GG });
    const doomed = M('PLAIN_TEXT', 'will be recalled', { conversation_id: GG }); const rec = M('MESSAGE_RECALL', { message_id: doomed.message_id }, { conversation_id: GG });
    bz.add([t1, t2, st, pin, react, sys]);
    const env = { MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_WEBHOOK_URL: wh.url + '/hook', MIXIN_WEBHOOK_KEY: 'k', MIXIN_ALLOWLIST_FILE: path.join(dir, 'allow.json'), MIXIN_SEEN_FILE: path.join(dir, 'seen.json'),
      MIXIN_GATEWAY_LOG: path.join(dir, 'gateway.log'), MIXIN_QUEUE_DIR: path.join(dir, 'queue'), MIXIN_SEND_SOCKET: path.join(dir, 'run', 'send.sock'), MIXIN_API_BASE: api.url, MIXIN_BLAZE_URL: bz.url,
      MIXIN_CONV_CACHE_FILE: path.join(dir, 'cc.json'), MIXIN_MEMBER_ALERT_STATE_FILE: path.join(dir, 'ma.json'), MIXIN_MEMBER_ALERT: '0', MIXIN_PAYLOAD_V2: '1', MIXIN_FORWARD_RECALL: '1', MIXIN_WEBHOOK_CONTEXT: '1', MIXIN_CONTEXT_DIR: path.join(dir, 'ctx'),
      MIXIN_WEBHOOK_COALESCE_IDLE_MS: '1500', MIXIN_WEBHOOK_COALESCE_MS: '4000', HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' };
    const p = runNode(['gateway.js'], { env, cwd: HERE, timeoutMs: 60000 });
    const lg = () => { try { return fs.readFileSync(env.MIXIN_GATEWAY_LOG, 'utf8'); } catch (_) { return ''; } };
    await waitFor(() => /blaze connected/.test(lg()), 10000); await sleep(300);
    bz.add([other, doomed]); bz.pushAll(); await sleep(300); bz.add([rec]); bz.pushAll();
    await waitFor(() => hooks.length >= 2, 15000); await sleep(2500);
    const merged = hooks.find((h) => h.body.conversation_id === GC); const o = hooks.find((h) => h.body.conversation_id === GG);
    check('e2e: text + text + sticker from one sender -> ONE webhook, merged_count 3, latest (sticker) on top', merged && merged.body.merged_count === 3 && merged.body.message_id === st.message_id && merged.body.merged_messages.map((m) => m.message_id).join() === [t1, t2, st].map((m) => m.message_id).join(), merged && merged.body);
    check('e2e: earlier texts also reach a zero-change consumer via the latest message\'s context', merged && Array.isArray(merged.body.context) && ['first part', 'second part'].every((x) => merged.body.context.some((c) => c.text === x)));
    check('e2e: MESSAGE_PIN, MESSAGE_REACTION, MESSAGE_RECALL filtered (logged), SYSTEM_* not forwarded; sticker kept', /webhook filtered msg=\S+ cat=MESSAGE_PIN reason=category/.test(lg()) && /webhook filtered msg=\S+ cat=MESSAGE_REACTION/.test(lg()) && /webhook filtered msg=\S+ cat=MESSAGE_RECALL/.test(lg()) && !hooks.some((h) => /^(MESSAGE_|SYSTEM_)/.test(h.body.category)));
    check('e2e: message recalled while held in the window -> never pushed; the other message of that conv goes out alone', o && o.body.message_id === other.message_id && !('merged_count' in o.body) && !hooks.some((h) => JSON.stringify(h.body).includes(doomed.message_id)), hooks.map((h) => h.body.message_id));
    check('e2e: exactly 2 webhooks for 9 inbound messages', hooks.length === 2, hooks.length);
    check('e2e: startup line documents filter + coalesce config', /gateway webhook_filter=MESSAGE_RECALL,MESSAGE_PIN,\*REACTION\* coalesce_ms=4000 coalesce_idle_ms=1500 coalesce_max=20/.test(lg()));
    check('e2e: all inbound still ACKed', [t1, t2, st, pin, react, sys, other, doomed, rec].every((m) => bz.st.acked.has(m.message_id)));
    // redelivery of an already pushed message (e.g. lost ACK + restart) -> not pushed again
    p.child.kill('SIGTERM'); await p.done; fs.rmSync(env.MIXIN_SEEN_FILE, { force: true }); // even without the inbound dedupe list
    bz.add([{ ...t2 }]); const p2 = runNode(['gateway.js'], { env, cwd: HERE, timeoutMs: 60000 });
    await waitFor(() => bz.st.pending.size === 0, 10000); await sleep(2500);
    check('e2e: restart + redelivered merged message (seen.json gone) -> webhook dedupe skip, no second push', hooks.length === 2 && /webhook dedupe skip msg=/.test(lg()), hooks.length);
    p2.child.kill('SIGTERM'); await p2.done; await bz.close(); await wh.close(); await api.close(); }
  fs.rmSync(W, { recursive: true, force: true });
  finish('webhook-usage');
})().catch((e) => { console.error('FAIL crash', e); process.exit(1); });
