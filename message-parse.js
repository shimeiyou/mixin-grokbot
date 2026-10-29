'use strict';
const { humanSize } = require('./media-info');

const PLACEHOLDER = {
  PLAIN_IMAGE: '[收到图片]', PLAIN_STICKER: '[收到表情]', PLAIN_AUDIO: '[收到语音]',
  PLAIN_VIDEO: '[收到视频]', PLAIN_DATA: '[收到文件]', PLAIN_CONTACT: '[收到联系人名片]',
  PLAIN_LOCATION: '[收到位置]', PLAIN_LIVE: '[收到直播]', PLAIN_TRANSCRIPT: '[收到聊天记录]',
  APP_CARD: '[收到卡片]', APP_BUTTON_GROUP: '[收到按钮]', MESSAGE_RECALL: '[消息已撤回]',
  MESSAGE_PIN: '[置顶消息]',
};
const ATTACHMENT_TYPES = new Set(['IMAGE', 'VIDEO', 'AUDIO', 'DATA']);
const THUMB_MAX = 16384, TEXT_MAX = 500, TRANSCRIPT_MAX_ITEMS = 50, DISPLAY_MAX = 4000;

const rawData = (msg) => Buffer.from(String(msg.data ?? ''), 'base64');
const json = (buf) => { try { return JSON.parse(buf.toString('utf8')); } catch (_) { return undefined; } };
const str = (v, max = TEXT_MAX) => (v == null ? undefined : String(v).slice(0, max));
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };
const secs = (ms) => `${Math.max(0, Math.round((Number(ms) || 0) / 1000))}s`;
const baseType = (c) => String(c || '').replace(/^(PLAIN|ENCRYPTED|SIGNAL)_/, '');

function attachmentFields(d, encrypted) {
  const a = clean({
    attachment_id: str(d.attachment_id, 64), mime_type: str(d.mime_type, 128), size: num(d.size), name: str(d.name, 255),
    width: num(d.width), height: num(d.height), duration: num(d.duration), caption: str(d.caption, 2000),
    encrypted: encrypted || undefined,
  });
  if (typeof d.thumbnail === 'string' && d.thumbnail) {
    if (d.thumbnail.length <= THUMB_MAX) a.thumbnail = d.thumbnail; else a.thumbnail_truncated = true;
  }
  if (d.waveform != null) a.has_waveform = true;
  return a;
}

function render(type, f, legacyText) {
  const a = f.attachment || {};
  const cap = a.caption ? ` ${a.caption}` : '';
  switch (type) {
    case 'TEXT': case 'POST': return legacyText;
    case 'IMAGE': return `[图片${a.width && a.height ? ` ${a.width}x${a.height}` : ''}${a.mime_type ? ' ' + a.mime_type : ''}${a.size ? ' ' + humanSize(a.size) : ''}]${cap}`;
    case 'VIDEO': return `[视频${a.duration ? ' ' + secs(a.duration) : ''}${a.width && a.height ? ` ${a.width}x${a.height}` : ''}${a.mime_type ? ' ' + a.mime_type : ''}${a.size ? ' ' + humanSize(a.size) : ''}]${cap}`;
    case 'AUDIO': return `[语音${a.duration ? ' ' + secs(a.duration) : ''}${a.mime_type ? ' ' + a.mime_type : ''}]`;
    case 'DATA': return `[文件${a.name ? ' ' + a.name : ''}${a.mime_type ? ' ' + a.mime_type : ''}${a.size ? ' ' + humanSize(a.size) : ''}]${cap}`;
    case 'STICKER': { const s = f.sticker || {}; return `[表情${s.name ? ' ' + s.name : ''}]`; }
    case 'CONTACT': { const c = f.contact || {}; return `[联系人${c.full_name ? ' ' + c.full_name : ''}${c.identity_number ? ` (${c.identity_number})` : ''}${!c.full_name && c.user_id ? ' ' + c.user_id : ''}]`; }
    case 'LOCATION': { const l = f.location || {}; return `[位置${l.name ? ' ' + l.name : ''}${l.address ? ' ' + l.address : ''} ${l.latitude},${l.longitude}]`; }
    case 'LIVE': { const l = f.live || {}; return `[直播${l.url ? ' ' + l.url : ''}]`; }
    case 'APP_CARD': { const c = f.app_card || {}; return `[卡片${c.title ? ' ' + c.title : ''}${c.description ? '：' + c.description : ''}]${c.action ? ' ' + c.action : ''}`; }
    case 'APP_BUTTON_GROUP': return `[按钮 ${(f.buttons || []).map((b) => b.label).join(' | ')}]`;
    case 'TRANSCRIPT': {
      const t = f.transcript || [];
      const lines = t.map((m) => `${m.user_full_name || m.user_id || '?'}: ${m.content != null ? m.content : `[${baseType(m.category).toLowerCase()}${m.media_name ? ' ' + m.media_name : ''}]`}`);
      return `[聊天记录 ${f.transcript_count != null ? f.transcript_count : t.length}条]\n${lines.join('\n')}`.slice(0, DISPLAY_MAX);
    }
    case 'MESSAGE_RECALL': return `[消息已撤回${f.recalled_message_id ? ' ' + f.recalled_message_id : ''}]`;
    case 'MESSAGE_PIN': { const p = f.pin || {}; return `[置顶消息${p.action ? ' ' + p.action : ''}${p.message_ids ? ` ${p.message_ids.length}条` : ''}]`; }
    case 'SYSTEM_CONVERSATION': { const s = f.system || {}; return `[系统 ${s.action || ''}${s.participant_id ? ' participant=' + s.participant_id : ''}${s.role ? ' role=' + s.role : ''}]`; }
    case 'SYSTEM_ACCOUNT_SNAPSHOT': case 'SYSTEM_SAFE_SNAPSHOT': { const s = f.system || {}; return `[转账${s.amount ? ' ' + s.amount : ''}${s.asset_id ? ' asset=' + s.asset_id : ''}${s.memo ? ' memo=' + s.memo : ''}]`; }
    default: return legacyText;
  }
}

function parseMessage(msg, { decrypt, onDecryptError } = {}) {
  const orig = msg.category || '';
  let c = orig, buf = null;
  const fields = {}, priv = {};
  if (msg.quote_message_id) fields.quote_message_id = String(msg.quote_message_id);
  if (c.startsWith('ENCRYPTED_')) {
    try { buf = decrypt(msg.data); c = 'PLAIN_' + c.slice(10); }
    catch (e) {
      if (onDecryptError) onDecryptError(e);
      fields.decrypt_error = true;
      return { category: orig, text: '[加密消息，暂不支持]', display: '[加密消息，暂不支持]', fields, priv, type: baseType(orig) };
    }
  }
  const data = buf || rawData(msg);
  const text = (c === 'PLAIN_TEXT' || c === 'PLAIN_POST') ? data.toString('utf8') : (PLACEHOLDER[c] || `[收到消息: ${c}]`);
  const type = baseType(c);
  if (c.startsWith('SIGNAL_')) return { category: c, text, display: '[加密消息，暂不支持]', fields: { ...fields, unsupported: 'SIGNAL' }, priv, type };
  const d = (type === 'TEXT' || type === 'POST') ? undefined : json(data);
  if (d === undefined && !(type === 'TEXT' || type === 'POST') && data.length) fields.parse_error = true;
  const o = d && typeof d === 'object' ? d : {};
  if (ATTACHMENT_TYPES.has(type)) {
    fields.attachment = attachmentFields(o, orig.startsWith('ENCRYPTED_') || o.key != null);
    if (o.key != null) priv.key = o.key;       // kept private: never sent to the webhook
    if (o.digest != null) priv.digest = o.digest;
  } else if (type === 'STICKER') fields.sticker = clean({ sticker_id: str(o.sticker_id, 64), album_id: str(o.album_id, 64), name: str(o.name, 128) });
  else if (type === 'CONTACT') fields.contact = clean({ user_id: str(o.user_id, 64) });
  else if (type === 'LOCATION') fields.location = clean({ latitude: num(o.latitude), longitude: num(o.longitude), name: str(o.name, 256), address: str(o.address, 512) });
  else if (type === 'LIVE') fields.live = clean({ url: str(o.url, 2048), thumb_url: str(o.thumb_url, 2048), width: num(o.width), height: num(o.height), shareable: o.shareable });
  else if (type === 'APP_CARD') fields.app_card = clean({ app_id: str(o.app_id, 64), title: str(o.title, 256), description: str(o.description, 1024), icon_url: str(o.icon_url, 2048), cover_url: str(o.cover_url, 2048), action: str(o.action, 2048), actions: Array.isArray(o.actions) ? o.actions.slice(0, 10).map((b) => clean({ label: str(b && b.label, 128), color: str(b && b.color, 16), action: str(b && b.action, 2048) })) : undefined, shareable: o.shareable });
  else if (type === 'APP_BUTTON_GROUP') fields.buttons = (Array.isArray(d) ? d : []).slice(0, 10).map((b) => clean({ label: str(b && b.label, 128), color: str(b && b.color, 16), action: str(b && b.action, 2048) }));
  else if (type === 'TRANSCRIPT') {
    const items = Array.isArray(d) ? d : [];
    fields.transcript_count = items.length;
    fields.transcript = items.slice(0, TRANSCRIPT_MAX_ITEMS).map((m) => clean({
      message_id: str(m && m.message_id, 64), user_id: str(m && m.user_id, 64), user_full_name: str(m && m.user_full_name, 128),
      category: str(m && m.category, 64), created_at: str(m && m.created_at, 64),
      content: /_(TEXT|POST)$/.test((m && m.category) || '') ? str(m.content, TEXT_MAX) : undefined,
      media_name: str(m && m.media_name, 255), media_mime_type: str(m && m.media_mime_type, 128), media_size: num(m && m.media_size),
    }));
  } else if (type === 'MESSAGE_RECALL') fields.recalled_message_id = str(o.message_id, 64);
  else if (type === 'MESSAGE_PIN') fields.pin = clean({ action: str(o.action, 32), message_ids: Array.isArray(o.message_ids) ? o.message_ids.slice(0, 100).map((x) => str(x, 64)) : undefined });
  else if (type === 'SYSTEM_CONVERSATION') fields.system = clean({ action: str(o.action, 64), participant_id: str(o.participant_id, 64), user_id: str(o.user_id, 64), role: str(o.role, 32) });
  else if (type === 'SYSTEM_ACCOUNT_SNAPSHOT' || type === 'SYSTEM_SAFE_SNAPSHOT') fields.system = clean({ type: str(o.type, 64), snapshot_id: str(o.snapshot_id, 64), opponent_id: str(o.opponent_id, 64), asset_id: str(o.asset_id, 64), amount: str(o.amount, 64), memo: str(o.memo, 200), trace_id: str(o.trace_id, 64), created_at: str(o.created_at, 64) });
  return { category: c, text, display: render(type, fields, text), fields, priv, type };
}
module.exports = { parseMessage, render, baseType, PLACEHOLDER };
