'use strict';
require('./ws-shim');
const { MixinApi, base64RawURLEncode } = require('@mixin.dev/mixin-node-sdk');
const { v5: uuidv5 } = require('uuid');
const { log, loadKeystore, sleep } = require('./common');
const { encryptMessageData, seedFromKeystore, sessionsChecksum } = require('./mixin-crypto');

const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'; // URL namespace
function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'encrypted') { o.encrypted = true; continue; } // boolean flag
    o[k] = a[i + 1]; i++;
  }
  return o;
}
async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = ''; for await (const c of process.stdin) s += c; return s;
}
const looksMarkdown = (t) => t.length > 500 || /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\|.*\|/.test(t);

(async () => {
  const o = args();
  let text = o.text;
  if (text === undefined || text === '-') text = (await readStdin()).replace(/\s+$/, '');
  if (!o.conversation || !o['reply-to'] || !text) {
    console.error('usage: node reply.js --conversation <id> [--user <id>] --reply-to <message_id> --text <text> [--encrypted] [--incoming-category <cat>]  (or text via stdin)');
    process.exit(2);
  }
  const keystore = loadKeystore();
  const api = MixinApi({ keystore });
  const category = looksMarkdown(text) ? 'PLAIN_POST' : 'PLAIN_TEXT';
  const message_id = uuidv5(`mixin-reply:${o['reply-to']}`, NS);
  const req = {
    conversation_id: o.conversation, message_id, category,
    data_base64: base64RawURLEncode(Buffer.from(text, 'utf8')),
  };
  if (o.user) req.recipient_id = o.user;
  // Encrypted reply when --encrypted or --incoming-category ENCRYPTED_*; falls back to plain on any failure.
  const wantEnc = o.encrypted || /^ENCRYPTED_/.test(o['incoming-category'] || '');
  let plainReq = null;
  if (wantEnc) {
    try {
      let sessions;
      if (o.user) sessions = await api.request({ method: 'POST', url: '/sessions/fetch', data: [o.user] });
      else sessions = ((await api.conversation.fetch(o.conversation)).participant_sessions || []).filter((s) => s.user_id !== keystore.app_id);
      sessions = (sessions || []).filter((s) => s.session_id && s.public_key);
      if (!sessions.length) throw new Error('no recipient sessions with public keys');
      plainReq = { ...req };
      req.category = category.replace(/^PLAIN_/, 'ENCRYPTED_');
      req.data_base64 = encryptMessageData(Buffer.from(text, 'utf8'), sessions, seedFromKeystore(keystore));
      req.checksum = sessionsChecksum(sessions.map((s) => s.session_id));
      req.recipient_sessions = sessions.map((s) => ({ session_id: s.session_id }));
    } catch (e) { log(`reply encrypt unavailable, sending plain err=${e.message}`); plainReq = null; }
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      if (req.category.startsWith('ENCRYPTED_')) {
        // Encrypted messages must go to /encrypted_messages (as in the Go SDK); /messages answers 403.
        const r = await api.request({ method: 'POST', url: '/encrypted_messages', data: [req] });
        const st = Array.isArray(r) && r[0] ? r[0].state : undefined;
        if (st && st !== 'SUCCESS') { const err = new Error(`encrypted state=${st}`); err.code = 'ENC_' + st; throw err; }
      } else await api.message.sendOne(req);
      log(`reply sent msg=${message_id} conv=${o.conversation} cat=${req.category}`);
      // Optional hook (MIXIN_WEBHOOK_CONTEXT=1): record our own reply in the per-conversation context store.
      try {
        const cs = require('./context-store');
        if (cs.enabled()) cs.append({ conversation_id: o.conversation, user_id: keystore.app_id, message_id, text, created_at: new Date().toISOString(), from_bot: true });
      } catch (e) { log(`WARN context record failed err=${e.message}`); }
      console.log(JSON.stringify({ ok: true, message_id, category: req.category }));
      return;
    } catch (e) {
      const code = e.code || e.status || (e.response && e.response.status);
      if (code === 429 || code === 500 || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
        const wait = Math.min(30000, 1000 * 2 ** attempt);
        log(`reply retry code=${code} attempt=${attempt} wait=${wait}`);
        await sleep(wait); continue;
      }
      if (plainReq) { // encrypted send rejected (e.g. checksum/session mismatch) -> plain once
        log(`reply encrypted rejected code=${code}, falling back to plain`);
        Object.keys(req).forEach((k) => delete req[k]); Object.assign(req, plainReq); plainReq = null; attempt--; continue;
      }
      log(`reply FAILED code=${code} err=${e.message}`);
      console.error(JSON.stringify({ ok: false, code, error: e.message })); process.exit(1);
    }
  }
  log('reply GAVE UP after retries'); process.exit(1);
})();
