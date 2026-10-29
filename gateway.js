'use strict';

const path = require('path');
require('./ws-shim');
const { MixinApi } = require('@mixin.dev/mixin-node-sdk');
const { createBlazeConn } = require('./blaze-conn');
const { log, loadKeystore, sleep } = require('./common');
const { decryptMessageData, seedFromKeystore } = require('./mixin-crypto');
const { parseMessage } = require('./message-parse');
const { createDelivery } = require('./webhook-queue');
const { createFinalizer } = require('./payload-cap');
const contextStore = require('./context-store');
const { createAllowlist, createSeenStore, createQuoteStore, createEnricher } = require('./gateway-state');

const CONTEXT_ON = contextStore.enabled();
const flag = (n) => /^(1|true|yes|on)$/i.test(process.env[n] || '');
const int = (n, d) => {
  const v = parseInt(process.env[n] || '', 10);
  return Number.isFinite(v) ? v : d;
};

const V2 = flag('MIXIN_PAYLOAD_V2');
const TEXT_V2 = flag('MIXIN_PAYLOAD_TEXT_V2');
const LOOKUP = V2 && flag('MIXIN_PAYLOAD_LOOKUP');
const MEDIA = V2 && flag('MIXIN_MEDIA_DOWNLOAD');
const VIEW_URL = V2 && flag('MIXIN_MEDIA_VIEW_URL');
const FORWARD_RECALL = flag('MIXIN_FORWARD_RECALL');
const FORWARD_SYSTEM = flag('MIXIN_FORWARD_SYSTEM');
const QUEUE = !/^(0|false|no|off)$/i.test(process.env.MIXIN_WEBHOOK_QUEUE || '');
const MEMBER_ALERT = !/^(0|false|no|off)$/i.test(process.env.MIXIN_MEMBER_ALERT || '1');

let keystore;
try {
  keystore = loadKeystore();
  if (!keystore || !keystore.app_id || !keystore.session_id || !keystore.session_private_key) {
    throw new Error('MIXIN_KEYSTORE_JSON lacks app_id/session_id/session_private_key');
  }
} catch (e) {
  log(`FATAL keystore invalid: ${e.message} (exit 78)`);
  process.exit(78);
}

const BOT_ID = keystore.app_id;
const SESSION_SEED = seedFromKeystore(keystore);
const WEBHOOK_URL = process.env.MIXIN_WEBHOOK_URL;
const WEBHOOK_KEY = process.env.MIXIN_WEBHOOK_KEY || '';
const KEY_HEADERS = (process.env.MIXIN_WEBHOOK_KEY_HEADERS || 'Authorization,X-Webhook-Key').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_RETRIES = parseInt(process.env.MIXIN_WEBHOOK_MAX_RETRIES || '8', 10);
const SEEN_FILE = process.env.MIXIN_SEEN_FILE || path.join(__dirname, 'seen.json');
const ALLOWLIST_FILE = process.env.MIXIN_ALLOWLIST_FILE || path.join(__dirname, 'allowlist.json');
const API_BASE = process.env.MIXIN_API_BASE || '';

if (!WEBHOOK_URL) {
  log('FATAL MIXIN_WEBHOOK_URL not set');
  process.exit(1);
}

const { isAllowed } = createAllowlist({ file: ALLOWLIST_FILE, log });
const seen = createSeenStore({ file: SEEN_FILE, max: 20000, log });
const quotes = createQuoteStore({ v2: V2, max: int('MIXIN_QUOTE_CACHE_MAX', 1000), contextOn: CONTEXT_ON, contextStore });

const restApi = LOOKUP || MEDIA || VIEW_URL
  ? MixinApi({ keystore, requestConfig: { timeout: 10000, ...(API_BASE ? { baseURL: API_BASE } : {}) } })
  : null;
const lookup = LOOKUP
  ? require('./lookup').createLookup({ api: restApi, log, file: process.env.MIXIN_LOOKUP_CACHE_FILE || path.join(__dirname, 'lookup-cache.json'), ttlMs: int('MIXIN_LOOKUP_TTL_MS', 24 * 3600e3) })
  : null;
const media = MEDIA || VIEW_URL
  ? require('./media').createMedia({
      api: restApi, log, dir: process.env.MIXIN_MEDIA_DIR || path.resolve(__dirname, '..', 'mixin-media'),
      maxBytes: int('MIXIN_MEDIA_MAX_BYTES', 20 << 20), totalMaxBytes: int('MIXIN_MEDIA_TOTAL_MAX_BYTES', 1 << 30),
      ttlMs: int('MIXIN_MEDIA_TTL_MS', 24 * 3600e3), timeoutMs: int('MIXIN_MEDIA_TIMEOUT_MS', 60000),
      ...(process.env.MIXIN_MEDIA_TYPES ? { types: process.env.MIXIN_MEDIA_TYPES } : {}),
    })
  : null;
if (media) media.downloadEnabled = MEDIA;
if (MEDIA) {
  media.ensureDir();
  media.cleanup();
  setInterval(() => media.cleanup(), 3600e3).unref();
}

const enrich = createEnricher({ v2: V2, textV2: TEXT_V2, lookup, media, viewUrl: VIEW_URL, restApi, log });
const rawDropCats = process.env.MIXIN_WEBHOOK_DROP_CATEGORIES != null ? process.env.MIXIN_WEBHOOK_DROP_CATEGORIES : 'MESSAGE_RECALL,MESSAGE_PIN,*REACTION*';
const DROP_CATS = rawDropCats.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
  .map((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
const dropped = (...cats) => cats.some((c) => c && DROP_CATS.some((re) => re.test(String(c).toUpperCase())));
let filteredCount = 0;

const COALESCE_MS = int('MIXIN_WEBHOOK_COALESCE_MS', 20000);
const COALESCE_IDLE_MS = int('MIXIN_WEBHOOK_COALESCE_IDLE_MS', 8000);
const COALESCE_MAX = int('MIXIN_WEBHOOK_COALESCE_MAX', 20);

const delivery = createDelivery({
  coalesce: { maxMs: COALESCE_MS, idleMs: COALESCE_IDLE_MS, maxItems: COALESCE_MAX },
  maxBytes: int('MIXIN_WEBHOOK_MAX_BYTES', 6000),
  url: WEBHOOK_URL, log, sleep, maxRetries: MAX_RETRIES, enrich, enrichTimeoutMs: int('MIXIN_ENRICH_TIMEOUT_MS', 90000),
  finalize: createFinalizer({ log, maxBytes: int('MIXIN_WEBHOOK_MAX_BYTES', 6000), itemMaxChars: int('MIXIN_CONTEXT_ITEM_MAX_CHARS', 500) }),
  headers: () => {
    const headers = { 'Content-Type': 'application/json' };
    if (WEBHOOK_KEY) {
      for (const h of KEY_HEADERS) headers[h] = h.toLowerCase() === 'authorization' ? `Bearer ${WEBHOOK_KEY}` : WEBHOOK_KEY;
    }
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
if (QUEUE) {
  setInterval(() => {
    const s = delivery.stats();
    log(`queue pending=${s.pending} bytes=${s.bytes} active=${s.active}`);
    const c = s.counters || {};
    log(`webhook stats queued=${c.queued} pushed=${c.pushed} merged_webhooks=${c.merged_webhooks} merged_messages=${c.merged_messages} filtered=${filteredCount} retried=${c.retried} failed=${c.failed} dedup=${c.dedup} retracted=${c.retracted} (since start)`);
  }, 300000).unref();
}

const convApi = MixinApi({ keystore, requestConfig: { timeout: 15000, ...(API_BASE ? { baseURL: API_BASE } : {}) } });
const memberWatch = require('./member-watch').createMemberWatch({
  convInfo: require('./conversation-target').createConvInfo({ api: convApi, botId: BOT_ID, log }),
  botId: BOT_ID, log, submit: (payload) => delivery.submit(payload, null, false),
  isAllowed, alert: MEMBER_ALERT, v2: V2,
  delayMs: int('MIXIN_MEMBER_ALERT_DELAY_MS', 3000), recheckMs: int('MIXIN_MEMBER_ALERT_RECHECK_MS', 5000),
});

function handle(msg) {
  try {
    if (!msg || !msg.message_id || msg.user_id === BOT_ID) return;
    const cat = msg.category || '';
    const isSystem = cat.startsWith('SYSTEM_');
    if (cat === 'SYSTEM_CONVERSATION') {
      try {
        const sp = parseMessage(msg, { decrypt: () => null });
        memberWatch.onSystem(msg, sp.fields && sp.fields.system);
      } catch (e) { log(`WARN member watch err=${e.message}`); }
    }
    if ((isSystem && !FORWARD_SYSTEM) || (cat === 'MESSAGE_RECALL' && !FORWARD_RECALL)) return;
    if (!isAllowed(msg.user_id)) {
      log(`blocked user=${msg.user_id} conv=${msg.conversation_id}`);
      return;
    }
    if (seen.has(msg.message_id)) {
      log(`dup msg=${msg.message_id}`);
      return;
    }
    seen.mark(msg.message_id);
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
      Object.assign(payload, p.fields);
      payload.display_text = p.display;
      payload.received_at = new Date(receivedAt).toISOString();
      const ct = Date.parse(msg.created_at);
      if (Number.isFinite(ct)) payload.delay_ms = Math.max(0, receivedAt - ct);
      if (payload.quote_message_id) {
        const q = quotes.find(msg.conversation_id, payload.quote_message_id);
        if (q) payload.quote = q;
      }
      if (!recalled && !isSystem) {
        quotes.remember({ conversation_id: msg.conversation_id, message_id: msg.message_id, user_id: msg.user_id, category, text: String(p.display).slice(0, 500), created_at: msg.created_at, from_bot: false });
      }
    } else {
      if (recalled) payload.recalled_message_id = recalled;
      if (isSystem && p.fields.system) payload.system = p.fields.system;
    }
    if (recalled) {
      quotes.delete(recalled);
      if (media) media.remove(recalled);
    }
    outage.annotate(payload, receivedAt);
    log(`recv msg=${msg.message_id} conv=${msg.conversation_id} cat=${msg.category}${category !== msg.category ? ' -> ' + category : ''}`);
    const needsEnrich = V2 && (LOOKUP || (!!payload.attachment && (MEDIA || VIEW_URL)));
    if (recalled) delivery.retract(recalled);
    if (dropped(msg.category, category)) {
      filteredCount++;
      log(`webhook filtered msg=${msg.message_id} cat=${msg.category} reason=category`);
      return;
    }
    delivery.submit(payload, p.priv, needsEnrich, { coalesceKey: isSystem ? null : `${msg.conversation_id}:${msg.user_id}` });
  } catch (e) { log('handle error', e.message); }
}

const receiptLog = require('./receipt-log').createReceiptLog({ log });
const GS = require('./gateway-status');
const RUN_DIR = process.env.MIXIN_RUN_DIR || path.dirname(process.env.MIXIN_SEND_SOCKET || path.join(__dirname, 'run', 'send.sock'));
const ALIVE_FILE = process.env.MIXIN_ALIVE_FILE || path.join(RUN_DIR, 'gateway-alive.json');
const AUTH_STATE_FILE = process.env.MIXIN_AUTH_STATE_FILE || path.join(RUN_DIR, 'auth-alert-state.json');
const OFFLINE_THRESHOLD_MS = int('MIXIN_OFFLINE_THRESHOLD_MS', 30000);
const AUTH_FAIL_LIMIT = int('MIXIN_AUTH_FAIL_LIMIT', 3);
const outage = GS.createOutageMarker({ log, thresholdMs: OFFLINE_THRESHOLD_MS, windowMs: int('MIXIN_OFFLINE_ANNOTATE_MS', 600000) });
const authAlert = GS.createAuthAlert({ log, submit: (payload) => delivery.submit(payload, null, false), stateFile: AUTH_STATE_FILE, botId: BOT_ID, v2: V2 });
const startedDownSince = GS.readAlive(ALIVE_FILE);

function stampAlive() {
  try {
    const c = blaze.current();
    if (c && c.open && !c.dead) GS.writeJson(ALIVE_FILE, { t: Date.now() });
  } catch (_) {}
}

let sendEndpoint = null;
const blaze = createBlazeConn({
  keystore, log,
  handler: { onMessage: handle, onConversation: handle, onTransfer: handle, onAckReceipt: receiptLog.onAckReceipt },
  checkMs: parseInt(process.env.MIXIN_WATCHDOG_CHECK_MS || '20000', 10),
  staleMs: parseInt(process.env.MIXIN_WATCHDOG_STALE_MS || '75000', 10),
  probeTimeoutMs: parseInt(process.env.MIXIN_PROBE_TIMEOUT_MS || '15000', 10),
  recycleMs: parseInt(process.env.MIXIN_RECYCLE_MS || '600000', 10),
  backoffMaxMs: int('MIXIN_RECONNECT_MAX_MS', 60000),
  backoffResetMs: int('MIXIN_RECONNECT_RESET_MS', 120000),
  backoffJitter: (() => { const v = parseFloat(process.env.MIXIN_RECONNECT_JITTER || ''); return Number.isFinite(v) ? v : 0.5; })(),
  ...(process.env.MIXIN_BLAZE_URL ? { url: process.env.MIXIN_BLAZE_URL } : {}),
  ...(API_BASE ? { apiConfig: { baseURL: API_BASE } } : {}),
  authFailLimit: AUTH_FAIL_LIMIT, initialDownSince: startedDownSince,
  onReconnect: (info) => { outage.mark(info); stampAlive(); },
  onAuthOk: () => authAlert.onOk(),
  onAuthFailed: (info) => authAlert.onFailed(info),
  onDead: () => {
    try { if (sendEndpoint) sendEndpoint.close(); } catch (_) {}
    try { blaze.stop(); } catch (_) {}
    seen.flush();
    setTimeout(() => process.exit(3), 200);
  },
});
blaze.start();
setInterval(stampAlive, int('MIXIN_ALIVE_STAMP_MS', 10000)).unref();

if (!/^(0|false|no|off)$/i.test(process.env.MIXIN_SEND_ENDPOINT || '')) {
  try { sendEndpoint = require('./send-endpoint').createSendEndpoint({ blaze, log, botId: BOT_ID }); }
  catch (e) { log(`WARN send endpoint not started err=${e.message}`); }
}

process.on('SIGUSR2', () => { log('TEST force-terminate current blaze socket'); blaze.forceClose(); });
log(`gateway started bot=${BOT_ID} webhook_headers=${KEY_HEADERS.join('|')}`);
log(`gateway features payload_v2=${+V2} text_v2=${+TEXT_V2} lookup=${+LOOKUP} media=${+MEDIA} view_url=${+VIEW_URL} recall=${+FORWARD_RECALL} system=${+FORWARD_SYSTEM} queue=${+QUEUE} context=${+CONTEXT_ON}`);
log(`gateway member_alert=${+MEMBER_ALERT}`);
log(`gateway webhook_filter=${DROP_CATS.length ? rawDropCats : '-'} coalesce_ms=${delivery.coalescing().on ? COALESCE_MS : 0} coalesce_idle_ms=${delivery.coalescing().idleMs} coalesce_max=${COALESCE_MAX}`);
log(`gateway receipt_log=${+receiptLog.enabled} queue_active=${+delivery.stats().enabled} reconnect_max_ms=${int('MIXIN_RECONNECT_MAX_MS', 60000)} reconnect_reset_ms=${int('MIXIN_RECONNECT_RESET_MS', 120000)}`);
log(`gateway status offline_threshold_ms=${OFFLINE_THRESHOLD_MS} auth_fail_limit=${AUTH_FAIL_LIMIT} last_alive=${startedDownSince ? new Date(startedDownSince).toISOString() : '-'}`);
log(`gateway payload_cap max_bytes=${int('MIXIN_WEBHOOK_MAX_BYTES', 6000)} context_item_max_chars=${int('MIXIN_CONTEXT_ITEM_MAX_CHARS', 500)}`);

function shutdown(sig) {
  log(`shutdown ${sig}`);
  stampAlive();
  try { memberWatch.stop(); } catch (_) {}
  try { if (sendEndpoint) sendEndpoint.close(); } catch (_) {}
  try { blaze.stop(); } catch (_) {}
  try { delivery.stop(); } catch (_) {}
  seen.flush();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.message));
