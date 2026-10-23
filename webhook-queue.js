'use strict';
// Webhook delivery.
//  - queue OFF (MIXIN_WEBHOOK_QUEUE=0): identical to the old in-memory postWebhook() retry loop.
//  - queue ON (gateway default since 2026-10-18; unusable dir at start-up -> OFF with a WARN): every payload is written to disk BEFORE the Blaze ACK (one JSON file per
//    message, 0600, in a 0700 dir; tmp + fsync + rename), so retries survive a crash/restart/reboot. Exponential
//    backoff with jitter, caps on item count / total bytes / record size, max attempts / max age -> dead/ (capped).
//    If the queue is full or a record is too large, that payload falls back to in-memory delivery (never dropped).
// 2026-10-19 (AI-usage batch, all additive; see README "Webhook usage reduction"):
//  - Coalescing (queue ON only): submit(..., { coalesceKey }) holds normal messages per key (conversation+sender).
//    The FIRST message of a group is the leader; it is delivered after `idleMs` without a new message, but never later
//    than `maxMs` after the first one (no endless extension); `maxItems` flushes at once. Followers are persisted
//    (held_by) so nothing is lost on a crash; at flush the leader's record is rewritten with ONE merged payload =
//    the LATEST message's payload exactly as today + merged_messages:[…oldest first, incl. the latest] + merged_count,
//    then the followers are deleted. A group that ends up with one message is sent unchanged (no merged_* fields).
//  - retract(id): a recall of a message that is still held removes it from its group (or drops the single record).
//  - Sent-id dedupe: every delivered message_id (incl. merged ones) is appended to <dir>/sent-ids.txt (fsync, last
//    `sentKeep` ids); submit() of an id that was already delivered is skipped -> never pushed twice, survives restarts.
//  - Retry: exponential backoff base*2^n capped at maxBackoffMs (300s) with +/-20% jitter; Retry-After (seconds or
//    HTTP date) on 429/503/any retryable status is honoured (capped at maxRetryAfterMs, 15 min); maxAttempts / maxAgeMs.
//  - counters: stats().counters {queued, pushed, merged_webhooks, merged_messages, retried, failed, dedup, retracted}.
const fs = require('fs');
const path = require('path');
const FAR = 8.64e15; // "never" for held followers (JSON-safe)
const RETRACTED = Symbol('retracted');

const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const isRetryable = (s) => !(s >= 400 && s < 500 && s !== 408 && s !== 429);

function createDelivery({ url, headers, log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries = 8,
  enrich = null, enrichTimeoutMs = 90000, fetchImpl = (...a) => fetch(...a), queue = {}, finalize = null, coalesce = {}, maxBytes = 6000, random = Math.random }) {
  const q = {
    enabled: !!queue.enabled, dir: queue.dir, maxItems: queue.maxItems ?? 1000, maxBytes: queue.maxBytes ?? 50 << 20,
    maxRecordBytes: queue.maxRecordBytes ?? 1 << 20, maxAttempts: queue.maxAttempts ?? 50, maxAgeMs: queue.maxAgeMs ?? 7 * 86400e3,
    baseBackoffMs: queue.baseBackoffMs ?? 1000, maxBackoffMs: queue.maxBackoffMs ?? 300000, concurrency: queue.concurrency ?? 4,
    deadMax: queue.deadMax ?? 200, scanMs: queue.scanMs ?? 5000, timeoutMs: queue.timeoutMs ?? 15000,
    maxRetryAfterMs: queue.maxRetryAfterMs ?? 900000, sentKeep: queue.sentKeep ?? 5000,
  };
  const co = { idleMs: Math.max(0, coalesce.idleMs ?? 0), maxMs: Math.max(0, coalesce.maxMs ?? 0), maxItems: Math.max(1, coalesce.maxItems ?? 20) };
  co.on = co.maxMs > 0;
  if (co.on && (!co.idleMs || co.idleMs > co.maxMs)) co.idleMs = co.maxMs;
  const counters = { queued: 0, pushed: 0, merged_webhooks: 0, merged_messages: 0, retried: 0, failed: 0, dedup: 0, retracted: 0 };
  const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, r) => { t = setTimeout(() => r(new Error(`enrich timeout ${ms}ms`)), ms); })]).finally(() => clearTimeout(t)); };
  async function runEnrich(payload, priv) {
    if (!enrich) return;
    try { await withTimeout(enrich(payload, priv || {}), enrichTimeoutMs); }
    catch (e) { log(`WARN enrich failed msg=${payload.message_id} err=${e.message}`); }
  }

  // Optional final shaping (payload-cap.js: key order, context/byte caps). Runs after enrichment, before the payload
  // is queued/sent. Without `finalize` (unit tests, old callers) payloads are untouched. Never throws.
  const fin = (payload) => {
    if (!finalize) return payload;
    try { return finalize(payload) || payload; } catch (e) { log(`WARN payload finalize failed msg=${payload && payload.message_id} err=${e.message}`); return payload; }
  };

  // ---------- legacy in-memory path (unchanged behaviour and log lines) ----------
  async function postWebhook(payload) {
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: headers(), body, signal: AbortSignal.timeout(15000) });
        if (res.ok) { log(`webhook ok msg=${payload.message_id} status=${res.status}`); return; }
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          log(`webhook FAILED (non-retryable) msg=${payload.message_id} status=${res.status}`); return;
        }
        log(`webhook retryable status=${res.status} msg=${payload.message_id} attempt=${attempt}`);
      } catch (e) {
        log(`webhook error msg=${payload.message_id} attempt=${attempt} err=${e.name}: ${e.message}`);
      }
      await sleep(Math.min(60000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500));
    }
    log(`webhook GAVE UP msg=${payload.message_id}`);
  }
  async function deliverMemory(payload, priv, needsEnrich) {
    if (needsEnrich) await runEnrich(payload, priv);
    return postWebhook(fin(payload));
  }

  // ---------- persistent queue ----------
  const recs = new Map(); // id -> { rec, bytes, busy }
  let totalBytes = 0, active = 0, timer = null, scanTimer = null, stopped = false;
  const fileOf = (id) => path.join(q.dir, `${id}.json`);
  const deadDir = () => path.join(q.dir, 'dead');
  function fsyncDir(d) { try { const fd = fs.openSync(d, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch (_) {} }
  function writeAtomic(file, data) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    fsyncDir(path.dirname(file));
  }
  function persist(e) {
    const data = JSON.stringify(e.rec);
    writeAtomic(fileOf(e.rec.id), data);
    totalBytes += Buffer.byteLength(data) - e.bytes; e.bytes = Buffer.byteLength(data);
  }
  function unlinkRec(id) {
    const e = recs.get(id); if (!e) return;
    recs.delete(id); totalBytes -= e.bytes;
    try { fs.unlinkSync(fileOf(id)); } catch (_) {}
    fsyncDir(q.dir);
  }
  function toDead(e, why) {
    const id = e.rec.id;
    try {
      fs.mkdirSync(deadDir(), { recursive: true, mode: 0o700 });
      e.rec.dead_reason = why; e.rec.dead_at = new Date().toISOString(); e.rec.priv = null;
      writeAtomic(path.join(deadDir(), `${id}.json`), JSON.stringify(e.rec));
      pruneDead();
    } catch (err) { log(`WARN queue dead-letter write failed msg=${id} err=${err.message}`); }
    unlinkRec(id);
  }
  function pruneDead() { // dead/ only ever holds files this module wrote
    try {
      const d = deadDir();
      const fsd = fs.readdirSync(d).filter((f) => /^[A-Za-z0-9_.-]+\.json$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => a.t - b.t);
      while (fsd.length > q.deadMax) fs.unlinkSync(path.join(d, fsd.shift().f));
    } catch (_) {}
  }
  const backoff = (n) => { const d = Math.min(q.maxBackoffMs, q.baseBackoffMs * 2 ** Math.max(0, n - 1)); return Math.max(0, Math.round(d * (0.8 + 0.4 * random()))); };
  function retryAfterMs(res) { // RFC 9110: delay-seconds or HTTP-date
    let v = null; try { v = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null; } catch (_) {}
    if (v == null || v === '') return null;
    let ms = /^\s*\d+\s*$/.test(v) ? parseInt(v, 10) * 1000 : Date.parse(v) - Date.now();
    if (!Number.isFinite(ms)) return null;
    return Math.min(Math.max(0, ms), q.maxRetryAfterMs);
  }

  // ---------- sent-id dedupe (persisted) ----------
  const sent = new Set(); let sentLines = 0;
  const sentFile = () => path.join(q.dir, 'sent-ids.txt');
  function loadSent() {
    let lines = [];
    try { lines = fs.readFileSync(sentFile(), 'utf8').split('\n').filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x)); } catch (_) {}
    for (const x of lines.slice(-q.sentKeep)) sent.add(x);
    sentLines = lines.length;
    if (sentLines > 2 * q.sentKeep) compactSent();
  }
  function compactSent() {
    const keep = [...sent].slice(-q.sentKeep); sent.clear(); keep.forEach((x) => sent.add(x));
    try { writeAtomic(sentFile(), keep.join('\n') + (keep.length ? '\n' : '')); sentLines = keep.length; } catch (e) { log(`WARN sent-ids compact failed err=${e.message}`); }
  }
  function markSent(ids) {
    const fresh = [...new Set(ids.map(safeId))].filter((x) => x && !sent.has(x)); if (!fresh.length) return;
    fresh.forEach((x) => sent.add(x));
    try { const fd = fs.openSync(sentFile(), 'a', 0o600); try { fs.writeSync(fd, fresh.join('\n') + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } sentLines += fresh.length; }
    catch (e) { log(`WARN sent-ids append failed err=${e.message}`); }
    if (sentLines > 2 * q.sentKeep) compactSent();
  }

  // ---------- coalescing groups (in memory; the records themselves are on disk) ----------
  const open = new Map(); // coalesceKey -> { leader, first_at, ids }
  const ITEM_DROP = ['conversation_id', 'context', 'context_truncated', 'context_dropped', 'sender_name', 'sender_identity_number', 'transcript', 'gateway_status', 'merged_messages', 'merged_count'];
  function itemOf(p) {
    const o = {};
    for (const [k, v] of Object.entries(p)) if (!ITEM_DROP.includes(k) && v !== undefined) o[k] = v;
    if (o.attachment && typeof o.attachment === 'object') { const { thumbnail, ...a } = o.attachment; o.attachment = a; }
    return o;
  }
  const cpsLen = (s) => Array.from(String(s || '')).length;
  const cut = (s, n) => Array.from(String(s)).slice(0, n).join('');
  function buildMerged(payloads) {
    const latest = payloads[payloads.length - 1];
    const items = payloads.map(itemOf);
    const merged = { ...latest, merged_count: payloads.length, merged_messages: items };
    // keep the body under maxBytes BEFORE payload-cap runs (it would otherwise cut the latest text): trim the longest
    // merged item texts first (text_truncated:true); context is handled by payload-cap afterwards.
    if (maxBytes > 0) {
      const size = () => Buffer.byteLength(JSON.stringify({ ...merged, context: undefined }), 'utf8');
      for (let i = 0; i < 60 && size() > maxBytes - 200; i++) {
        let best = null;
        for (const it of items) { const l = Math.max(cpsLen(it.text), cpsLen(it.display_text)); if (l > 100 && (!best || l > best.l)) best = { it, l }; }
        if (!best) { for (const it of items) { if (it.quote) { delete it.quote; best = true; break; } } if (!best) break; continue; }
        const n = Math.max(100, Math.floor(best.l / 2));
        for (const k of ['text', 'display_text']) if (typeof best.it[k] === 'string' && cpsLen(best.it[k]) > n) best.it[k] = cut(best.it[k], n);
        best.it.text_truncated = true;
      }
    }
    return merged;
  }
  async function flushGroup(e) {
    const r = e.rec, g = r.group;
    const o = open.get(g.key); if (o && o.leader === r.id) open.delete(g.key); // closed: new messages start a new group
    const members = g.members.map((id) => (id === r.id ? e : recs.get(id))).filter(Boolean);
    for (const m of members) if (m !== e) m.busy = true;
    try {
      for (const m of members) {
        if (m.rec.retracted) continue;
        if (!m.rec.enriched) { if (m.rec.needs_enrich) await runEnrich(m.rec.payload, m.rec.priv); m.rec.enriched = true; m.rec.priv = null; }
      }
      const live = members.filter((m) => !m.rec.retracted);
      const ids = live.map((m) => m.rec.id);
      if (!live.length) { log(`webhook skipped msg=${r.id} (recalled before delivery) group=${r.id} n=${members.length}`); members.forEach((m) => unlinkRec(m.rec.id)); return 'gone'; }
      const payload = live.length === 1 ? live[0].rec.payload : buildMerged(live.map((m) => m.rec.payload));
      r.payload = fin(payload); r.capped = true; r.enriched = true; r.priv = null; r.needs_enrich = false;
      r.merged_ids = ids; r.group = { ...g, flushed: true, members: ids }; r.retracted = false; // the leader file now carries the group
      if (live.length > 1) log(`webhook coalesced group=${r.id} msg=${payload.message_id} merged=${live.length}`);
      persist(e); // leader now holds the final (merged) payload ...
      for (const m of members) if (m !== e) unlinkRec(m.rec.id); // ... so the followers can go
      return 'ok';
    } finally { for (const m of members) if (m !== e) m.busy = false; }
  }

  function load() {
    fs.mkdirSync(q.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(q.dir, 0o700); } catch (_) {}
    let n = 0;
    for (const f of fs.readdirSync(q.dir)) {
      const p = path.join(q.dir, f);
      if (/^\..+\.\d+\.tmp$/.test(f)) { try { fs.unlinkSync(p); } catch (_) {} continue; } // our own interrupted writes
      if (!/^[A-Za-z0-9_-]+\.json$/.test(f)) continue;
      try {
        const raw = fs.readFileSync(p, 'utf8'); const rec = JSON.parse(raw);
        if (!rec || !rec.id || !rec.payload) throw new Error('bad record');
        rec.next_at = Math.min(rec.next_at || 0, Date.now() + q.maxBackoffMs);
        recs.set(rec.id, { rec, bytes: Buffer.byteLength(raw), busy: false }); totalBytes += Buffer.byteLength(raw); n++;
      } catch (e) {
        log(`WARN queue corrupt record ${f} err=${e.message} -> dead/`);
        try { fs.mkdirSync(deadDir(), { recursive: true, mode: 0o700 }); fs.renameSync(p, path.join(deadDir(), f.replace(/\.json$/, '.corrupt.json'))); } catch (_) {}
      }
    }
    // coalescing after a restart: held followers whose leader is gone or already flushed become normal records;
    // unflushed leaders are flushed promptly (no group is re-opened).
    for (const e of recs.values()) {
      const r = e.rec;
      if (r.held_by && !(recs.get(r.held_by) && recs.get(r.held_by).rec.group && !recs.get(r.held_by).rec.group.flushed && recs.get(r.held_by).rec.group.members.includes(r.id))) { delete r.held_by; r.next_at = Date.now(); }
      if (r.group && !r.group.flushed) r.next_at = Math.min(r.next_at, Date.now());
    }
    if (n) log(`queue loaded pending=${n} bytes=${totalBytes}`);
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(timer); timer = null;
    let next = Infinity;
    for (const e of recs.values()) if (!e.busy) next = Math.min(next, e.rec.next_at);
    if (next === Infinity) return;
    timer = setTimeout(pump, Math.max(0, Math.min(next - Date.now(), 2 ** 31 - 1)));
  }
  function pump() {
    if (stopped) return;
    const now = Date.now();
    const due = [...recs.values()].filter((e) => !e.busy && e.rec.next_at <= now).sort((a, b) => a.rec.next_at - b.rec.next_at || a.rec.enqueued_at - b.rec.enqueued_at);
    for (const e of due) { if (active >= q.concurrency) break; e.busy = true; active++; attempt(e).catch((err) => log(`WARN queue attempt crashed msg=${e.rec.id} err=${err.message}`)).finally(() => { e.busy = false; active--; pump(); }); }
    schedule();
  }
  async function attempt(e) {
    const r = e.rec, id = r.id;
    if (r.group && !r.group.flushed) { if (await flushGroup(e) === 'gone') return; }
    if (r.retracted) { log(`webhook skipped msg=${id} (recalled before delivery)`); unlinkRec(id); return; }
    let dirty = false;
    if (!r.enriched) {
      if (r.needs_enrich) await runEnrich(r.payload, r.priv);
      r.enriched = true; r.priv = null; // private key material no longer needed after download
      if (finalize) r.capped = false; // enrichment added fields: shape/cap again
      dirty = true;
    }
    // Store the FINAL capped payload (also upgrades records written before payload-cap existed).
    if (finalize && !r.capped) { r.payload = fin(r.payload); r.capped = true; dirty = true; }
    if (dirty) { try { persist(e); } catch (err) { log(`WARN queue persist failed msg=${id} err=${err.message}`); } }
    r.attempts = (r.attempts || 0) + 1;
    let status = 0, err = null, ra = null;
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: headers(), body: JSON.stringify(r.payload), signal: AbortSignal.timeout(q.timeoutMs) });
      status = res.status;
      const nm = r.merged_ids && r.merged_ids.length > 1 ? r.merged_ids.length : 0;
      if (res.ok) {
        log(`webhook ok msg=${r.merged_ids ? r.payload.message_id : id} status=${status} via=queue attempt=${r.attempts}${nm ? ` merged=${nm} group=${id}` : ''}`);
        markSent(r.merged_ids || [id, r.payload && r.payload.message_id].filter(Boolean)); counters.pushed++; if (nm) { counters.merged_webhooks++; counters.merged_messages += nm; }
        unlinkRec(id); return;
      }
      if (!isRetryable(status)) { log(`webhook FAILED (non-retryable) msg=${id} status=${status} via=queue`); counters.failed++; toDead(e, `status ${status}`); return; }
      ra = retryAfterMs(res);
      log(`webhook retryable status=${status} msg=${id} attempt=${r.attempts} via=queue${ra != null ? ` retry_after=${Math.round(ra / 1000)}s` : ''}`);
    } catch (ex) { err = ex; log(`webhook error msg=${id} attempt=${r.attempts} err=${ex.name}: ${ex.message} via=queue`); }
    if (r.attempts >= q.maxAttempts || Date.now() - r.enqueued_at > q.maxAgeMs) { log(`webhook GAVE UP msg=${id} via=queue attempts=${r.attempts}`); counters.failed++; toDead(e, err ? err.message : `status ${status}`); return; }
    counters.retried++;
    r.next_at = Date.now() + Math.max(backoff(r.attempts), ra || 0);
    try { persist(e); } catch (ex) { log(`WARN queue persist failed msg=${id} err=${ex.message}`); }
  }

  // Synchronous: when it returns 'queued', the record is on disk (so the caller may ACK).
  function submit(payload, priv, needsEnrich, opts = {}) {
    if (!q.enabled) { deliverMemory(payload, priv, needsEnrich).catch((e) => log('webhook unexpected', e.message)); return 'memory'; }
    const id = safeId(payload.message_id);
    if (!id) { deliverMemory(payload, priv, needsEnrich).catch(() => {}); return 'memory'; }
    if (recs.has(id)) return 'queued-dup';
    if (sent.has(id)) { counters.dedup++; log(`webhook dedupe skip msg=${id} (already delivered)`); return 'sent-dup'; }
    const key = co.on && opts.coalesceKey ? String(opts.coalesceKey) : null;
    // No enrichment pending -> the payload is final now: cap it before it is written, so disk holds what is sent.
    // With enrichment pending it is capped (and re-persisted) in the worker right after enrichment, before any POST.
    if (finalize && !needsEnrich) payload = fin(payload);
    const rec = { v: 1, id, enqueued_at: Date.now(), next_at: Date.now(), attempts: 0, needs_enrich: !!needsEnrich, enriched: !needsEnrich, priv: needsEnrich && priv && Object.keys(priv).length ? priv : null, payload };
    if (finalize) rec.capped = !needsEnrich;
    let lead = null; const now = Date.now();
    if (key) {
      const g = open.get(key); const le = g && recs.get(g.leader);
      if (le && !le.busy && le.rec.group && !le.rec.group.flushed && g.ids.length < co.maxItems && now - g.first_at < co.maxMs) {
        lead = { g, le }; rec.held_by = g.leader; rec.next_at = FAR;
      } else {
        rec.group = { key, first_at: now, members: [id] }; rec.next_at = Math.min(now + co.idleMs, now + co.maxMs);
      }
    }
    const data = JSON.stringify(rec), bytes = Buffer.byteLength(data);
    if (recs.size >= q.maxItems || totalBytes + bytes > q.maxBytes || bytes > q.maxRecordBytes) {
      log(`WARN queue full/oversize (items=${recs.size} bytes=${totalBytes} rec=${bytes}) msg=${id} -> in-memory delivery`);
      deliverMemory(payload, priv, needsEnrich).catch((e) => log('webhook unexpected', e.message)); return 'memory';
    }
    try {
      writeAtomic(fileOf(id), data);
    } catch (e) {
      log(`WARN queue write failed msg=${id} err=${e.message} -> in-memory delivery`);
      deliverMemory(payload, priv, needsEnrich).catch(() => {}); return 'memory';
    }
    recs.set(id, { rec, bytes, busy: false }); totalBytes += bytes; counters.queued++;
    if (lead) {
      const { g, le } = lead; g.ids.push(id);
      le.rec.group.members = g.ids.slice();
      le.rec.next_at = g.ids.length >= co.maxItems ? now : Math.min(g.first_at + co.maxMs, now + co.idleMs);
      try { persist(le); } catch (e) { log(`WARN queue persist failed msg=${le.rec.id} err=${e.message}`); }
      log(`webhook coalesce hold msg=${id} group=${g.leader} n=${g.ids.length}`);
    } else if (key) open.set(key, { leader: id, first_at: now, ids: [id] });
    setImmediate(pump);
    return 'queued';
  }
  // A recall for a message that is still waiting (held/scheduled, not in flight) removes it before it is pushed.
  function retract(messageId) {
    const id = safeId(messageId); const e = id && recs.get(id);
    if (!e || e.busy || (e.rec.group && e.rec.group.flushed) || e.rec.attempts) return false;
    e.rec.retracted = true; counters.retracted++;
    try { persist(e); } catch (_) {}
    if (!e.rec.held_by && !e.rec.group) { log(`webhook skipped msg=${id} (recalled before delivery)`); unlinkRec(id); }
    else log(`webhook retract msg=${id} (recalled while held)`);
    return true;
  }

  if (q.enabled) {
    try { load(); loadSent(); }
    catch (e) { // never fail boot over the queue: unusable dir -> in-memory delivery (the pre-queue behaviour)
      log(`WARN queue disabled: cannot use dir ${q.dir} err=${e.message} -> in-memory delivery`);
      q.enabled = false;
    }
  }
  if (q.enabled) {
    scanTimer = setInterval(pump, q.scanMs); if (scanTimer.unref) scanTimer.unref();
    setImmediate(pump);
  }
  return {
    submit, postWebhook, retract,
    stats: () => ({ enabled: q.enabled, pending: recs.size, bytes: totalBytes, active, counters: { ...counters } }),
    coalescing: () => ({ ...co, on: co.on && q.enabled }),
    stop: () => { stopped = true; clearTimeout(timer); clearInterval(scanTimer); },
    _pump: pump,
  };
}
module.exports = { createDelivery };
