'use strict';

const ORDER = [
  'conversation_id', 'user_id', 'message_id', 'category', 'text', 'created_at', 'encrypted', 'original_category',
  'display_text', 'received_at', 'delay_ms',
  'sender_name', 'sender_identity_number',
  'quote_message_id', 'quote',
  'attachment', 'sticker', 'contact', 'location', 'live', 'app_card', 'buttons',
  'pin', 'system', 'recalled_message_id', 'decrypt_error', 'parse_error',
  'transcript_count', 'transcript',
  'truncated', 'context_truncated', 'context_dropped',
];
const ATTACHMENT_LAST = ['thumbnail'];

const cps = (s) => Array.from(String(s));
function cutChars(s, n) { const a = cps(s); return a.length > n ? a.slice(0, n).join('') : String(s); }
const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');

function orderAttachment(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return a;
  const out = {};
  for (const k of Object.keys(a)) if (!ATTACHMENT_LAST.includes(k)) out[k] = a[k];
  for (const k of ATTACHMENT_LAST) if (k in a) out[k] = a[k];
  return out;
}

function ordered(src, over = {}) {
  const v = { ...src, ...over };
  const out = {};
  for (const k of ORDER) if (k in v && v[k] !== undefined) out[k] = k === 'attachment' ? orderAttachment(v[k]) : v[k];
  for (const k of Object.keys(v)) if (!(k in out) && k !== 'context' && v[k] !== undefined) out[k] = v[k];
  if ('context' in v) out.context = v.context;
  return out;
}

function cfgFromEnv(env = process.env) {
  const i = (n, d) => { const x = parseInt(env[n] || '', 10); return Number.isFinite(x) ? x : d; };
  return { maxBytes: i('MIXIN_WEBHOOK_MAX_BYTES', 6000), itemMaxChars: i('MIXIN_CONTEXT_ITEM_MAX_CHARS', 500) };
}

function capPayload(input, opts = {}) {
  const maxBytes = opts.maxBytes ?? 6000, itemMaxChars = opts.itemMaxChars ?? 500;
  const before = bytes(input);
  const info = { before, after: before, dropped: 0, itemsCut: 0, textCut: false, over: false };
  const over = {};
  const prevDropped = Number.isFinite(input.context_dropped) ? input.context_dropped : 0;
  let ctx = null;
  if (Array.isArray(input.context)) {
    ctx = input.context.map((m) => {
      if (!m || typeof m !== 'object' || typeof m.text !== 'string' || itemMaxChars <= 0) return m;
      const t = cutChars(m.text, itemMaxChars);
      if (t === m.text) return m;
      info.itemsCut++;
      return { ...m, text: t, text_truncated: true };
    });
  }
  if (input.quote && typeof input.quote === 'object' && typeof input.quote.text === 'string' && itemMaxChars > 0) {
    const t = cutChars(input.quote.text, itemMaxChars);
    if (t !== input.quote.text) { over.quote = { ...input.quote, text: t, text_truncated: true }; info.quoteCut = true; }
  }
  const build = (start) => {
    const o = { ...over };
    if (ctx) {
      o.context = start ? ctx.slice(start) : ctx;
      const dropped = prevDropped + start;
      if (start > 0 || info.itemsCut > 0 || input.context_truncated) o.context_truncated = true;
      if (dropped > 0) o.context_dropped = dropped;
    }
    return ordered(input, o);
  };
  let start = 0, out = build(0);
  if (maxBytes > 0 && ctx) {
    while (bytes(out) > maxBytes && start < ctx.length) out = build(++start); // oldest first
    info.dropped = start;
  }
  if (maxBytes > 0 && bytes(out) > maxBytes) {
    const fields = ['text', 'display_text'].filter((k) => typeof out[k] === 'string');
    const full = Math.max(0, ...fields.map((k) => cps(out[k]).length));
    const withLen = (n) => { const o = { truncated: true }; for (const k of fields) o[k] = cutChars(input[k] ?? out[k], n); return o; };
    const fits = (n) => { Object.assign(over, withLen(n)); const b = build(start); return bytes(b) <= maxBytes ? b : null; };
    if (fields.length && fits(0)) {
      let lo = 0, hi = full; // invariant: lo fits
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
      out = fits(lo); info.textCut = true;
    } else {
      for (const k of [...fields, 'truncated']) delete over[k]; // cutting text cannot get under the cap: leave text as is
      out = build(start); info.over = true;
    }
  }
  info.after = bytes(out);
  return { payload: out, info };
}

function createFinalizer({ log = () => {}, maxBytes, itemMaxChars } = {}) {
  const env = cfgFromEnv();
  const o = { maxBytes: maxBytes ?? env.maxBytes, itemMaxChars: itemMaxChars ?? env.itemMaxChars };
  return (payload) => {
    const { payload: p, info } = capPayload(payload, o);
    if (info.dropped || info.itemsCut || info.textCut || info.over || info.quoteCut) {
      log(`payload capped msg=${p.message_id} bytes=${info.before}->${info.after} max=${o.maxBytes} context_dropped=${info.dropped} items_cut=${info.itemsCut} quote_cut=${+!!info.quoteCut} text_cut=${+info.textCut}${info.over ? ' WARN still over cap' : ''}`);
    }
    return p;
  };
}

module.exports = { capPayload, createFinalizer, ordered, cfgFromEnv, ORDER, bytes };
