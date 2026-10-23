'use strict';
// Send a reply to a Mixin conversation.
// Existing usage is unchanged:  --conversation <id> [--user <id>] --reply-to <message_id> --text <text|-> [--encrypted] [--incoming-category <cat>]
// Groups (GET /conversations/{id} category GROUP, or unknown): always ENCRYPTED, never plain. Encrypted to all member
// sessions over Blaze CREATE_MESSAGE without recipient_id; on rejection a private ENCRYPTED message to --user (REST).
// New optional flags (any combination; each becomes its own message, in command-line order):
//   --quote <message_id>      quoted reply (quote_message_id on the first message)
//   --sticker <sticker_id>    --contact <user_id>    --location "lat,lng[,name[,address]]" | JSON
//   --card <json|@file>       APP_CARD (plain only; app_id defaults to the bot's own). Legacy V0 (with "action") or
//                             new V1 (no "action", "actions" buttons, cover_url/cover; "actions" may be omitted/[] if a cover is set); "shareable" always sent
//   --mention <user_id>       @-mention (repeatable / comma list): "@<identity_number> " in the text + Blaze `mentions`
//   --buttons <json|@file>    APP_BUTTON_GROUP, 1..6 buttons (plain only)
//   --image <path> --video <path> --audio <path> --file <path> [--name <filename>] [--caption <text>]
//   --silent                  silent message      --seq <n>   extra salt so a second reply to the same message gets new ids
// --help / -h: print usage and exit 0 before anything else runs (no module loading, no stdin read, no keystore, no
// network). Only a flag position counts, so `--text --help` still sends the text "--help".
{
  const a = process.argv.slice(2), NOVAL = new Set(['--encrypted', '--silent', '--check-encryption']);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--help' || a[i] === '-h') {
      process.stdout.write(`Send a reply (text, media, cards, ...) to a Mixin conversation (1:1 or group).

usage: node reply.js --conversation <id> --reply-to <message_id> [--user <id>] [content flags...] [options]
       echo "text" | node reply.js --conversation <id> --reply-to <message_id> [--user <id>]
       node reply.js --help | -h

required:
  --conversation <uuid>        conversation to reply in (1:1 CONTACT or GROUP)
  --reply-to <message_id>      incoming message being answered; reply ids are derived from it (UUIDv5), so a
                               retry never sends the same reply twice

target / mode:
  --user <uuid>                sender of the incoming message. 1:1: recipient_id. Groups: target of the private
                               encrypted fallback (no --user -> no fallback, exit 1)
  --encrypted                  1:1: send ENCRYPTED_* (falls back to plain on failure). Groups are always encrypted
  --incoming-category <cat>    category of the incoming message; ENCRYPTED_* implies --encrypted

content (each flag becomes its own message, in command-line order):
  --text <text|->              text; "-" or no --text (and no other content) reads stdin. Markdown-looking or
                               >500 chars -> POST, otherwise TEXT
  --sticker <sticker_id>       sticker
  --contact <user_id>          contact card of a user
  --location "lat,lng[,name[,address]]" | <json>   location
  --card <json|@file>          APP_CARD; app_id = bot; "shareable" is always sent (default true).
                               legacy V0: {title, description, icon_url(https), action}
                               new V1:    {actions:[{label, action, color?}], title?, description?, cover_url?, cover?}
                               "action" together with "actions" is refused (iOS would ignore "actions").
                               WARN: description >1024; any input: action (iOS can't forward such a card).
                               No encrypted form: refused in groups (exit 2)
  --buttons <json|@file>       APP_BUTTON_GROUP, 1..6 [{label, action, color?}]. Refused in groups (exit 2)
  --image <path>               image (jpeg/png/gif/webp)
  --video <path>               video (needs ffprobe)
  --audio <path>               voice message (converted to ogg/opus with ffmpeg if needed)
  --file <path>                file (DATA)

options:
  --quote <message_id>         quote this message (on the first message only)
  --name <filename>            file name for --file (default: basename of the path)
  --caption <text>             caption for --image/--video/--file
                               --image/--video/--audio/--file paths must resolve (realpath) inside MIXIN_ATTACH_DIRS
                               (colon list; default: the media dir, e.g. ~/mixin-media); URLs are refused.
                               Otherwise exit 2, code ATTACH_PATH_DENIED, nothing sent.
  --mention <user_id>          @-mention a user in --text (repeatable, or comma-separated). Adds "@<identity_number> "
                               in front of the text unless the text already contains it (official clients render it as
                               @name and notify that user), sends the text as TEXT (not POST), and sets the Blaze
                               "mentions" field in groups. Needs --text; not the bot itself; lookup: GET /users/<id>
  --silent                     silent message (no notification)
  --seq <n>                    extra salt so a second reply to the same --reply-to gets new message ids
  --help, -h                   show this help and exit

other modes (no message content; --reply-to not needed):
  --recall <message_id>[,<id>...]   recall messages the BOT itself sent in --conversation (repeatable). Only ids found
                               in the local sent-log / context store / gateway.log are accepted, otherwise nothing is
                               sent (exit 2). 1:1: MESSAGE_RECALL via REST (recipient_id = --user or the other member).
                               Groups: refused (exit 2) because MESSAGE_RECALL has no encrypted form; MIXIN_GROUP_RECALL=1
                               allows it (sent on the gateway's main connection via the send endpoint only). Prints
                               {"ok":true,"recalled":[{message_id,recall_message_id,category,via}]}
  --check-encryption           read-only: list the members of --conversation and whether each can receive encrypted
                               messages; prints JSON, exit 0 all can, 3 someone cannot, 1 lookup error
                               (same as: node check-encryption.js --conversation <id>)

Groups are ALWAYS encrypted and never plain, and are sent ONLY on the gateway's main Blaze connection through its send
endpoint (via=gateway; reply.js never opens a Blaze connection of its own). If Mixin rejects the group message (or a
member has no key) -> private encrypted message to --user (via=rest, visible only to that user). If the endpoint cannot
be reached -> exit 1 with code ENDPOINT_UNAVAILABLE and nothing sent (no private fallback). 1:1 replies use REST only.
endpoint: MIXIN_SEND_ENDPOINT unset = local socket (MIXIN_SEND_SOCKET or <dir>/run/send.sock); unix:/abs/send.sock;
          ssh:<host>:/abs/send.sock = the gateway on another host, reached by "ssh -W" (OpenSSH streamlocal over stdio,
          BatchMode, key from ~/.ssh/config); 0 = disabled (group sends fail). With ssh:, every successful send is also
          recorded on the gateway host (sent-log / context) so receipts, recall and webhook context keep working.

output: {"ok":true,"message_id":...,"category":...} (+ "messages":[...] for more than one item, + "mentions":
        [{user_id, identity_number}] with --mention) on stdout.
exit codes: 0 sent, 1 send failed, 2 usage error or refused (nothing sent), 3 --check-encryption: someone cannot receive.
env: MIXIN_KEYSTORE_JSON (required), MIXIN_GATEWAY_LOG, MIXIN_UPLOAD_MAX_BYTES, MIXIN_SEND_SOCKET,
     MIXIN_SEND_ENDPOINT (see above), MIXIN_SEND_ENDPOINT_TRIES (3), MIXIN_SEND_ENDPOINT_TIMEOUT_MS (30000),
     MIXIN_SSH_CONNECT_TIMEOUT_S (10), MIXIN_BLAZE_SEND_TRIES, MIXIN_GROUP_ENCRYPT=0, MIXIN_CONV_CACHE_FILE, MIXIN_WEBHOOK_CONTEXT, MIXIN_CONTEXT_DIR,
     MIXIN_GROUP_RECALL=1, MIXIN_SENT_LOG_FILE
`);
      process.exit(0);
    }
    if (a[i].startsWith('--') && !NOVAL.has(a[i])) i++; // skip the flag's value
  }
}
require('./ws-shim');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MixinApi, base64RawURLEncode } = require('@mixin.dev/mixin-node-sdk');
const { v5: uuidv5 } = require('uuid');
const { log, loadKeystore, sleep } = require('./common');
const { encryptMessageData, seedFromKeystore, sessionsChecksum } = require('./mixin-crypto');

const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'; // URL namespace
const BOOL = new Set(['encrypted', 'silent', 'check-encryption']);
const CONTENT = ['text', 'sticker', 'location', 'contact', 'card', 'buttons', 'image', 'video', 'audio', 'file'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function args() {
  const a = process.argv.slice(2), o = {};
  Object.defineProperty(o, '_order', { value: [], enumerable: false });
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (BOOL.has(k)) { o[k] = true; continue; } // boolean flags
    if (k === 'recall') { o.recall = (o.recall || []).concat(String(a[i + 1] == null ? '' : a[i + 1]).split(',')); i++; continue; } // repeatable
    if (k === 'mention') { o.mention = (o.mention || []).concat(String(a[i + 1] == null ? '' : a[i + 1]).split(',').map((x) => x.trim())); i++; continue; } // repeatable
    o[k] = a[i + 1]; i++;
    if (CONTENT.includes(k) && !o._order.includes(k)) o._order.push(k);
  }
  return o;
}
async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = ''; for await (const c of process.stdin) s += c; return s;
}
const looksMarkdown = (t) => t.length > 500 || /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\|.*\|/.test(t);
const USAGE = 'usage: node reply.js --conversation <id> [--user <id>] --reply-to <message_id> --text <text> [--mention <user_id>]... [--encrypted] [--incoming-category <cat>]  (or text via stdin)\n' +
  '       optional: [--quote <message_id>] [--sticker <id>] [--location "lat,lng[,name[,address]]"] [--contact <user_id>] [--card <json|@file>] [--buttons <json|@file>]\n' +
  '                 [--image <path>] [--video <path>] [--audio <path>] [--file <path>] [--name <filename>] [--caption <text>] [--silent] [--seq <n>]';
class UsageError extends Error {}
const bad = (m) => { throw new UsageError(m); };
const jsonArg = (v, what) => {
  if (v == null || v === '') bad(`--${what} needs a value`);
  const s = String(v).startsWith('@') ? fs.readFileSync(String(v).slice(1), 'utf8') : String(v);
  try { return JSON.parse(s); } catch (e) { return bad(`--${what}: invalid JSON (${e.message})`); }
};
const ACTION = /^(https?:\/\/|mixin:\/\/|input:)\S+$/;

// ---- builders for the non-attachment kinds: return {category, data(Buffer)}; enc = has ENCRYPTED_ form ----
function textItem(text, forceText = false) { const cat = !forceText && looksMarkdown(text) ? 'PLAIN_POST' : 'PLAIN_TEXT'; return { kind: 'text', type: cat.slice(6), enc: true, summary: text, data: async () => Buffer.from(text, 'utf8') }; }
function jsonItem(kind, type, obj, enc, summary) { return { kind, type, enc, summary, data: async () => Buffer.from(JSON.stringify(obj)) }; }
function stickerItem(v) { if (!UUID.test(v || '')) bad('--sticker needs a sticker_id (uuid)'); return jsonItem('sticker', 'STICKER', { sticker_id: v }, true, '[表情]'); }
function contactItem(v) { if (!UUID.test(v || '')) bad('--contact needs a user_id (uuid)'); return jsonItem('contact', 'CONTACT', { user_id: v }, true, `[联系人 ${v}]`); }
function locationItem(v) {
  let l;
  if (String(v || '').trim().startsWith('{')) l = jsonArg(v, 'location');
  else { const p = String(v || '').split(','); l = { latitude: Number(p[0]), longitude: Number(p[1]) }; if (p[2]) l.name = p[2].trim(); if (p.length > 3) l.address = p.slice(3).join(',').trim(); }
  l.latitude = Number(l.latitude); l.longitude = Number(l.longitude);
  if (!(Math.abs(l.latitude) <= 90) || !(Math.abs(l.longitude) <= 180) || String(v).trim() === '') bad('--location needs "lat,lng[,name[,address]]" with -90<=lat<=90, -180<=lng<=180');
  const obj = { latitude: l.latitude, longitude: l.longitude }; if (l.name) obj.name = String(l.name); if (l.address) obj.address = String(l.address);
  return jsonItem('location', 'LOCATION', obj, true, `[位置${obj.name ? ' ' + obj.name : ''} ${obj.latitude},${obj.longitude}]`);
}
function cardItem(v, botId) {
  // Two generations (mixin-builder references/messaging.md §2; iOS AppCardData.swift): a non-empty legacy "action"
  // makes iOS parse the whole card as V0 and ignore "actions"; without "action" it is V1, whose decoder REQUIRES
  // "shareable" (missing -> iOS renders nothing). So: never mix, always send shareable.
  const c = jsonArg(v, 'card');
  if (!c || typeof c !== 'object' || Array.isArray(c)) bad('--card must be a JSON object');
  const card = { app_id: botId, ...c };
  if (card.app_id !== botId) bad('--card app_id must be the bot\'s own app_id (omit it to use the default)');
  if (card.shareable == null) card.shareable = true;
  if (typeof card.shareable !== 'boolean') bad('--card "shareable" must be true or false');
  const hasAction = card.action != null && card.action !== '';
  if (hasAction && card.actions != null) bad('--card: use either "action" (legacy card) or "actions" (new card), not both — iOS ignores "actions" when "action" is set');
  const str = (k) => card[k] != null && card[k] !== '' && typeof card[k] !== 'string' ? bad(`--card "${k}" must be a string`) : (card[k] || '');
  const title = str('title'), description = str('description');
  let gen;
  if (hasAction) { // V0 (legacy)
    gen = 'v0';
    for (const k of ['title', 'description']) if (!card[k]) bad(`--card needs a non-empty "${k}" (legacy card with "action")`);
    if (!/^https:\/\//.test(card.icon_url || '')) bad('--card needs "icon_url" (https URL) (legacy card with "action")');
    if (!ACTION.test(card.action)) bad('--card "action" must be https://…, mixin://… or input:…');
  } else { // V1 (new)
    gen = 'v1';
    // No-button V1 (2026-10-20): "actions" omitted or [] is allowed when the card has a cover (cover_url / cover.url);
    // it is sent as "actions": []. Clients: no card-level tap on V1 (Android linkifies URLs in the description).
    const hasCover = !!(card.cover_url || (card.cover && card.cover.url));
    const noButtons = card.actions == null || (Array.isArray(card.actions) && card.actions.length === 0);
    if (noButtons && !hasCover) bad('--card needs "action" (legacy card) or "actions" (new card: [{label, action, color?}]); a new card without buttons needs "cover_url" or "cover"');
    card.actions = noButtons ? [] : validButtons(card.actions, 'card.actions', { max: Infinity });
    if (!title && !description) bad('--card (new card) needs a "title" or a "description"');
    if (card.cover_url != null && !/^https:\/\//.test(card.cover_url)) bad('--card "cover_url" must be an https URL');
    if (card.cover != null && (typeof card.cover !== 'object' || Array.isArray(card.cover) || !/^https:\/\//.test(card.cover.url || ''))) bad('--card "cover" must be an object with an https "url"');
    if (card.icon_url != null && !/^https:\/\//.test(card.icon_url)) bad('--card "icon_url" must be an https URL');
  }
  if ([...title].length > 36) log('WARN card title >36 chars; Mixin clients may truncate it');
  if ([...description].length > 1024) log('WARN card description >1024 chars; Mixin clients may truncate or reject it');
  const acts = hasAction ? [card.action] : card.actions.map((x) => x.action);
  if (!hasAction && !card.actions.length) log('WARN card has no buttons and no "action": tapping the card does nothing (URLs in the description are tappable on Android only)');
  if (acts.some((x) => /^input:/.test(x))) log('WARN card has an input: action; iOS cannot forward such a card');
  if (acts.some((x) => x === 'input:share')) log('WARN card action "input:share" does not exist in Mixin clients; it just sends the text "share"');
  if (acts.some((x) => /^[a-z]+:\/\/mixin\.one\/send/i.test(x))) log('WARN card has a mixin.one/send action; Desktop cannot forward such a card');
  return { ...jsonItem('card', 'APP_CARD', card, false, `[卡片 ${title || description}：${description || title}]`), cardGen: gen };
}
function validButtons(b, what, { max = 6 } = {}) { // APP_BUTTON_GROUP: 1..6; card "actions": no count limit
  if (!Array.isArray(b) || b.length < 1 || b.length > max) bad(`--${what} must be a JSON array of ${max === Infinity ? 'at least 1 button' : '1..' + max + ' buttons'}`);
  return b.map((x, i) => {
    if (!x || typeof x.label !== 'string' || !x.label) bad(`--${what}[${i}] needs a "label"`);
    if (!ACTION.test(x.action || '')) bad(`--${what}[${i}] needs "action" (https://…, mixin://… or input:…)`);
    const color = x.color == null ? '#000000' : String(x.color);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) bad(`--${what}[${i}] color must look like #RRGGBB`);
    return { label: x.label, color, action: x.action };
  });
}
function buttonsItem(v) { const b = validButtons(jsonArg(v, 'buttons'), 'buttons'); return jsonItem('buttons', 'APP_BUTTON_GROUP', b, false, `[按钮 ${b.map((x) => x.label).join(' | ')}]`); }

// ---- attachments: metadata once, upload per form (encrypted form uploads ciphertext) ----
const MAX_UPLOAD = parseInt(process.env.MIXIN_UPLOAD_MAX_BYTES || String(100 << 20), 10);
function attachmentItem(kind, p, o, ctx) {
  const mi = require('./media-info');
  if (!p) bad(`--${kind} needs a file path`);
  // Path allowlist (attach-guard.js): real path must be inside MIXIN_ATTACH_DIRS / the media dir; URLs refused.
  // Throws AttachDenied (code ATTACH_PATH_DENIED -> exit 2, nothing sent). From here on only the real path is used.
  const chk = require('./attach-guard').checkAttachPath(p, { flag: kind });
  if (chk.missing) bad(`--${kind}: file not found: ${p}`);
  const shownName = path.basename(p); p = chk.real;
  let st; try { st = fs.statSync(p); } catch (_) { bad(`--${kind}: file not found: ${p}`); }
  if (!st.isFile()) bad(`--${kind}: not a regular file: ${p}`);
  if (st.size === 0) bad(`--${kind}: empty file`);
  if (st.size > MAX_UPLOAD) bad(`--${kind}: file is ${st.size} bytes, limit MIXIN_UPLOAD_MAX_BYTES=${MAX_UPLOAD}`);
  let file = p, buf = fs.readFileSync(p);
  const meta = {};
  const type = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', file: 'DATA' }[kind];
  if (kind === 'image') {
    const m = mi.sniffMime(buf);
    if (!m || !m.startsWith('image/')) bad('--image: not a recognised image (jpeg/png/gif/webp); use --file to send it as a file');
    const sz = mi.imageSize(buf) || mi.probe(p);
    if (!sz || !sz.width || !sz.height) bad('--image: could not read width/height; use --file');
    Object.assign(meta, { mime_type: m, width: sz.width, height: sz.height, size: buf.length });
    const th = mi.thumbnailB64(p); if (th && th.length < 16384) meta.thumbnail = th;
  } else if (kind === 'video') {
    const pr = mi.probe(p);
    if (!pr || !pr.width || !pr.height) bad('--video: ffprobe could not read the video (is ffprobe installed?)');
    Object.assign(meta, { mime_type: mi.sniffMime(buf) || mi.mimeForPath(p), width: pr.width, height: pr.height, size: buf.length, duration: pr.duration_ms });
    const th = mi.thumbnailB64(p); if (th && th.length < 16384) meta.thumbnail = th;
  } else if (kind === 'audio') {
    let pr = mi.probe(p);
    if (!(mi.sniffMime(buf) === 'audio/ogg' && pr && pr.audio_codec === 'opus')) { // Mixin clients expect ogg/opus voice
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-audio-')); fs.chmodSync(dir, 0o700); ctx.cleanup.push(dir);
      file = path.join(dir, 'voice.ogg');
      try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', p, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', file], { timeout: 120000 }); }
      catch (e) { bad(`--audio: could not convert to ogg/opus with ffmpeg (${String(e.message).split('\n')[0]})`); }
      buf = fs.readFileSync(file); pr = mi.probe(file);
    }
    Object.assign(meta, { mime_type: 'audio/ogg', size: buf.length, duration: pr ? pr.duration_ms : 0 });
  } else {
    Object.assign(meta, { mime_type: mi.mimeForPath(p) !== 'application/octet-stream' ? mi.mimeForPath(p) : (mi.sniffMime(buf) || 'application/octet-stream'), size: buf.length, name: o.name || shownName });
  }
  if (o.caption && kind !== 'audio') meta.caption = String(o.caption);
  const summary = `[${{ image: '图片', video: '视频', audio: '语音', file: '文件' }[kind]} ${meta.name || shownName}]`;
  return {
    kind, type, enc: true, summary, attachment: true,
    // enc=false: upload plaintext.  enc=true: AES-256-CBC+HMAC blob, key/digest go into the (encrypted) message JSON.
    data: async (enc) => {
      const { attachment_id, extra } = await ctx.upload(buf, enc);
      ctx.lastAttachment = attachment_id;
      return Buffer.from(JSON.stringify({ attachment_id, ...extra, ...meta }));
    },
  };
}

(async () => {
  const o = args();
  // ---- modes without message content ----
  if (o['check-encryption']) process.exit(await require('./check-encryption').main(['--conversation', o.conversation]));
  if (o.recall) {
    if (o._order.length || o.quote != null || o.mention) { console.error(JSON.stringify({ ok: false, code: 'usage', error: '--recall cannot be combined with content flags, --quote or --mention' })); console.error(USAGE); process.exit(2); }
    if (!o.conversation) { console.error(JSON.stringify({ ok: false, code: 'usage', error: '--recall needs --conversation' })); console.error(USAGE); process.exit(2); }
    const keystore = loadKeystore();
    const API_BASE = process.env.MIXIN_API_BASE || ''; // tests only
    const api = MixinApi(API_BASE ? { keystore, requestConfig: { baseURL: API_BASE } } : { keystore });
    process.exit(await require('./recall').runRecall({ o, api, keystore, log, sleep, base64RawURLEncode }));
  }
  const extras = o._order.filter((k) => k !== 'text');
  let text = o.text;
  // Old behaviour: no --text (or --text -) -> read stdin. With other content flags, stdin is read only for --text -.
  if (!extras.length) { if (text === undefined || text === '-') text = (await readStdin()).replace(/\s+$/, ''); }
  else if (text === '-') text = (await readStdin()).replace(/\s+$/, '');
  if (!o.conversation || !o['reply-to'] || (!text && !extras.length)) {
    console.error(USAGE);
    process.exit(2);
  }
  const keystore = loadKeystore();
  const API_BASE = process.env.MIXIN_API_BASE || ''; // tests only; default SDK base https://api.mixin.one
  const api = MixinApi(API_BASE ? { keystore, requestConfig: { baseURL: API_BASE } } : { keystore });
  const ctx = {
    cleanup: [],
    upload: async (buf, enc) => {
      const { encryptAttachment } = require('./attachment-crypto');
      const a = await api.attachment.create(); // POST /attachments
      if (!a || !a.upload_url) throw new Error('POST /attachments returned no upload_url');
      let body = buf, extra = {};
      if (enc) { const e = encryptAttachment(buf); body = e.data; extra = { key: e.key.toString('base64'), digest: e.digest.toString('base64') }; }
      const r = await fetch(a.upload_url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'x-amz-acl': 'public-read' }, body, signal: AbortSignal.timeout(300000) });
      if (!r.ok) { const err = new Error(`attachment upload status ${r.status}`); err.code = r.status >= 500 ? 500 : r.status; throw err; }
      log(`reply attachment uploaded id=${a.attachment_id} bytes=${body.length} encrypted=${!!enc}`);
      return { attachment_id: a.attachment_id, extra };
    },
  };
  // --mention: official format (iOS MessageMentionDetector "@([0-9]{4,})", Android mentionNumberPattern "@[\d]{4,}",
  // flutter mentionNumberRegExp): the TEXT carries "@<identity_number>"; receiving clients render it as @name and
  // flag "mentioned me". Senders also put the user ids into the Blaze CREATE_MESSAGE `mentions` param (iOS
  // SendMessageService, Android SendMessageJob getMentionData) — we do that on the Blaze group path.
  let mentions = null;
  if (o.mention) {
    try {
      const ids = [...new Set(o.mention.filter((x) => x !== ''))];
      if (!ids.length) bad('--mention needs a user_id (uuid)');
      for (const id of ids) {
        if (!UUID.test(id)) bad(`--mention needs a user_id (uuid), got "${id}"`);
        if (id.toLowerCase() === String(keystore.app_id).toLowerCase()) bad('--mention: the bot cannot mention itself');
      }
      if (!text) bad('--mention needs --text (mentions are part of a text message)');
      if (ids.length > 50) bad('--mention: at most 50 users');
      mentions = ids.map((id) => ({ user_id: id.toLowerCase(), identity_number: null }));
    } catch (e) {
      if (e instanceof UsageError) { console.error(JSON.stringify({ ok: false, code: 'usage', error: e.message })); console.error(USAGE); process.exit(2); }
      throw e;
    }
    for (const m of mentions) {
      let u = null;
      try { u = await api.user.fetch(m.user_id); } catch (e) { log(`reply FAILED mention lookup user=${m.user_id} err=${e.message}`); console.error(JSON.stringify({ ok: false, code: e.code || 'MENTION_LOOKUP_FAILED', error: `--mention: user lookup failed for ${m.user_id} (${e.message}); nothing sent` })); process.exit(1); }
      if (!u || !/^\d{4,}$/.test(String(u.identity_number || ''))) { console.error(JSON.stringify({ ok: false, code: 'MENTION_LOOKUP_FAILED', error: `--mention: no identity_number for ${m.user_id}; nothing sent` })); process.exit(1); }
      m.identity_number = String(u.identity_number);
    }
    const missing = mentions.filter((m) => !new RegExp(`@${m.identity_number}(?!\\d)`).test(text));
    if (missing.length) text = missing.map((m) => `@${m.identity_number} `).join('') + text;
    log(`reply mention users=${mentions.map((m) => m.user_id).join(',')} prefixed=${missing.length}`);
  }
  let items;
  try {
    if (o.quote != null && !UUID.test(o.quote)) bad('--quote needs a message_id (uuid)');
    const order = extras.length ? o._order : ['text'];
    items = [];
    for (const k of order) {
      if (k === 'text') { if (text) items.push(textItem(text, !!mentions)); }
      else if (k === 'sticker') items.push(stickerItem(o.sticker));
      else if (k === 'contact') items.push(contactItem(o.contact));
      else if (k === 'location') items.push(locationItem(o.location));
      else if (k === 'card') items.push(cardItem(o.card, keystore.app_id));
      else if (k === 'buttons') items.push(buttonsItem(o.buttons));
      else items.push(attachmentItem(k, o[k], o, ctx));
    }
  } catch (e) {
    if (e && e.code === 'ATTACH_PATH_DENIED') { log(`reply refused code=ATTACH_PATH_DENIED conv=${o.conversation} (nothing sent)`); console.error(JSON.stringify({ ok: false, code: 'ATTACH_PATH_DENIED', error: e.message })); process.exit(2); }
    if (e instanceof UsageError) { console.error(JSON.stringify({ ok: false, code: 'usage', error: e.message })); console.error(USAGE); process.exit(2); }
    throw e;
  }
  const seq = o.seq != null ? `:seq:${o.seq}` : '';
  const counts = {};
  for (const it of items) { const n = counts[it.kind] = (counts[it.kind] ?? -1) + 1; it.id = it.kind === 'text' && !seq ? uuidv5(`mixin-reply:${o['reply-to']}`, NS) : uuidv5(`mixin-reply:${o['reply-to']}${seq}:${it.kind}:${n}`, NS); }

  // Conversation category decides the targeting (conversation-target.js):
  //   CONTACT: unchanged behaviour (REST, recipient_id = --user, encrypted to --user's sessions, plain fallback).
  //   GROUP: ALWAYS encrypted, never plain. ENCRYPTED_* as Blaze CREATE_MESSAGE without recipient_id, sent through the
//     gateway's main connection (send-endpoint.js, via=gateway) ONLY — never a second Blaze connection (audit W-6),
  //     encrypted to every participant session except the bot's own, with conversation_checksum (md5 of all participant
  //     session ids, as the clients send it). 20140 (checksum invalid) -> refresh sessions, re-encrypt, retry once.
  //   Endpoint unreachable (gateway down / ssh failure / its Blaze down) after MIXIN_SEND_ENDPOINT_TRIES: exit 1,
  //     code ENDPOINT_UNAVAILABLE, nothing sent (no private fallback: the problem is ours, not the group's).
  //   FALLBACK (rejected by Mixin, a member without public key, lookup failed, MIXIN_GROUP_ENCRYPT=0): the old
  //     private ENCRYPTED message to --user via REST /encrypted_messages (recipient_id = --user). If that fails too:
  //     exit 1, nothing is sent plain. Logged as "reply FALLBACK reason=…".
  const { createConvInfo } = require('./conversation-target');
  const conv = createConvInfo({ api, botId: keystore.app_id, log });
  const convCategory = await conv.category(o.conversation, o.user);
  const isContact = convCategory === 'CONTACT';
  const seed = seedFromKeystore(keystore);
  const closeBlaze = () => {};
  const BLAZE_TRIES = parseInt(process.env.MIXIN_BLAZE_SEND_TRIES || '3', 10);       // Mixin-side transient errors
  const EP_TRIES = Math.max(1, parseInt(process.env.MIXIN_SEND_ENDPOINT_TRIES || '3', 10)); // endpoint transport errors
  const sendEp = require('./send-endpoint');
  let endpoint = null, endpointErr = null;
  try { endpoint = sendEp.parseEndpoint(); } catch (e) { endpointErr = e; }
  const md5Ids = (ids) => sessionsChecksum(ids);

  let mode = 'contact'; // contact | group | private
  let gSessions = null, gChecksum = null, pSessions = null;
  const fallback = (reason) => {
    if (mode !== 'private') log(`reply FALLBACK reason=${reason} conv=${o.conversation} mode=private-encrypted recipient_id=${o.user || 'none'} (reply visible only to that user)`);
    mode = 'private';
  };
  async function loadGroup(fresh) {
    const g = await conv.groupSessions(o.conversation, { fresh });
    if (g.missing.length) return { missing: g.missing };
    if (!g.sessions.length) return { missing: ['(no member sessions)'] };
    gSessions = g.sessions; gChecksum = md5Ids(g.allSessionIds);
    return { missing: [] };
  }
  if (!isContact) {
    const noEnc = items.filter((it) => !it.enc).map((it) => '--' + ({ card: 'card', buttons: 'buttons' }[it.kind] || it.kind));
    if (noEnc.length) {
      console.error(JSON.stringify({ ok: false, code: 'usage', error: `${[...new Set(noEnc)].join(', ')} have no encrypted form; group replies are encrypted only (nothing sent)` }));
      process.exit(2);
    }
    mode = 'group';
    if (convCategory !== 'GROUP') fallback('conversation_lookup_failed');
    else if (/^(0|false|no|off)$/i.test(process.env.MIXIN_GROUP_ENCRYPT || '')) fallback('group_encrypt_disabled');
    else {
      try {
        const r = await loadGroup(false);
        if (r.missing.length) fallback(`member_without_pubkey users=${r.missing.join(',')}`);
        else log(`reply target conv=${o.conversation} category=GROUP transport=blaze mode=group-encrypted sessions=${gSessions.length} recipient_id=none`);
        if (mentions && gSessions) { const members = new Set(gSessions.map((x) => x.user_id)); const out = mentions.filter((m) => !members.has(m.user_id)); if (out.length) log(`WARN --mention user not in the group (no member session): ${out.map((m) => m.user_id).join(',')}`); }
      } catch (e) { fallback(`session_lookup_failed err=${e.message}`); }
    }
  }
  async function privateSessions(fresh) {
    if (pSessions && !fresh) return pSessions;
    if (!o.user) { const e = new Error('private encrypted fallback needs --user; nothing sent (never plain in a group)'); e.code = 'NO_PRIVATE_TARGET'; throw e; }
    const s = ((await api.request({ method: 'POST', url: '/sessions/fetch', data: [o.user] })) || []).filter((x) => x.session_id && x.public_key);
    if (!s.length) { const e = new Error('--user has no session with a public key; nothing sent (never plain in a group)'); e.code = 'NO_PRIVATE_SESSIONS'; throw e; }
    return (pSessions = s);
  }

  // Encrypted reply when --encrypted or --incoming-category ENCRYPTED_*; falls back to plain on any failure. (CONTACT only)
  const wantEnc = o.encrypted || /^ENCRYPTED_/.test(o['incoming-category'] || '');
  let sessions = null;
  async function contactSessions(fresh) { // fresh: drop the cached conversation (conv-cache.json) and refetch
    let s;
    if (o.user) s = await api.request({ method: 'POST', url: '/sessions/fetch', data: [o.user] });
    else { if (fresh) conv.invalidate(o.conversation); s = ((await conv.conversation(o.conversation, { fresh })).participant_sessions || []).filter((x) => x.user_id !== keystore.app_id); }
    s = (s || []).filter((x) => x.session_id && x.public_key);
    if (!s.length) throw new Error('no recipient sessions with public keys');
    return s;
  }
  if (isContact && wantEnc && items.some((it) => it.enc)) {
    try { sessions = await contactSessions(false); } catch (e) { log(`reply encrypt unavailable, sending plain err=${e.message}`); sessions = null; }
  }
  async function payload(it, enc) { // memoised per form: re-encrypting (refresh / fallback) never re-uploads an attachment
    const memo = it._data || (it._data = {});
    return memo[enc ? 'e' : 'p'] || (memo[enc ? 'e' : 'p'] = await it.data(enc));
  }
  async function build(it, enc, quote) { // CONTACT (unchanged)
    const data = await payload(it, enc);
    const req = { conversation_id: o.conversation, message_id: it.id, category: (enc ? 'ENCRYPTED_' : (it.type.startsWith('APP_') ? '' : 'PLAIN_')) + it.type };
    req.data_base64 = enc ? encryptMessageData(data, sessions, seed) : base64RawURLEncode(data);
    if (o.user) req.recipient_id = o.user;
    if (enc) { req.checksum = sessionsChecksum(sessions.map((s) => s.session_id)); req.recipient_sessions = sessions.map((s) => ({ session_id: s.session_id })); }
    if (quote) req.quote_message_id = quote;
    if (o.silent) req.silent = true;
    return req;
  }
  async function buildEnc(it, quote, target) { // GROUP (Blaze) or PRIVATE (REST) — always ENCRYPTED_*
    const data = await payload(it, true);
    const req = { conversation_id: o.conversation, message_id: it.id, category: 'ENCRYPTED_' + it.type };
    if (target === 'group') {
      req.data_base64 = encryptMessageData(data, gSessions, seed);
      req.conversation_checksum = gChecksum; // Blaze field used by Android/flutter/iOS deliver()
      if (mentions && it.kind === 'text') req.mentions = mentions.map((m) => m.user_id); // Blaze param, as the clients send it
    } else {
      req.recipient_id = o.user;
      req.data_base64 = encryptMessageData(data, pSessions, seed);
      req.checksum = md5Ids(pSessions.map((s) => s.session_id)); req.recipient_sessions = pSessions.map((s) => ({ session_id: s.session_id }));
    }
    if (quote) req.quote_message_id = quote;
    if (o.silent) req.silent = true;
    return req;
  }
  const errInfo = (e) => {
    const code = e.code || e.status || (e.response && e.response.status);
    const httpStatus = e.response && e.response.status;
    const apiCode = e.response && e.response.data && e.response.data.error && e.response.data.error.code;
    const transient = code === 429 || code === 500 || code === 'ECONNRESET' || code === 'ETIMEDOUT' || httpStatus === 429 || httpStatus >= 500;
    return { code: apiCode || code, transient };
  };
  async function sendGroupOrPrivate(it, quote) {
    let refreshed = false, blazeTries = 0, privRefreshed = false, privTries = 0, epTries = 0;
    for (;;) {
      if (mode === 'group') {
        const req = await buildEnc(it, quote, 'group');
        const via = 'gateway';
        try {
          if (endpointErr) throw endpointErr;
          await sendEp.sendViaEndpoint(req, { endpoint }); // the gateway's main Blaze connection; no recipient_id
          log(`reply sent msg=${it.id} conv=${o.conversation} cat=${req.category} via=${via} mode=group-encrypted sessions=${gSessions.length}${endpoint.type === 'ssh' ? ' endpoint=ssh:' + endpoint.host : ''}`);
          return req;
        } catch (e) {
          if (e.unavailable || e.code === 'ENDPOINT_CONFIG') { // gateway down / ssh failure / its Blaze down / disabled
            if (e.retryable && ++epTries < EP_TRIES) {
              const wait = Math.min(10000, 1000 * 2 ** (epTries - 1));
              log(`reply gateway endpoint unavailable code=${e.code} try=${epTries}/${EP_TRIES} wait=${wait}`); await sleep(wait); continue;
            }
            log(`reply gateway endpoint unavailable code=${e.code} -> giving up (no second Blaze connection; nothing sent for msg=${it.id})`);
            const f = new Error(`gateway send endpoint unavailable (${e.message}); group messages need the gateway's connection. Nothing sent for this message.`);
            f.code = 'ENDPOINT_UNAVAILABLE'; f.endpointCode = e.code; throw f;
          }
          const { code, transient } = errInfo(e);
          if (code === 20140 && !refreshed) {
            refreshed = true;
            try {
              const r = await loadGroup(true);
              if (r.missing.length) { fallback(`member_without_pubkey users=${r.missing.join(',')} (after refresh)`); continue; }
              log(`reply group sessions refreshed code=20140 sessions=${gSessions.length}, retrying encrypted once`);
              continue;
            } catch (e2) { fallback(`session_refresh_failed err=${e2.message}`); continue; }
          }
          if (transient && ++blazeTries < BLAZE_TRIES) {
            const wait = Math.min(30000, 1000 * 2 ** (blazeTries - 1));
            log(`reply retry code=${code} wait=${wait} via=${via}`); await sleep(wait); continue;
          }
          fallback(`group_send_rejected code=${code}${e.extra && e.extra.field ? ' field=' + e.extra.field : ''}`);
          continue;
        }
      }
      // mode === 'private': old pre-fix behaviour, encrypted only
      await privateSessions(privRefreshed);
      const req = await buildEnc(it, quote, 'private');
      try {
        const r = await api.request({ method: 'POST', url: '/encrypted_messages', data: [req] });
        const st = Array.isArray(r) && r[0] ? r[0].state : undefined;
        if (st && st !== 'SUCCESS') { const err = new Error(`encrypted state=${st}`); err.code = 'ENC_' + st; throw err; }
        log(`reply sent msg=${it.id} conv=${o.conversation} cat=${req.category} via=rest mode=private-encrypted recipient_id=${o.user}`);
        return req;
      } catch (e) {
        const { code, transient } = errInfo(e);
        if (transient && ++privTries < 6) { const wait = Math.min(30000, 1000 * 2 ** (privTries - 1)); log(`reply retry code=${code} wait=${wait} via=rest-private`); await sleep(wait); continue; }
        if (code === 'ENC_FAILED' && !privRefreshed) { privRefreshed = true; log('reply private sessions refreshed code=ENC_FAILED, retrying encrypted once'); continue; }
        const f = new Error(`private encrypted fallback failed (${e.message}); nothing sent plain`); f.code = code; throw f;
      }
    }
  }
  async function sendOne(it, quote) {
    let useEnc = !!(sessions && it.enc), encRefreshed = false;
    let req;
    try { req = await build(it, useEnc, quote); }
    catch (e) { if (!useEnc) throw e; log(`reply encrypt unavailable, sending plain err=${e.message}`); useEnc = false; req = await build(it, false, quote); }
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        if (req.category.startsWith('ENCRYPTED_')) {
          // Encrypted messages must go to /encrypted_messages (as in the Go SDK); /messages answers 403.
          const r = await api.request({ method: 'POST', url: '/encrypted_messages', data: [req] });
          const st = Array.isArray(r) && r[0] ? r[0].state : undefined;
          if (st && st !== 'SUCCESS') { const err = new Error(`encrypted state=${st}`); err.code = 'ENC_' + st; throw err; }
        } else await api.message.sendOne(req);
        log(`reply sent msg=${it.id} conv=${o.conversation} cat=${req.category}`);
        return req;
      } catch (e) {
        const code = e.code || e.status || (e.response && e.response.status);
        const httpStatus = e.response && e.response.status; // axios reports HTTP 429/5xx as ERR_BAD_REQUEST/ERR_BAD_RESPONSE
        if (code === 429 || code === 500 || code === 'ECONNRESET' || code === 'ETIMEDOUT' || httpStatus === 429 || httpStatus >= 500) {
          const wait = Math.min(30000, 1000 * 2 ** attempt);
          log(`reply retry code=${code} attempt=${attempt} wait=${wait}`);
          await sleep(wait); continue;
        }
        if (useEnc && !encRefreshed) { // as mixin_bot post_encrypted_messages: FAILED -> drop cached sessions, refetch, retry once
          encRefreshed = true;
          try {
            sessions = await contactSessions(true);
            req = await build(it, true, quote);
            log(`reply contact sessions refreshed code=${code} sessions=${sessions.length}, retrying encrypted once`);
            attempt--; continue;
          } catch (e2) { log(`reply contact session refresh failed err=${e2.message}`); }
        }
        if (useEnc) { // encrypted send rejected (e.g. checksum/session mismatch) -> plain once
          log(`reply encrypted rejected code=${code}, falling back to plain`);
          useEnc = false; req = await build(it, false, quote); attempt--; continue;
        }
        e.code = code; throw e;
      }
    }
    const g = new Error('GAVE UP'); g.gaveUp = true; throw g;
  }
  const sent = [];
  // ssh: endpoint -> the gateway runs on another host: mirror what we sent into ITS sent-log / context store (best effort).
  const remoteRecords = [];
  async function flushRemote() {
    if (!remoteRecords.length || !endpoint || endpoint.type !== 'ssh') return;
    try { const r = await sendEp.recordViaEndpoint(remoteRecords.splice(0), { endpoint }); log(`reply record remote items=${r.recorded} context=${r.context} endpoint=ssh:${endpoint.host}`); }
    catch (e) { log(`WARN reply record remote failed code=${e.code} (reply was sent; gateway host misses it in sent-log/context)`); }
  }
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const req = isContact ? await sendOne(it, i === 0 ? o.quote : undefined) : await sendGroupOrPrivate(it, i === 0 ? o.quote : undefined);
      sent.push({ kind: it.kind, message_id: it.id, category: req.category, ...(it.attachment ? { attachment_id: ctx.lastAttachment } : {}) });
      // Local sent-log (ids + category only): lets --recall verify that a message is ours.
      try { require('./sent-log').record({ message_id: it.id, conversation_id: o.conversation, category: req.category, via: isContact ? 'contact' : mode }); }
      catch (e) { log(`WARN sent-log record failed err=${e.message}`); }
      const ctxOn = /^(1|true|yes|on)$/i.test(process.env.MIXIN_WEBHOOK_CONTEXT || '');
      remoteRecords.push({ message_id: it.id, conversation_id: o.conversation, category: req.category, via: isContact ? 'contact' : mode,
        ...(ctxOn && typeof it.summary === 'string' ? { context: { text: it.summary.slice(0, 8000), created_at: new Date().toISOString() } } : {}) });
      // Optional hook (MIXIN_WEBHOOK_CONTEXT=1): record our own reply in the per-conversation context store.
      try {
        const cs = require('./context-store');
        if (cs.enabled()) cs.append({ conversation_id: o.conversation, user_id: keystore.app_id, message_id: it.id, text: it.summary, created_at: new Date().toISOString(), from_bot: true });
      } catch (e) { log(`WARN context record failed err=${e.message}`); }
    }
  } catch (e) {
    closeBlaze();
    await flushRemote();
    for (const d of ctx.cleanup) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    if (e.gaveUp) { log('reply GAVE UP after retries'); process.exit(1); }
    log(`reply FAILED code=${e.code} err=${e.message}`);
    console.error(JSON.stringify({ ok: false, code: e.code, error: e.message, ...(items.length > 1 ? { sent } : {}) })); process.exit(1);
  }
  closeBlaze();
  await flushRemote();
  for (const d of ctx.cleanup) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  const first = sent[0];
  const mOut = mentions ? { mentions: mentions.map((m) => ({ user_id: m.user_id, identity_number: m.identity_number })) } : {};
  if (items.length === 1 && first.kind === 'text') console.log(JSON.stringify({ ok: true, message_id: first.message_id, category: first.category, ...mOut }));
  else console.log(JSON.stringify({ ok: true, message_id: first.message_id, category: first.category, messages: sent, ...mOut }));
})();
