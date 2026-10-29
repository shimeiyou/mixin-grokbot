'use strict';

const { runEnrichWithTimeout, retryAfterMs, createGroupFlusher } = require('./webhook-coalesce');
const { safeId, createQueueStore } = require('./webhook-store');

const FAR = 8.64e15;
const isRetryable = (s) => !(s >= 400 && s < 500 && s !== 408 && s !== 429);

function createDelivery({
  url, headers, log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries = 8,
  enrich = null, enrichTimeoutMs = 90000, fetchImpl = (...a) => fetch(...a),
  queue = {}, finalize = null, coalesce = {}, maxBytes = 6000, random = Math.random,
}) {
  const q = {
    enabled: !!queue.enabled, dir: queue.dir,
    maxItems: queue.maxItems ?? 1000, maxBytes: queue.maxBytes ?? (50 << 20), maxRecordBytes: queue.maxRecordBytes ?? (1 << 20),
    maxAttempts: queue.maxAttempts ?? 50, maxAgeMs: queue.maxAgeMs ?? 7 * 86400e3,
    baseBackoffMs: queue.baseBackoffMs ?? 1000, maxBackoffMs: queue.maxBackoffMs ?? 300000,
    concurrency: queue.concurrency ?? 4, deadMax: queue.deadMax ?? 200, scanMs: queue.scanMs ?? 5000,
    timeoutMs: queue.timeoutMs ?? 15000, maxRetryAfterMs: queue.maxRetryAfterMs ?? 900000, sentKeep: queue.sentKeep ?? 5000,
  };
  const co = { idleMs: Math.max(0, coalesce.idleMs ?? 0), maxMs: Math.max(0, coalesce.maxMs ?? 0), maxItems: Math.max(1, coalesce.maxItems ?? 20) };
  co.on = co.maxMs > 0;
  if (co.on && (!co.idleMs || co.idleMs > co.maxMs)) co.idleMs = co.maxMs;

  const counters = { queued: 0, pushed: 0, merged_webhooks: 0, merged_messages: 0, retried: 0, failed: 0, dedup: 0, retracted: 0 };
  const runEnrich = (payload, priv) => runEnrichWithTimeout(enrich, enrichTimeoutMs, payload, priv, log);
  const fin = (payload) => {
    if (!finalize) return payload;
    try { return finalize(payload) || payload; }
    catch (e) { log(`WARN payload finalize failed msg=${payload && payload.message_id} err=${e.message}`); return payload; }
  };

  async function postWebhook(payload) {
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: headers(), body, signal: AbortSignal.timeout(15000) });
        if (res.ok) { log(`webhook ok msg=${payload.message_id} status=${res.status}`); return; }
        if (!isRetryable(res.status)) { log(`webhook FAILED (non-retryable) msg=${payload.message_id} status=${res.status}`); return; }
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

  const store = createQueueStore(q, log);
  const { recs, sent, persist, addRecord, unlinkRec, toDead, load, loadSent, markSent } = store;
  const open = new Map();
  let active = 0;
  let timer = null;
  let scanTimer = null;
  let stopped = false;

  const backoff = (n) => Math.max(0, Math.round(Math.min(q.maxBackoffMs, q.baseBackoffMs * 2 ** Math.max(0, n - 1)) * (0.8 + 0.4 * random())));
  const flushGroup = createGroupFlusher({ open, recs, runEnrich, fin, maxBytes, persist, unlinkRec, log });

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = null;
    let next = Infinity;
    for (const e of recs.values()) {
      if (!e.busy) next = Math.min(next, e.rec.next_at);
    }
    if (next !== Infinity) {
      timer = setTimeout(pump, Math.max(0, Math.min(next - Date.now(), 2 ** 31 - 1)));
    }
  }

  function pump() {
    if (stopped) return;
    const now = Date.now();
    const due = [...recs.values()]
      .filter((e) => !e.busy && e.rec.next_at <= now)
      .sort((a, b) => a.rec.next_at - b.rec.next_at || a.rec.enqueued_at - b.rec.enqueued_at);
    for (const e of due) {
      if (active >= q.concurrency) break;
      e.busy = true;
      active++;
      attempt(e)
        .catch((err) => log(`WARN queue attempt crashed msg=${e.rec.id} err=${err.message}`))
        .finally(() => { e.busy = false; active--; pump(); });
    }
    schedule();
  }

  async function attempt(e) {
    const r = e.rec;
    const id = r.id;
    if (r.group && !r.group.flushed && (await flushGroup(e)) === 'gone') return;
    if (r.retracted) {
      log(`webhook skipped msg=${id} (recalled before delivery)`);
      unlinkRec(id);
      return;
    }
    let dirty = false;
    if (!r.enriched) {
      if (r.needs_enrich) await runEnrich(r.payload, r.priv);
      r.enriched = true;
      r.priv = null;
      if (finalize) r.capped = false;
      dirty = true;
    }
    if (finalize && !r.capped) {
      r.payload = fin(r.payload);
      r.capped = true;
      dirty = true;
    }
    if (dirty) {
      try { persist(e); } catch (err) { log(`WARN queue persist failed msg=${id} err=${err.message}`); }
    }
    r.attempts = (r.attempts || 0) + 1;
    let status = 0;
    let err = null;
    let ra = null;
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: headers(), body: JSON.stringify(r.payload), signal: AbortSignal.timeout(q.timeoutMs) });
      status = res.status;
      const nm = r.merged_ids && r.merged_ids.length > 1 ? r.merged_ids.length : 0;
      if (res.ok) {
        log(`webhook ok msg=${r.merged_ids ? r.payload.message_id : id} status=${status} via=queue attempt=${r.attempts}${nm ? ` merged=${nm} group=${id}` : ''}`);
        markSent(r.merged_ids || [id, r.payload && r.payload.message_id].filter(Boolean));
        counters.pushed++;
        if (nm) {
          counters.merged_webhooks++;
          counters.merged_messages += nm;
        }
        unlinkRec(id);
        return;
      }
      if (!isRetryable(status)) {
        log(`webhook FAILED (non-retryable) msg=${id} status=${status} via=queue`);
        counters.failed++;
        toDead(e, `status ${status}`);
        return;
      }
      ra = retryAfterMs(res, q.maxRetryAfterMs);
      log(`webhook retryable status=${status} msg=${id} attempt=${r.attempts} via=queue${ra != null ? ` retry_after=${Math.round(ra / 1000)}s` : ''}`);
    } catch (ex) {
      err = ex;
      log(`webhook error msg=${id} attempt=${r.attempts} err=${ex.name}: ${ex.message} via=queue`);
    }
    if (r.attempts >= q.maxAttempts || Date.now() - r.enqueued_at > q.maxAgeMs) {
      log(`webhook GAVE UP msg=${id} via=queue attempts=${r.attempts}`);
      counters.failed++;
      toDead(e, err ? err.message : `status ${status}`);
      return;
    }
    counters.retried++;
    r.next_at = Date.now() + Math.max(backoff(r.attempts), ra || 0);
    try { persist(e); } catch (ex) { log(`WARN queue persist failed msg=${id} err=${ex.message}`); }
  }

  function submit(payload, priv, needsEnrich, opts = {}) {
    if (!q.enabled) {
      deliverMemory(payload, priv, needsEnrich).catch((e) => log('webhook unexpected', e.message));
      return 'memory';
    }
    const id = safeId(payload.message_id);
    if (!id) {
      deliverMemory(payload, priv, needsEnrich).catch((e) => log('webhook unexpected', e.message));
      return 'memory';
    }
    if (recs.has(id)) return 'queued-dup';
    if (sent.has(id)) {
      counters.dedup++;
      log(`webhook dedupe skip msg=${id} (already delivered)`);
      return 'sent-dup';
    }
    const key = co.on && opts.coalesceKey ? String(opts.coalesceKey) : null;
    if (finalize && !needsEnrich) payload = fin(payload);
    const now = Date.now();
    const rec = {
      v: 1, id, enqueued_at: now, next_at: now, attempts: 0,
      needs_enrich: !!needsEnrich, enriched: !needsEnrich,
      priv: needsEnrich && priv && Object.keys(priv).length ? priv : null, payload,
      ...(finalize ? { capped: !needsEnrich } : {}),
    };
    let lead = null;
    if (key) {
      const g = open.get(key);
      const le = g && recs.get(g.leader);
      if (le && !le.busy && le.rec.group && !le.rec.group.flushed && g.ids.length < co.maxItems && now - g.first_at < co.maxMs) {
        lead = { g, le };
        rec.held_by = g.leader;
        rec.next_at = FAR;
      } else {
        rec.group = { key, first_at: now, members: [id] };
        rec.next_at = Math.min(now + co.idleMs, now + co.maxMs);
      }
    }
    const data = JSON.stringify(rec);
    const bytes = Buffer.byteLength(data);
    if (recs.size >= q.maxItems || store.getBytes() + bytes > q.maxBytes || bytes > q.maxRecordBytes) {
      log(`WARN queue full/oversize (items=${recs.size} bytes=${store.getBytes()} rec=${bytes}) msg=${id} -> in-memory delivery`);
      deliverMemory(payload, priv, needsEnrich).catch((e) => log('webhook unexpected', e.message));
      return 'memory';
    }
    try {
      addRecord(id, rec, data, bytes);
    } catch (e) {
      log(`WARN queue write failed msg=${id} err=${e.message} -> in-memory delivery`);
      deliverMemory(payload, priv, needsEnrich).catch((err) => log('webhook unexpected', err.message));
      return 'memory';
    }
    counters.queued++;
    if (lead) {
      const { g, le } = lead;
      g.ids.push(id);
      le.rec.group.members = g.ids.slice();
      le.rec.next_at = g.ids.length >= co.maxItems ? now : Math.min(g.first_at + co.maxMs, now + co.idleMs);
      try { persist(le); } catch (e) { log(`WARN queue persist failed msg=${le.rec.id} err=${e.message}`); }
      log(`webhook coalesce hold msg=${id} group=${g.leader} n=${g.ids.length}`);
    } else if (key) {
      open.set(key, { leader: id, first_at: now, ids: [id] });
    }
    setImmediate(pump);
    return 'queued';
  }

  function retract(messageId) {
    const id = safeId(messageId);
    const e = id && recs.get(id);
    if (!e || e.busy || (e.rec.group && e.rec.group.flushed) || e.rec.attempts) return false;
    e.rec.retracted = true;
    counters.retracted++;
    try { persist(e); } catch (_) {}
    if (!e.rec.held_by && !e.rec.group) {
      log(`webhook skipped msg=${id} (recalled before delivery)`);
      unlinkRec(id);
    } else {
      log(`webhook retract msg=${id} (recalled while held)`);
    }
    return true;
  }

  if (q.enabled) {
    try { load(); loadSent(); }
    catch (e) {
      log(`WARN queue disabled: cannot use dir ${q.dir} err=${e.message} -> in-memory delivery`);
      q.enabled = false;
    }
  }
  if (q.enabled) {
    scanTimer = setInterval(pump, q.scanMs);
    if (scanTimer.unref) scanTimer.unref();
    setImmediate(pump);
  }
  return {
    submit, postWebhook, retract,
    stats: () => ({ enabled: q.enabled, pending: recs.size, bytes: store.getBytes(), active, counters: { ...counters } }),
    coalescing: () => ({ ...co, on: co.on && q.enabled }),
    stop: () => { stopped = true; clearTimeout(timer); clearInterval(scanTimer); },
    _pump: pump,
  };
}

module.exports = { createDelivery };
