'use strict';
// Step 2: structured inbound parsing. Legacy `text` must equal the OLD gateway toText() for every category.
const crypto = require('crypto');
const { parseMessage } = require('./message-parse');
const mc = require('./mixin-crypto');
const { check, finish, fakeKeystore, blazeMsg, encryptFor, uuid } = require('./test-helpers');

// ---- reference: old toText() copied verbatim from gateway.js.bak-s2 ----
const OLD_PLACEHOLDER = {
  PLAIN_IMAGE: '[收到图片]', PLAIN_STICKER: '[收到表情]', PLAIN_AUDIO: '[收到语音]',
  PLAIN_VIDEO: '[收到视频]', PLAIN_DATA: '[收到文件]', PLAIN_CONTACT: '[收到联系人名片]',
  PLAIN_LOCATION: '[收到位置]', PLAIN_LIVE: '[收到直播]', PLAIN_TRANSCRIPT: '[收到聊天记录]',
  APP_CARD: '[收到卡片]', APP_BUTTON_GROUP: '[收到按钮]', MESSAGE_RECALL: '[消息已撤回]',
  MESSAGE_PIN: '[置顶消息]',
};
const ks = fakeKeystore(); const seed = mc.seedFromKeystore(ks);
const rawData = (msg) => Buffer.from(String(msg.data ?? ''), 'base64');
function oldToText(msg) {
  let c = msg.category || '';
  let buf = null;
  if (c.startsWith('ENCRYPTED_')) {
    try { buf = mc.decryptMessageData(msg.data, ks.session_id, seed); c = 'PLAIN_' + c.slice(10); }
    catch (e) { return { category: msg.category, text: '[加密消息，暂不支持]' }; }
  }
  if (c === 'PLAIN_TEXT' || c === 'PLAIN_POST') return { category: c, text: (buf || rawData(msg)).toString('utf8') };
  return { category: c, text: OLD_PLACEHOLDER[c] || `[收到消息: ${c}]` };
}
const opts = { decrypt: (d) => mc.decryptMessageData(d, ks.session_id, seed) };
const U = uuid(), C = uuid();
const mk = (category, data, extra = {}) => blazeMsg({ category, data, user_id: U, conversation_id: C, ...extra });
const encMk = (category, obj, extra) => mk(category, mc.b64urlDecode(encryptFor(typeof obj === 'string' ? obj : JSON.stringify(obj), ks)), extra);

const key = crypto.randomBytes(64).toString('base64'), digest = crypto.randomBytes(32).toString('base64');
const img = { attachment_id: uuid(), mime_type: 'image/jpeg', width: 800, height: 600, size: 123456, thumbnail: 'AAAA' };
const fx = {
  text: mk('PLAIN_TEXT', '你好 world', { quote_message_id: 'q-1' }),
  post: mk('PLAIN_POST', '# 标题\n- a'),
  image: mk('PLAIN_IMAGE', img),
  encImage: encMk('ENCRYPTED_IMAGE', { ...img, key, digest }),
  video: mk('PLAIN_VIDEO', { attachment_id: uuid(), mime_type: 'video/mp4', width: 1280, height: 720, size: 3_300_000, duration: 12400, thumbnail: 'x'.repeat(20000) }),
  audio: mk('PLAIN_AUDIO', { attachment_id: uuid(), mime_type: 'audio/ogg', size: 9000, duration: 5300, waveform: 'AQID' }),
  data: mk('PLAIN_DATA', { attachment_id: uuid(), mime_type: 'application/pdf', size: 120000, name: 'a.pdf' }),
  sticker: mk('PLAIN_STICKER', { sticker_id: uuid(), album_id: uuid(), name: 'hi' }),
  contact: mk('PLAIN_CONTACT', { user_id: uuid() }),
  location: mk('PLAIN_LOCATION', { latitude: 39.9, longitude: 116.4, name: '北京', address: '天安门' }),
  card: mk('APP_CARD', { app_id: uuid(), title: 'T', description: 'D', icon_url: 'https://x/i.png', action: 'https://x', shareable: true }),
  buttons: mk('APP_BUTTON_GROUP', [{ label: 'A', color: '#ff0000', action: 'https://a' }, { label: 'B', color: '#00ff00', action: 'input:b' }]),
  live: mk('PLAIN_LIVE', { url: 'https://live/x.m3u8', thumb_url: 'https://t', width: 640, height: 360 }),
  transcript: mk('PLAIN_TRANSCRIPT', [{ transcript_id: 't', message_id: 'm1', user_id: U, user_full_name: '张三', category: 'PLAIN_TEXT', content: 'hello', created_at: 'x' }, { transcript_id: 't', message_id: 'm2', user_full_name: '李四', category: 'PLAIN_IMAGE', content: uuid(), media_name: 'p.jpg', media_key: 'SECRETKEY', media_digest: 'SECRETDIG' }]),
  recall: mk('MESSAGE_RECALL', { message_id: 'recalled-1' }),
  pin: mk('MESSAGE_PIN', { action: 'PIN', message_ids: ['a', 'b'] }),
  sys: mk('SYSTEM_CONVERSATION', { action: 'ADD', participant_id: uuid(), user_id: U }),
  snap: mk('SYSTEM_ACCOUNT_SNAPSHOT', { type: 'transfer', snapshot_id: uuid(), asset_id: uuid(), amount: '1.5', memo: 'm' }),
  encText: encMk('ENCRYPTED_TEXT', '加密 hi'),
  encPost: encMk('ENCRYPTED_POST', '**bold**'),
  encLoc: encMk('ENCRYPTED_LOCATION', { latitude: 1, longitude: 2 }),
  encSticker: encMk('ENCRYPTED_STICKER', { sticker_id: uuid() }),
  encContact: encMk('ENCRYPTED_CONTACT', { user_id: uuid() }),
  encData: encMk('ENCRYPTED_DATA', { attachment_id: uuid(), mime_type: 'text/plain', size: 3, name: 'x.txt', key, digest }),
  encBroken: mk('ENCRYPTED_TEXT', crypto.randomBytes(200)),
  signal: mk('SIGNAL_TEXT', crypto.randomBytes(40)),
  unknown: mk('PLAIN_FUTURE_THING', { a: 1 }),
  garbage: mk('PLAIN_IMAGE', 'not json'),
  nodata: { ...mk('PLAIN_TEXT', ''), data: undefined },
};
for (const [n, msg] of Object.entries(fx)) {
  const o = oldToText(msg), p = parseMessage(msg, opts);
  check(`legacy text/category identical: ${n}`, o.text === p.text && o.category === p.category, { o, p: { text: p.text, category: p.category } });
}
const P = (n) => parseMessage(fx[n], opts);
const all = Object.keys(fx).map((n) => JSON.stringify(P(n).fields)).join('\n');
check('no key/digest/media_key anywhere in fields', !all.includes(key) && !all.includes(digest) && !/SECRETKEY|SECRETDIG|"key"|"digest"/.test(all));
check('encrypted image: key/digest kept private', P('encImage').priv.key === key && P('encImage').priv.digest === digest && P('encImage').fields.attachment.encrypted === true);
check('quote_message_id', P('text').fields.quote_message_id === 'q-1');
check('image fields + display', JSON.stringify(P('image').fields.attachment) === JSON.stringify({ attachment_id: img.attachment_id, mime_type: 'image/jpeg', size: 123456, width: 800, height: 600, thumbnail: 'AAAA' }) && P('image').display === '[图片 800x600 image/jpeg 121KB]', P('image'));
check('video duration + oversized thumbnail dropped', P('video').fields.attachment.duration === 12400 && !P('video').fields.attachment.thumbnail && P('video').fields.attachment.thumbnail_truncated && P('video').display === '[视频 12s 1280x720 video/mp4 3.1MB]', P('video').display);
check('audio', P('audio').display === '[语音 5s audio/ogg]' && P('audio').fields.attachment.has_waveform, P('audio').display);
check('data/file', P('data').display === '[文件 a.pdf application/pdf 117KB]' && P('data').fields.attachment.name === 'a.pdf', P('data').display);
check('sticker', P('sticker').fields.sticker.name === 'hi' && P('sticker').display === '[表情 hi]');
check('contact (no lookup)', P('contact').fields.contact.user_id && P('contact').display.startsWith('[联系人 '));
check('location', P('location').display === '[位置 北京 天安门 39.9,116.4]' && P('location').fields.location.latitude === 39.9, P('location').display);
check('app card', P('card').fields.app_card.title === 'T' && P('card').display === '[卡片 T：D] https://x', P('card').display);
check('buttons', P('buttons').fields.buttons.length === 2 && P('buttons').display === '[按钮 A | B]');
check('live', P('live').fields.live.url === 'https://live/x.m3u8');
check('transcript', P('transcript').fields.transcript_count === 2 && P('transcript').display === '[聊天记录 2条]\n张三: hello\n李四: [image p.jpg]' && P('transcript').fields.transcript[1].content === undefined, P('transcript').display);
check('recall', P('recall').fields.recalled_message_id === 'recalled-1' && P('recall').display === '[消息已撤回 recalled-1]');
check('pin', P('pin').display === '[置顶消息 PIN 2条]');
check('system conversation', P('sys').fields.system.action === 'ADD' && /^\[系统 ADD participant=/.test(P('sys').display));
check('snapshot', P('snap').fields.system.amount === '1.5' && P('snap').display.startsWith('[转账 1.5'));
check('encrypted text decrypted', P('encText').category === 'PLAIN_TEXT' && P('encText').text === '加密 hi');
check('encrypted location/sticker/contact/data parsed', P('encLoc').fields.location.longitude === 2 && P('encSticker').fields.sticker.sticker_id && P('encContact').fields.contact.user_id && P('encData').fields.attachment.name === 'x.txt' && P('encData').priv.key === key);
check('broken encrypted -> placeholder + decrypt_error', P('encBroken').text === '[加密消息，暂不支持]' && P('encBroken').fields.decrypt_error === true && P('encBroken').category === 'ENCRYPTED_TEXT');
check('signal unsupported', P('signal').fields.unsupported === 'SIGNAL');
check('garbage JSON -> parse_error, no crash', P('garbage').fields.parse_error === true && P('garbage').display.startsWith('[图片'));
finish('parse');
