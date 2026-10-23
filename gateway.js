'use strict';
const fs = require('fs');
const path = require('path');
require('./ws-shim'); // must precede SDK import
const { MixinApi } = require('@mixin.dev/mixin-node-sdk');
const { createBlazeConn } = require('./blaze-conn');
const { log, loadKeystore, sleep } = require('./common');
const { decryptMessageData, seedFromKeystore } = require('./mixin-crypto');
const { parseMessage, render, baseType } = require('./message-parse');
const { createDelivery } = require('./webhook-queue');
const { createFinalizer } = require('./payload-cap');
const contextStore = require('./context-store');
const CONTEXT_ON = contextStore.enabled(); // MIXIN_WEBHOOK_CONTEXT=1 -> record + add payload.context

// ---- feature flags: all default OFF; with everything off the payload/behaviour is identical to before ----
const flag = (n) => /^(1|true|yes|on)$/i.test(process.env[n] || '');
const int = (n, d) => { const v = parseInt(process.env[n] || '', 10); return Number.isFinite(v) ? v : d; };
const V2 = flag('MIXIN_PAYLOAD_V2');                 // structured optional fields + display_text + delay_ms
const TEXT_V2 = flag('MIXIN_PAYLOAD_TEXT_V2');       // also put the readable text into `text`
const LOOKUP = V2 && flag('MIXIN_PAYLOAD_LOOKUP');   // sender_name, contact names, sticker assets (cached GETs)
const MEDIA = V2 && flag('MIXIN_MEDIA_DOWNLOAD');    // download attachments, add attachment.local_path/local_mime/sha256
const VIEW_URL = V2 && flag('MIXIN_MEDIA_VIEW_URL'); // add attachment.view_url for PLAIN attachments (signed, expires)
const FORWARD_RECALL = flag('MIXIN_FORWARD_RECALL'); // forward MESSAGE_RECALL with recalled_message_id
const FORWARD_SYSTEM = flag('MIXIN_FORWARD_SYSTEM'); // forward SYSTEM_* (conversation changes, snapshots)
// persistent on-disk webhook queue: default ON since 2026-10-18 (MIXIN_WEBHOOK_QUEUE=0/false/no/off turns it off).
// If the queue dir can't be used at start-up, delivery falls back to the in-memory path (webhook-queue.js).
const QUEUE = !/^(0|false|no|off)$/i.test(process.env.MIXIN_WEBHOOK_QUEUE || '');
// Default ON (independent of MIXIN_FORWARD_SYSTEM): member-change check + additive kind:"member_alert" webhook event.
const MEMBER_ALERT = !/^(0|false|no|off)$/i.test(process.env.MIXIN_MEMBER_ALERT || '1');

// Invalid/missing keystore = config error: exit 78 (EX_CONFIG; the unit has RestartPreventExitStatus=78, so systemd
// does not restart-loop and the heartbeat timer alerts service_inactive once). Never logs the keystore.
let keystore;
try { keystore = loadKeystore(); if (!keystore || !keystore.app_id || !keystore.session_id || !keystore.session_private_key) throw new Error('MIXIN_KEYSTORE_JSON lacks app_id/session_id/session_private_key'); }
catch (e) { log(`FATAL keystore invalid: ${e.message} (exit 78)`); process.exit(78); }
const BOT_ID = keystore.app_id;
const SESSION_SEED = seedFromKeystore(keystore);
const WEBHOOK_URL = process.env.MIXIN_WEBHOOK_URL;
const WEBHOOK_KEY = process.env.MIXIN_WEBHOOK_KEY || '';
// Comma-separated header list. "Authorization" gets "Bearer <key>", others get the raw key.
const KEY_HEADERS = (process.env.MIXIN_WEBHOOK_KEY_HEADERS || 'Authorization,X-Webhook-Key')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MAX_RETRIES = parseInt(process.env.MIXIN_WEBHOOK_MAX_RETRIES || '8', 10);
const SEEN_FILE = process.env.MIXIN_SEEN_FILE || path.join(__dirname, 'seen.json');
const SEEN_MAX = 20000;
const ALLOWLIST_FILE = process.env.MIXIN_ALLOWLIST_FILE || path.join(__dirname, 'allowlist.json');
const API_BASE = process.env.MIXIN_API_BASE || ''; // default: SDK default https://api.mixin.one
if (!WEBHOOK_URL) { log('FATAL MIXIN_WEBHOOK_URL not set'); process.exit(1); }

// ---- user allowlist (fail closed; reload on mtime change / each check) ----
let allowSet = new Set();
let allowMtimeMs = null;
let allowWarnedEmpty = false;
function reloadAllowlist() {
  let mtimeMs = -1; // sentinel when missing
  try { mtimeMs = fs.statSync(ALLOWLIST_FILE).mtimeMs; } catch (_) { mtimeMs = -1; }
  if (allowMtimeMs !== null && mtimeMs === allowMtimeMs) return; // unchanged
  allowMtimeMs = mtimeMs;
  let next = new Set();
  try {
    if (mtimeMs === -1) throw new Error('ENOENT');
    const raw = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string' && id) next.add(id);
  } catch (e) {
    if (e.message !== 'ENOENT') log(`WARN allowlist load failed path=${ALLOWLIST_FILE} err=${e.message}`);
  }
  allowSet = next;
  if (allowSet.size === 0) {
    if (!allowWarnedEmpty) { log(`WARN allowlist empty/missing — blocking all users path=${ALLOWLIST_FILE}`); allowWarnedEmpty = true; }
  } else {
    allowWarnedEmpty = false;
    log(`allowlist loaded count=${allowSet.size}`);
  }
}
function isAllowed(userId) {
  reloadAllowlist();
  return !!(userId && allowSet.has(userId));
}
reloadAllowlist();

// ---- dedupe store (JSON, ordered, capped) ----
let seenList = [];
try { seenList = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch (_) {}
const seen = new Set(seenList);
let saveTimer = null;
function markSeen(id) {
  seen.add(id); seenList.push(id);
  if (seenList.length > SEEN_MAX) seenList.splice(0, seenList.length - SEEN_MAX).forEach((x) => seen.delete(x));
  if (!saveTimer) saveTimer = setTimeout(flushSeen, 500);
}
function flushSeen() {
  saveTimer = null;
  try { fs.writeFileSync(SEEN_FILE + '.tmp', JSON.stringify(seenList)); fs.renameSync(SEEN_FILE + '.tmp', SEEN_FILE); }
  catch (e) { log('WARN seen save failed', e.message); }
}

// ---- optional helpers (only constructed when their flag is on) ----
const restApi = (LOOKUP || MEDIA || VIEW_URL) ? MixinApi({ keystore, requestConfig: { timeout: 10000, ...(API_BASE ? { baseURL: API_BASE } : {}) } }) : null;
const lookup = LOOKUP ? require('./lookup').createLookup({ api: restApi, log, file: process.env.MIXIN_LOOKUP_CACHE_FILE || path.join(__dirname, 'lookup-cache.json'), ttlMs: int('MIXIN_LOOKUP_TTL_MS', 24 * 3600e3) }) : null;
const media = (MEDIA || VIEW_URL) ? require('./media').createMedia({
  api: restApi, log, dir: process.env.MIXIN_MEDIA_DIR || path.resolve(__dirname, '..', 'mixin-media'), // default: ../mixin-media next to the gateway dir
  maxBytes: int('MIXIN_MEDIA_MAX_BYTES', 20 << 20), totalMaxBytes: int('MIXIN_MEDIA_TOTAL_MAX_BYTES', 1 << 30),
  ttlMs: int('MIXIN_MEDIA_TTL_MS', 24 * 3600e3), timeoutMs: int('MIXIN_MEDIA_TIMEOUT_MS', 60000),
  ...(process.env.MIXIN_MEDIA_TYPES ? { types: process.env.MIXIN_MEDIA_TYPES } : {}),
}) : null;
if (MEDIA) { media.ensureDir(); media.cleanup(); const t = setInterval(() => media.cleanup(), 3600e3); t.unref(); }

// Quote lookup: small in-memory LRU of recent inbound messages (memory only), then the context store (if on).
const QUOTE_MAX = int('MIXIN_QUOTE_CACHE_MAX', 1000);
const quoteCache = new Map();
function rememberQuote(e) {
  if (!V2 || QUOTE_MAX <= 0) return;
  quoteCache.delete(e.message_id); quoteCache.set(e.message_id, e);
  while (quoteCache.size > QUOTE_MAX) quoteCache.delete(quoteCache.keys().next().value);
}
function findQuote(conv, id) {
  const q = quoteCache.get(id);
  if (q && q.conversation_id === conv) { const { conversation_id, ...rest } = q; return rest; }
  if (CONTEXT_ON) {
    try { const m = contextStore.recent(conv, null).find((x) => x.message_id === id); if (m) return { message_id: m.message_id, user_id: m.user_id, text: m.text, created_at: m.created_at, from_bot: m.from_bot }; } catch (_) {}
  }
  return null;
}

const rerender = (payload) => {
  if (!V2) return;
  payload.display_text = render(baseType(payload.category), payload, payload.text);
  if (TEXT_V2) payload.text = payload.display_text;
};
// Async enrichment, run off the ACK path (in-memory) or inside the queue worker. Never logs content.
async function enrich(payload, priv) {
  if (LOOKUP) {
    const u = await lookup.user(payload.user_id);
    if (u) { if (u.full_name != null) payload.sender_name = u.full_name; if (u.identity_number != null) payload.sender_identity_number = u.identity_number; }
    if (payload.contact && payload.contact.user_id) {
      const c = await lookup.user(payload.contact.user_id);
      if (c) { payload.contact.full_name = c.full_name; payload.contact.identity_number = c.identity_number; rerender(payload); }
    }
    if (payload.sticker && payload.sticker.sticker_id) {
      const s = await lookup.sticker(payload.sticker.sticker_id);
      if (s) { for (const k of ['name', 'album_id', 'asset_url', 'asset_type', 'asset_width', 'asset_height']) if (payload.sticker[k] == null && s[k] != null) payload.sticker[k] = s[k]; rerender(payload); }
    }
  }
  const a = payload.attachment;
  if (a && MEDIA) {
    try {
      const r = await media.download(payload.message_id, a, priv);
      a.local_path = r.local_path; a.local_mime = r.local_mime; a.sha256 = r.sha256;
      if (VIEW_URL && r.view_url) a.view_url = r.view_url;
      log(`media saved msg=${payload.message_id} bytes=${r.bytes} mime=${r.local_mime}`);
    } catch (e) { a.download_error = String(e.message).slice(0, 200); log(`media download failed msg=${payload.message_id} err=${a.download_error}`); }
  } else if (a && VIEW_URL && !a.encrypted && a.attachment_id) {
    try { const m = await restApi.attachment.fetch(a.attachment_id); if (m && m.view_url) a.view_url = m.view_url; } catch (e) { log(`view_url fetch failed msg=${payload.message_id} err=${e.message}`); }
  }
}

// ---- 2026-10-19 AI-usage reduction: webhook filter + coalescing (webhook-queue.js) ----
// Filter: categories in MIXIN_WEBHOOK_DROP_CATEGORIES (comma list, '*' wildcard; default MESSAGE_RECALL, MESSAGE_PIN and
// anything with REACTION) are processed locally (ACK, dedupe, context/media/quote cleanup for recalls) but NOT pushed.
// User stickers (PLAIN_/ENCRYPTED_STICKER) are real content and are kept. SYSTEM_* stay unforwarded unless
// MIXIN_FORWARD_SYSTEM=1 (unchanged); member_alert / gateway_alert events are never filtered or coalesced.
const DROP_CATS = (process.env.MIXIN_WEBHOOK_DROP_CATEGORIES != null ? process.env.MIXIN_WEBHOOK_DROP_CATEGORIES : 'MESSAGE_RECALL,MESSAGE_PIN,*REACTION*')
  .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
  .map((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
const dropped = (...cats) => cats.some((c) => c && DROP_CATS.some((re) => re.test(String(c).toUpperCase())));
let filteredCount = 0;
// Coalescing: same conversation + same sender within the window -> ONE webhook (latest message's fields as today +
// merged_messages + merged_count). Flush after MIXIN_WEBHOOK_COALESCE_IDLE_MS (8s) without a new message, at the latest
// MIXIN_WEBHOOK_COALESCE_MS (20s, 0 = off) after the first; MIXIN_WEBHOOK_COALESCE_MAX (20) messages flush at once.
const COALESCE_MS = int('MIXIN_WEBHOOK_COALESCE_MS', 20000), COALESCE_IDLE_MS = int('MIXIN_WEBHOOK_COALESCE_IDLE_MS', 8000), COALESCE_MAX = int('MIXIN_WEBHOOK_COALESCE_MAX', 20);

const delivery = createDelivery({
  coalesce: { maxMs: COALESCE_MS, idleMs: COALESCE_IDLE_MS, maxItems: COALESCE_MAX }, maxBytes: int('MIXIN_WEBHOOK_MAX_BYTES', 6000),
  url: WEBHOOK_URL, log, sleep, maxRetries: MAX_RETRIES, enrich, enrichTimeoutMs: int('MIXIN_ENRICH_TIMEOUT_MS', 90000),
  // Fixed key order (context LAST), context item text <= MIXIN_CONTEXT_ITEM_MAX_CHARS (500),
  // whole body <= MIXIN_WEBHOOK_MAX_BYTES (6000 UTF-8 bytes; <=0 disables the byte cap). See payload-cap.js.
  finalize: createFinalizer({ log, maxBytes: int('MIXIN_WEBHOOK_MAX_BYTES', 6000), itemMaxChars: int('MIXIN_CONTEXT_ITEM_MAX_CHARS', 500) }),
  headers: () => {
    const headers = { 'Content-Type': 'application/json' };
    if (WEBHOOK_KEY) for (const h of KEY_HEADERS) headers[h] = h.toLowerCase() === 'authorization' ? `Bearer ${WEBHOOK_KEY}` : WEBHOOK_KEY;
    return headers;
  },
  queue: {
    enabled: QUEUE, dir: process.env.MIXIN_QUEUE_DIR || path.join(__dirname, 'queue'),
    maxItems: int('MIXIN_QUEUE_MAX_ITEMS', 1000), maxBytes: int('MIXIN_QUEUE_MAX_BYTES', 50 << 20), maxRecordBytes: int('MIXIN_QUEUE_MAX_RECORD_BYTES', 1 << 20),
    maxAttempts: int('MIXIN_QUEUE_MAX_ATTEMPTS', 50), maxAgeMs: int('MIXIN_QUEUE_MAX_AGE_MS', 7 * 86400e3),
    maxBackoffMs: int('MIXIN_QUEUE_MAX_BACKOFF_MS', 300000), concurrency: int('MIXIN_QUEUE_CONCURRENCY', 4),
    maxRetryAfterMs: int('MIXIN_QUEUE_MAX_RETRY_AFTER_MS', 900000), sentKeep: int('MIXIN_QUEUE_SENT_KEEP', 5000),
  },
});
if (QUEUE) { const t = setInterval(() => { const s = delivery.stats(); log(`queue pending=${s.pending} bytes=${s.bytes} active=${s.active}`); const c = s.counters || {}; log(`webhook stats queued=${c.queued} pushed=${c.pushed} merged_webhooks=${c.merged_webhooks} merged_messages=${c.merged_messages} filtered=${filteredCount} retried=${c.retried} failed=${c.failed} dedup=${c.dedup} retracted=${c.retracted} (since start)`); }, 300000); t.unref(); }

// Group member changes (member-watch.js): on SYSTEM_CONVERSATION invalidate the conversation cache used by reply.js;
// with MIXIN_MEMBER_ALERT (default on) re-check the group read-only and submit a kind:"member_alert" webhook event when
// a member who cannot receive encrypted messages appears. Runs whether or not MIXIN_FORWARD_SYSTEM is set.
const convApi = MixinApi({ keystore, requestConfig: { timeout: 15000, ...(API_BASE ? { baseURL: API_BASE } : {}) } });
const memberWatch = require('./member-watch').createMemberWatch({
  convInfo: require('./conversation-target').createConvInfo({ api: convApi, botId: BOT_ID, log }), botId: BOT_ID, log,
  submit: (payload) => delivery.submit(payload, null, false), isAllowed, alert: MEMBER_ALERT, v2: V2,
  delayMs: int('MIXIN_MEMBER_ALERT_DELAY_MS', 3000), recheckMs: int('MIXIN_MEMBER_ALERT_RECHECK_MS', 5000),
});

function handle(msg) {
  try {
    if (!msg || !msg.message_id) return;
    if (msg.user_id === BOT_ID) return;
    const cat = msg.category || '';
    const isSystem = cat.startsWith('SYSTEM_');
    if (cat === 'SYSTEM_CONVERSATION') {
      try { const sp = parseMessage(msg, { decrypt: () => null }); memberWatch.onSystem(msg, sp.fields && sp.fields.system); }
      catch (e) { log(`WARN member watch err=${e.message}`); }
    }
    if (isSystem && !FORWARD_SYSTEM) return;
    if (cat === 'MESSAGE_RECALL' && !FORWARD_RECALL) return; // ACK only, not forwarded
    if (!isAllowed(msg.user_id)) {
      log(`blocked user=${msg.user_id} conv=${msg.conversation_id}`);
      return; // ACK + drop: no webhook, no reply
    }
    if (seen.has(msg.message_id)) { log(`dup msg=${msg.message_id}`); return; }
    markSeen(msg.message_id);
    const receivedAt = Date.now();
    const p = parseMessage(msg, {
      decrypt: (d) => decryptMessageData(d, keystore.session_id, SESSION_SEED),
      onDecryptError: (e) => log(`decrypt FAILED msg=${msg.message_id} cat=${msg.category} err=${e.message}`),
    });
    const { category } = p;
    const text = TEXT_V2 ? p.display : p.text;
    const payload = {
      conversation_id: msg.conversation_id, user_id: msg.user_id, message_id: msg.message_id,
      category, text, created_at: msg.created_at,
      encrypted: (msg.category || '').startsWith('ENCRYPTED_'), original_category: msg.category,
    };
    const recalled = p.type === 'MESSAGE_RECALL' ? p.fields.recalled_message_id : null;
    if (CONTEXT_ON) {
      try {
        payload.context = contextStore.recent(msg.conversation_id, msg.message_id);
        if (recalled) contextStore.remove(msg.conversation_id, recalled);
        else if (!isSystem) contextStore.append({ conversation_id: msg.conversation_id, user_id: msg.user_id, message_id: msg.message_id, text, created_at: msg.created_at, from_bot: false });
      } catch (e) { log(`WARN context store err=${e.message}`); }
    }
    if (V2) {
      Object.assign(payload, p.fields); // new optional fields only (never key/digest)
      payload.display_text = p.display;
      payload.received_at = new Date(receivedAt).toISOString();
      const ct = Date.parse(msg.created_at);
      if (Number.isFinite(ct)) payload.delay_ms = Math.max(0, receivedAt - ct);
      if (payload.quote_message_id) { const q = findQuote(msg.conversation_id, payload.quote_message_id); if (q) payload.quote = q; }
      if (!recalled && !isSystem) rememberQuote({ conversation_id: msg.conversation_id, message_id: msg.message_id, user_id: msg.user_id, category, text: String(p.display).slice(0, 500), created_at: msg.created_at, from_bot: false });
    } else {
      if (recalled) payload.recalled_message_id = recalled;
      if (isSystem && p.fields.system) payload.system = p.fields.system;
    }
    if (recalled) { quoteCache.delete(recalled); if (media) media.remove(recalled); }
    outage.annotate(payload, receivedAt); // additive offline_ms + gateway_status, only right after a long outage
    log(`recv msg=${msg.message_id} conv=${msg.conversation_id} cat=${msg.category}${category !== msg.category ? ' -> ' + category : ''}`);
    const needsEnrich = V2 && (LOOKUP || (!!payload.attachment && (MEDIA || VIEW_URL)));
    if (recalled) delivery.retract(recalled); // a recalled message still waiting in the queue/coalesce window is not pushed
    if (dropped(msg.category, category)) { filteredCount++; log(`webhook filtered msg=${msg.message_id} cat=${msg.category} reason=category`); return; }
    // queue off: fire-and-forget (ACK is not blocked). queue on: written to disk synchronously before the ACK.
    delivery.submit(payload, p.priv, needsEnrich, { coalesceKey: isSystem ? null : `${msg.conversation_id}:${msg.user_id}` });
  } catch (e) { log('handle error', e.message); }
}

// Metadata-only receipt log for our own message ids (no ACK, no bodies). MIXIN_RECEIPT_LOG=0 disables.
const receiptLog = require('./receipt-log').createReceiptLog({ log });

// ---- 2026-10-19: outage annotation (offline_ms) + auth circuit breaker (gateway_alert auth_failed), gateway-status.js ----
const GS = require('./gateway-status');
const RUN_DIR = process.env.MIXIN_RUN_DIR || path.dirname(process.env.MIXIN_SEND_SOCKET || path.join(__dirname, 'run', 'send.sock'));
const ALIVE_FILE = process.env.MIXIN_ALIVE_FILE || path.join(RUN_DIR, 'gateway-alive.json');
const AUTH_STATE_FILE = process.env.MIXIN_AUTH_STATE_FILE || path.join(RUN_DIR, 'auth-alert-state.json');
const OFFLINE_THRESHOLD_MS = int('MIXIN_OFFLINE_THRESHOLD_MS', 30000);
const AUTH_FAIL_LIMIT = int('MIXIN_AUTH_FAIL_LIMIT', 3);
const outage = GS.createOutageMarker({ log, thresholdMs: OFFLINE_THRESHOLD_MS, windowMs: int('MIXIN_OFFLINE_ANNOTATE_MS', 600000) });
const authAlert = GS.createAuthAlert({ log, submit: (payload) => delivery.submit(payload, null, false), stateFile: AUTH_STATE_FILE, botId: BOT_ID, v2: V2 });
const startedDownSince = GS.readAlive(ALIVE_FILE); // last moment the previous process had Blaze OPEN (null: unknown)
function stampAlive() { try { const c = blaze.current(); if (c && c.open && !c.dead) GS.writeJson(ALIVE_FILE, { t: Date.now() }); } catch (_) {} }

// Own connection manager (see blaze-conn.js); the SDK's auto-reconnect loop is no longer used.
const blaze = createBlazeConn({
  keystore, log,
  handler: { onMessage: handle, onConversation: handle, onTransfer: handle, onAckReceipt: receiptLog.onAckReceipt },
  checkMs: parseInt(process.env.MIXIN_WATCHDOG_CHECK_MS || '20000', 10),
  staleMs: parseInt(process.env.MIXIN_WATCHDOG_STALE_MS || '75000', 10),
  probeTimeoutMs: parseInt(process.env.MIXIN_PROBE_TIMEOUT_MS || '15000', 10),
  recycleMs: parseInt(process.env.MIXIN_RECYCLE_MS || '600000', 10),
  // reconnect backoff: 1s doubling up to MIXIN_RECONNECT_MAX_MS (60s), x[1-J,1+J] jitter (MIXIN_RECONNECT_JITTER 0.5),
  // reset after MIXIN_RECONNECT_RESET_MS (120s) of stable OPEN; cap is clamped to deadMs/2 (60s)
  backoffMaxMs: int('MIXIN_RECONNECT_MAX_MS', 60000), backoffResetMs: int('MIXIN_RECONNECT_RESET_MS', 120000),
  backoffJitter: (() => { const v = parseFloat(process.env.MIXIN_RECONNECT_JITTER || ''); return Number.isFinite(v) ? v : 0.5; })(),
  ...(process.env.MIXIN_BLAZE_URL ? { url: process.env.MIXIN_BLAZE_URL } : {}), // tests only
  ...(API_BASE ? { apiConfig: { baseURL: API_BASE } } : {}),                    // tests only
  authFailLimit: AUTH_FAIL_LIMIT, initialDownSince: startedDownSince,
  onReconnect: (info) => { outage.mark(info); stampAlive(); },
  onAuthOk: () => authAlert.onOk(),
  onAuthFailed: (info) => authAlert.onFailed(info), // reconnect stays paused; process stays up (queue keeps delivering)
  // Exit non-zero: run.sh restarts us in 5s with a completely fresh process.
  onDead: () => { try { if (sendEndpoint) sendEndpoint.close(); } catch (_) {} try { blaze.stop(); } catch (_) {} flushSeen(); setTimeout(() => process.exit(3), 200); },
});
blaze.start();
{ const t = setInterval(stampAlive, int('MIXIN_ALIVE_STAMP_MS', 10000)); t.unref(); }
// Local send endpoint for reply.js (unix socket, 0700 dir / 0600 socket): CREATE_MESSAGE on THIS main connection,
// so reply.js no longer opens a second Blaze connection under the same session (which got the main one closed 1006).
let sendEndpoint = null;
if (!/^(0|false|no|off)$/i.test(process.env.MIXIN_SEND_ENDPOINT || '')) {
  try { sendEndpoint = require('./send-endpoint').createSendEndpoint({ blaze, log, botId: BOT_ID }); } catch (e) { log(`WARN send endpoint not started err=${e.message}`); }
}
// Test hook: `kill -USR2 <gateway pid>` force-terminates the current socket (simulated 1006).
process.on('SIGUSR2', () => { log('TEST force-terminate current blaze socket'); blaze.forceClose(); });
log(`gateway started bot=${BOT_ID} webhook_headers=${KEY_HEADERS.join('|')}`);
log(`gateway features payload_v2=${+V2} text_v2=${+TEXT_V2} lookup=${+LOOKUP} media=${+MEDIA} view_url=${+VIEW_URL} recall=${+FORWARD_RECALL} system=${+FORWARD_SYSTEM} queue=${+QUEUE} context=${+CONTEXT_ON}`);
log(`gateway member_alert=${+MEMBER_ALERT}`);
log(`gateway webhook_filter=${DROP_CATS.length ? (process.env.MIXIN_WEBHOOK_DROP_CATEGORIES != null ? process.env.MIXIN_WEBHOOK_DROP_CATEGORIES : 'MESSAGE_RECALL,MESSAGE_PIN,*REACTION*') : '-'} coalesce_ms=${delivery.coalescing().on ? COALESCE_MS : 0} coalesce_idle_ms=${delivery.coalescing().idleMs} coalesce_max=${COALESCE_MAX}`);
log(`gateway receipt_log=${+receiptLog.enabled} queue_active=${+delivery.stats().enabled} reconnect_max_ms=${int('MIXIN_RECONNECT_MAX_MS', 60000)} reconnect_reset_ms=${int('MIXIN_RECONNECT_RESET_MS', 120000)}`);
log(`gateway status offline_threshold_ms=${OFFLINE_THRESHOLD_MS} auth_fail_limit=${AUTH_FAIL_LIMIT} last_alive=${startedDownSince ? new Date(startedDownSince).toISOString() : '-'}`);
log(`gateway payload_cap max_bytes=${int('MIXIN_WEBHOOK_MAX_BYTES', 6000)} context_item_max_chars=${int('MIXIN_CONTEXT_ITEM_MAX_CHARS', 500)}`);

const shutdown = (sig) => { log(`shutdown ${sig}`); stampAlive(); try { memberWatch.stop(); } catch (_) {} try { if (sendEndpoint) sendEndpoint.close(); } catch (_) {} try { blaze.stop(); } catch (_) {} try { delivery.stop(); } catch (_) {} flushSeen(); process.exit(0); };
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.message));
