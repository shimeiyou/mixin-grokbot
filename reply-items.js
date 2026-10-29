'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { v5: uuidv5 } = require('uuid');
const { log } = require('./common');
const { UUID, UsageError } = require('./reply-args');

const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const ACTION = /^(https?:\/\/|mixin:\/\/|input:)\S+$/;
const MAX_UPLOAD = parseInt(process.env.MIXIN_UPLOAD_MAX_BYTES || String(100 << 20), 10);

const bad = (m) => {
  throw new UsageError(m);
};

const looksMarkdown = (t) =>
  t.length > 500 ||
  /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\|.*\|/.test(t);

function jsonArg(v, what) {
  if (v == null || v === '') bad(`--${what} needs a value`);
  const s = String(v).startsWith('@') ? fs.readFileSync(String(v).slice(1), 'utf8') : String(v);
  try {
    return JSON.parse(s);
  } catch (e) {
    return bad(`--${what}: invalid JSON (${e.message})`);
  }
}

function textItem(text, forceText = false) {
  const cat = !forceText && looksMarkdown(text) ? 'PLAIN_POST' : 'PLAIN_TEXT';
  return {
    kind: 'text',
    type: cat.slice(6),
    enc: true,
    summary: text,
    data: async () => Buffer.from(text, 'utf8'),
  };
}

function jsonItem(kind, type, obj, enc, summary) {
  return {
    kind,
    type,
    enc,
    summary,
    data: async () => Buffer.from(JSON.stringify(obj)),
  };
}

function stickerItem(v) {
  if (!UUID.test(v || '')) bad('--sticker needs a sticker_id (uuid)');
  return jsonItem('sticker', 'STICKER', { sticker_id: v }, true, '[表情]');
}

function contactItem(v) {
  if (!UUID.test(v || '')) bad('--contact needs a user_id (uuid)');
  return jsonItem('contact', 'CONTACT', { user_id: v }, true, `[联系人 ${v}]`);
}

function locationItem(v) {
  let l;
  if (String(v || '').trim().startsWith('{')) {
    l = jsonArg(v, 'location');
  } else {
    const p = String(v || '').split(',');
    l = { latitude: Number(p[0]), longitude: Number(p[1]) };
    if (p[2]) l.name = p[2].trim();
    if (p.length > 3) l.address = p.slice(3).join(',').trim();
  }
  l.latitude = Number(l.latitude);
  l.longitude = Number(l.longitude);
  if (!(Math.abs(l.latitude) <= 90) || !(Math.abs(l.longitude) <= 180) || String(v).trim() === '') {
    bad('--location needs "lat,lng[,name[,address]]" with -90<=lat<=90, -180<=lng<=180');
  }
  const obj = { latitude: l.latitude, longitude: l.longitude };
  if (l.name) obj.name = String(l.name);
  if (l.address) obj.address = String(l.address);
  const label = obj.name ? ' ' + obj.name : '';
  return jsonItem('location', 'LOCATION', obj, true, `[位置${label} ${obj.latitude},${obj.longitude}]`);
}

function validButtons(b, what, { max = 6 } = {}) {
  if (!Array.isArray(b) || b.length < 1 || b.length > max) {
    const limit = max === Infinity ? 'at least 1 button' : '1..' + max + ' buttons';
    bad(`--${what} must be a JSON array of ${limit}`);
  }
  return b.map((x, i) => {
    if (!x || typeof x.label !== 'string' || !x.label) bad(`--${what}[${i}] needs a "label"`);
    if (!ACTION.test(x.action || '')) bad(`--${what}[${i}] needs "action" (https://…, mixin://… or input:…)`);
    const color = x.color == null ? '#000000' : String(x.color);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) bad(`--${what}[${i}] color must look like #RRGGBB`);
    return { label: x.label, color, action: x.action };
  });
}

// iOS AppCardData.swift: non-empty "action" forces V0 and ignores "actions"; V1 requires "shareable".
function cardItem(v, botId) {
  const c = jsonArg(v, 'card');
  if (!c || typeof c !== 'object' || Array.isArray(c)) bad('--card must be a JSON object');
  const card = { app_id: botId, ...c };
  if (card.app_id !== botId) bad("--card app_id must be the bot's own app_id (omit it to use the default)");
  if (card.shareable == null) card.shareable = true;
  if (typeof card.shareable !== 'boolean') bad('--card "shareable" must be true or false');
  const hasAction = card.action != null && card.action !== '';
  if (hasAction && card.actions != null) {
    bad('--card: use either "action" (legacy card) or "actions" (new card), not both — iOS ignores "actions" when "action" is set');
  }
  const str = (k) =>
    card[k] != null && card[k] !== '' && typeof card[k] !== 'string'
      ? bad(`--card "${k}" must be a string`)
      : card[k] || '';
  const title = str('title');
  const description = str('description');
  let gen;
  if (hasAction) {
    gen = 'v0';
    for (const k of ['title', 'description']) {
      if (!card[k]) bad(`--card needs a non-empty "${k}" (legacy card with "action")`);
    }
    if (!/^https:\/\//.test(card.icon_url || '')) bad('--card needs "icon_url" (https URL) (legacy card with "action")');
    if (!ACTION.test(card.action)) bad('--card "action" must be https://…, mixin://… or input:…');
  } else {
    gen = 'v1';
    const hasCover = !!(card.cover_url || (card.cover && card.cover.url));
    const noButtons = card.actions == null || (Array.isArray(card.actions) && card.actions.length === 0);
    if (noButtons && !hasCover) {
      bad('--card needs "action" (legacy card) or "actions" (new card: [{label, action, color?}]); a new card without buttons needs "cover_url" or "cover"');
    }
    card.actions = noButtons ? [] : validButtons(card.actions, 'card.actions', { max: Infinity });
    if (!title && !description) bad('--card (new card) needs a "title" or a "description"');
    if (card.cover_url != null && !/^https:\/\//.test(card.cover_url)) bad('--card "cover_url" must be an https URL');
    if (card.cover != null && (typeof card.cover !== 'object' || Array.isArray(card.cover) || !/^https:\/\//.test(card.cover.url || ''))) {
      bad('--card "cover" must be an object with an https "url"');
    }
    if (card.icon_url != null && !/^https:\/\//.test(card.icon_url)) bad('--card "icon_url" must be an https URL');
  }
  if ([...title].length > 36) log('WARN card title >36 chars; Mixin clients may truncate it');
  if ([...description].length > 1024) log('WARN card description >1024 chars; Mixin clients may truncate or reject it');
  const acts = hasAction ? [card.action] : card.actions.map((x) => x.action);
  if (!hasAction && !card.actions.length) {
    log('WARN card has no buttons and no "action": tapping the card does nothing (URLs in the description are tappable on Android only)');
  }
  if (acts.some((x) => /^input:/.test(x))) log('WARN card has an input: action; iOS cannot forward such a card');
  if (acts.some((x) => x === 'input:share')) log('WARN card action "input:share" does not exist in Mixin clients; it just sends the text "share"');
  if (acts.some((x) => /^[a-z]+:\/\/mixin\.one\/send/i.test(x))) log('WARN card has a mixin.one/send action; Desktop cannot forward such a card');
  return {
    ...jsonItem('card', 'APP_CARD', card, false, `[卡片 ${title || description}：${description || title}]`),
    cardGen: gen,
  };
}

function buttonsItem(v) {
  const b = validButtons(jsonArg(v, 'buttons'), 'buttons');
  return jsonItem('buttons', 'APP_BUTTON_GROUP', b, false, `[按钮 ${b.map((x) => x.label).join(' | ')}]`);
}

function attachmentItem(kind, p, o, ctx) {
  const mi = require('./media-info');
  if (!p) bad(`--${kind} needs a file path`);
  const chk = require('./attach-guard').checkAttachPath(p, { flag: kind });
  if (chk.missing) bad(`--${kind}: file not found: ${p}`);
  const shownName = path.basename(p);
  p = chk.real;
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    bad(`--${kind}: file not found: ${p}`);
  }
  if (!st.isFile()) bad(`--${kind}: not a regular file: ${p}`);
  if (st.size === 0) bad(`--${kind}: empty file`);
  if (st.size > MAX_UPLOAD) bad(`--${kind}: file is ${st.size} bytes, limit MIXIN_UPLOAD_MAX_BYTES=${MAX_UPLOAD}`);
  let file = p;
  let buf = fs.readFileSync(p);
  const meta = {};
  const type = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', file: 'DATA' }[kind];
  if (kind === 'image') {
    const m = mi.sniffMime(buf);
    if (!m || !m.startsWith('image/')) bad('--image: not a recognised image (jpeg/png/gif/webp); use --file to send it as a file');
    const sz = mi.imageSize(buf) || mi.probe(p);
    if (!sz || !sz.width || !sz.height) bad('--image: could not read width/height; use --file');
    Object.assign(meta, { mime_type: m, width: sz.width, height: sz.height, size: buf.length });
    const th = mi.thumbnailB64(p);
    if (th && th.length < 16384) meta.thumbnail = th;
  } else if (kind === 'video') {
    const pr = mi.probe(p);
    if (!pr || !pr.width || !pr.height) bad('--video: ffprobe could not read the video (is ffprobe installed?)');
    Object.assign(meta, { mime_type: mi.sniffMime(buf) || mi.mimeForPath(p), width: pr.width, height: pr.height, size: buf.length, duration: pr.duration_ms });
    const th = mi.thumbnailB64(p);
    if (th && th.length < 16384) meta.thumbnail = th;
  } else if (kind === 'audio') {
    let pr = mi.probe(p);
    if (!(mi.sniffMime(buf) === 'audio/ogg' && pr && pr.audio_codec === 'opus')) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-audio-'));
      fs.chmodSync(dir, 0o700);
      ctx.cleanup.push(dir);
      file = path.join(dir, 'voice.ogg');
      try {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', p, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', file], { timeout: 120000 });
      } catch (e) {
        bad(`--audio: could not convert to ogg/opus with ffmpeg (${String(e.message).split('\n')[0]})`);
      }
      buf = fs.readFileSync(file);
      pr = mi.probe(file);
    }
    Object.assign(meta, { mime_type: 'audio/ogg', size: buf.length, duration: pr ? pr.duration_ms : 0 });
  } else {
    const detectedMime = mi.mimeForPath(p) !== 'application/octet-stream' ? mi.mimeForPath(p) : mi.sniffMime(buf) || 'application/octet-stream';
    Object.assign(meta, { mime_type: detectedMime, size: buf.length, name: o.name || shownName });
  }
  if (o.caption && kind !== 'audio') meta.caption = String(o.caption);
  const summary = `[${{ image: '图片', video: '视频', audio: '语音', file: '文件' }[kind]} ${meta.name || shownName}]`;
  return {
    kind,
    type,
    enc: true,
    summary,
    attachment: true,
    data: async (enc) => {
      const { attachment_id, extra } = await ctx.upload(buf, enc);
      ctx.lastAttachment = attachment_id;
      return Buffer.from(JSON.stringify({ attachment_id, ...extra, ...meta }));
    },
  };
}

function buildItems(o, text, mentions, botId, ctx) {
  if (o.quote != null && !UUID.test(o.quote)) bad('--quote needs a message_id (uuid)');
  const extras = o._order.filter((k) => k !== 'text');
  const order = extras.length ? o._order : ['text'];
  const items = [];
  for (const k of order) {
    if (k === 'text') {
      if (text) items.push(textItem(text, !!mentions));
    } else if (k === 'sticker') {
      items.push(stickerItem(o.sticker));
    } else if (k === 'contact') {
      items.push(contactItem(o.contact));
    } else if (k === 'location') {
      items.push(locationItem(o.location));
    } else if (k === 'card') {
      items.push(cardItem(o.card, botId));
    } else if (k === 'buttons') {
      items.push(buttonsItem(o.buttons));
    } else {
      items.push(attachmentItem(k, o[k], o, ctx));
    }
  }
  const seq = o.seq != null ? `:seq:${o.seq}` : '';
  const counts = {};
  for (const it of items) {
    const n = (counts[it.kind] = (counts[it.kind] ?? -1) + 1);
    it.id = it.kind === 'text' && !seq
      ? uuidv5(`mixin-reply:${o['reply-to']}`, NS)
      : uuidv5(`mixin-reply:${o['reply-to']}${seq}:${it.kind}:${n}`, NS);
  }
  return items;
}

module.exports = {
  bad,
  textItem,
  stickerItem,
  contactItem,
  locationItem,
  cardItem,
  buttonsItem,
  attachmentItem,
  validButtons,
  buildItems,
};
