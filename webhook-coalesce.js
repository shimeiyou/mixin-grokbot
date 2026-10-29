'use strict';

const cpsLen = (s) => Array.from(String(s || '')).length;
const cut = (s, n) => Array.from(String(s)).slice(0, n).join('');
const ITEM_DROP = [
  'conversation_id', 'context', 'context_truncated', 'context_dropped',
  'sender_name', 'sender_identity_number', 'transcript', 'gateway_status',
  'merged_messages', 'merged_count',
];

function itemOf(p) {
  const o = {};
  for (const [k, v] of Object.entries(p)) {
    if (!ITEM_DROP.includes(k) && v !== undefined) o[k] = v;
  }
  if (o.attachment && typeof o.attachment === 'object') {
    const { thumbnail, ...a } = o.attachment;
    o.attachment = a;
  }
  return o;
}

function buildMerged(payloads, maxBytes) {
  const latest = payloads[payloads.length - 1];
  const items = payloads.map(itemOf);
  const merged = { ...latest, merged_count: payloads.length, merged_messages: items };
  if (maxBytes > 0) {
    const size = () => Buffer.byteLength(JSON.stringify({ ...merged, context: undefined }), 'utf8');
    for (let i = 0; i < 60 && size() > maxBytes - 200; i++) {
      let best = null;
      for (const it of items) {
        const l = Math.max(cpsLen(it.text), cpsLen(it.display_text));
        if (l > 100 && (!best || l > best.l)) best = { it, l };
      }
      if (!best) {
        for (const it of items) {
          if (it.quote) {
            delete it.quote;
            best = true;
            break;
          }
        }
        if (!best) break;
        continue;
      }
      const n = Math.max(100, Math.floor(best.l / 2));
      for (const k of ['text', 'display_text']) {
        if (typeof best.it[k] === 'string' && cpsLen(best.it[k]) > n) {
          best.it[k] = cut(best.it[k], n);
        }
      }
      best.it.text_truncated = true;
    }
  }
  return merged;
}

async function runEnrichWithTimeout(enrich, enrichTimeoutMs, payload, priv, log) {
  if (!enrich) return;
  let t;
  try {
    await Promise.race([
      enrich(payload, priv || {}),
      new Promise((_, r) => {
        t = setTimeout(() => r(new Error(`enrich timeout ${enrichTimeoutMs}ms`)), enrichTimeoutMs);
      }),
    ]);
  } catch (e) {
    log(`WARN enrich failed msg=${payload.message_id} err=${e.message}`);
  } finally {
    clearTimeout(t);
  }
}

function retryAfterMs(res, maxMs) {
  let v = null;
  try {
    v = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  } catch (_) {}
  if (v == null || v === '') return null;
  const ms = /^\s*\d+\s*$/.test(v) ? parseInt(v, 10) * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(0, ms), maxMs) : null;
}

function createGroupFlusher({ open, recs, runEnrich, fin, maxBytes, persist, unlinkRec, log }) {
  return async function flushGroup(e) {
    const r = e.rec;
    const g = r.group;
    const o = open.get(g.key);
    if (o && o.leader === r.id) open.delete(g.key);
    const members = g.members.map((id) => (id === r.id ? e : recs.get(id))).filter(Boolean);
    for (const m of members) {
      if (m !== e) m.busy = true;
    }
    try {
      for (const m of members) {
        if (m.rec.retracted) continue;
        if (!m.rec.enriched) {
          if (m.rec.needs_enrich) await runEnrich(m.rec.payload, m.rec.priv);
          m.rec.enriched = true;
          m.rec.priv = null;
        }
      }
      const live = members.filter((m) => !m.rec.retracted);
      const ids = live.map((m) => m.rec.id);
      if (!live.length) {
        log(`webhook skipped msg=${r.id} (recalled before delivery) group=${r.id} n=${members.length}`);
        members.forEach((m) => unlinkRec(m.rec.id));
        return 'gone';
      }
      const payload = live.length === 1 ? live[0].rec.payload : buildMerged(live.map((m) => m.rec.payload), maxBytes);
      r.payload = fin(payload);
      r.capped = true;
      r.enriched = true;
      r.priv = null;
      r.needs_enrich = false;
      r.merged_ids = ids;
      r.group = { ...g, flushed: true, members: ids };
      r.retracted = false;
      if (live.length > 1) log(`webhook coalesced group=${r.id} msg=${payload.message_id} merged=${live.length}`);
      persist(e);
      for (const m of members) {
        if (m !== e) unlinkRec(m.rec.id);
      }
      return 'ok';
    } finally {
      for (const m of members) {
        if (m !== e) m.busy = false;
      }
    }
  };
}

module.exports = { itemOf, buildMerged, runEnrichWithTimeout, retryAfterMs, createGroupFlusher };
