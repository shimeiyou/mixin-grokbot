'use strict';
const fs = require('fs');
const path = require('path');
require('./ws-shim'); // must precede SDK import
const { createBlazeConn } = require('./blaze-conn');
const { log, loadKeystore, sleep } = require('./common');
const { decryptMessageData, seedFromKeystore } = require('./mixin-crypto');
const contextStore = require('./context-store');
const CONTEXT_ON = contextStore.enabled(); // MIXIN_WEBHOOK_CONTEXT=1 -> record + add payload.context

const keystore = loadKeystore();
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

const PLACEHOLDER = {
  PLAIN_IMAGE: '[收到图片]', PLAIN_STICKER: '[收到表情]', PLAIN_AUDIO: '[收到语音]',
  PLAIN_VIDEO: '[收到视频]', PLAIN_DATA: '[收到文件]', PLAIN_CONTACT: '[收到联系人名片]',
  PLAIN_LOCATION: '[收到位置]', PLAIN_LIVE: '[收到直播]', PLAIN_TRANSCRIPT: '[收到聊天记录]',
  APP_CARD: '[收到卡片]', APP_BUTTON_GROUP: '[收到按钮]', MESSAGE_RECALL: '[消息已撤回]',
  MESSAGE_PIN: '[置顶消息]',
};
// parse:false -> msg.data is the raw base64 data (binary-safe, needed for ENCRYPTED_*).
const rawData = (msg) => Buffer.from(String(msg.data ?? ''), 'base64');
// Returns {category, text}; ENCRYPTED_X is decrypted and normalized to PLAIN_X.
function toText(msg) {
  let c = msg.category || '';
  let buf = null;
  if (c.startsWith('ENCRYPTED_')) {
    try { buf = decryptMessageData(msg.data, keystore.session_id, SESSION_SEED); c = 'PLAIN_' + c.slice(10); }
    catch (e) { log(`decrypt FAILED msg=${msg.message_id} cat=${c} err=${e.message}`); return { category: msg.category, text: '[加密消息，暂不支持]' }; }
  }
  if (c === 'PLAIN_TEXT' || c === 'PLAIN_POST') return { category: c, text: (buf || rawData(msg)).toString('utf8') };
  return { category: c, text: PLACEHOLDER[c] || `[收到消息: ${c}]` };
}

async function postWebhook(payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (WEBHOOK_KEY) for (const h of KEY_HEADERS) headers[h] = h.toLowerCase() === 'authorization' ? `Bearer ${WEBHOOK_KEY}` : WEBHOOK_KEY;
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
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

function handle(msg) {
  try {
    if (!msg || !msg.message_id) return;
    if (msg.user_id === BOT_ID) return;
    if ((msg.category || '').startsWith('SYSTEM_')) return;
    if (msg.category === 'MESSAGE_RECALL') return; // ACK only, not forwarded
    if (!isAllowed(msg.user_id)) {
      log(`blocked user=${msg.user_id} conv=${msg.conversation_id}`);
      return; // ACK + drop: no webhook, no reply
    }
    if (seen.has(msg.message_id)) { log(`dup msg=${msg.message_id}`); return; }
    markSeen(msg.message_id);
    const { category, text } = toText(msg);
    const payload = {
      conversation_id: msg.conversation_id, user_id: msg.user_id, message_id: msg.message_id,
      category, text, created_at: msg.created_at,
      encrypted: (msg.category || '').startsWith('ENCRYPTED_'), original_category: msg.category,
    };
    if (CONTEXT_ON) {
      try {
        payload.context = contextStore.recent(msg.conversation_id, msg.message_id);
        contextStore.append({ conversation_id: msg.conversation_id, user_id: msg.user_id, message_id: msg.message_id, text, created_at: msg.created_at, from_bot: false });
      } catch (e) { log(`WARN context store err=${e.message}`); }
    }
    log(`recv msg=${msg.message_id} conv=${msg.conversation_id} cat=${msg.category}${category !== msg.category ? ' -> ' + category : ''}`);
    postWebhook(payload).catch((e) => log('webhook unexpected', e.message)); // fire-and-forget; ACK is not blocked
  } catch (e) { log('handle error', e.message); }
}

// Own connection manager (see blaze-conn.js); the SDK's auto-reconnect loop is no longer used.
const blaze = createBlazeConn({
  keystore, log,
  handler: { onMessage: handle, onConversation: handle, onTransfer: handle, onAckReceipt: () => {} },
  checkMs: parseInt(process.env.MIXIN_WATCHDOG_CHECK_MS || '20000', 10),
  staleMs: parseInt(process.env.MIXIN_WATCHDOG_STALE_MS || '75000', 10),
  probeTimeoutMs: parseInt(process.env.MIXIN_PROBE_TIMEOUT_MS || '15000', 10),
  recycleMs: parseInt(process.env.MIXIN_RECYCLE_MS || '600000', 10),
  // Exit non-zero: run.sh restarts us in 5s with a completely fresh process.
  onDead: () => { try { blaze.stop(); } catch (_) {} flushSeen(); setTimeout(() => process.exit(3), 200); },
});
blaze.start();
// Test hook: `kill -USR2 <gateway pid>` force-terminates the current socket (simulated 1006).
process.on('SIGUSR2', () => { log('TEST force-terminate current blaze socket'); blaze.forceClose(); });
log(`gateway started bot=${BOT_ID} webhook_headers=${KEY_HEADERS.join('|')}`);

const shutdown = (sig) => { log(`shutdown ${sig}`); try { blaze.stop(); } catch (_) {} flushSeen(); process.exit(0); };
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.message));
