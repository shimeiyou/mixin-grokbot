'use strict';

const { UUID, USAGE, UsageError, checkHelpExit, parseArgs, readStdin } = require('./reply-args');
checkHelpExit();

require('./ws-shim');
const fs = require('fs');
const { MixinApi, base64RawURLEncode } = require('@mixin.dev/mixin-node-sdk');
const { log, loadKeystore, sleep } = require('./common');
const { bad, buildItems } = require('./reply-items');
const { createTransport } = require('./reply-send');
const sendEp = require('./send-endpoint');

function createUploadCtx(api) {
  return {
    cleanup: [],
    upload: async (buf, enc) => {
      const { encryptAttachment } = require('./attachment-crypto');
      const a = await api.attachment.create();
      if (!a || !a.upload_url) throw new Error('POST /attachments returned no upload_url');
      let body = buf;
      let extra = {};
      if (enc) {
        const e = encryptAttachment(buf);
        body = e.data;
        extra = { key: e.key.toString('base64'), digest: e.digest.toString('base64') };
      }
      const r = await fetch(a.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'x-amz-acl': 'public-read' },
        body,
        signal: AbortSignal.timeout(300000),
      });
      if (!r.ok) {
        const err = new Error(`attachment upload status ${r.status}`);
        err.code = r.status >= 500 ? 500 : r.status;
        throw err;
      }
      log(`reply attachment uploaded id=${a.attachment_id} bytes=${body.length} encrypted=${!!enc}`);
      return { attachment_id: a.attachment_id, extra };
    },
  };
}

async function resolveMentions(o, text, keystore, api) {
  if (!o.mention) return { mentions: null, text };
  let mentions = null;
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
    if (e instanceof UsageError) {
      console.error(JSON.stringify({ ok: false, code: 'usage', error: e.message }));
      console.error(USAGE);
      process.exit(2);
    }
    throw e;
  }
  for (const m of mentions) {
    let u = null;
    try {
      u = await api.user.fetch(m.user_id);
    } catch (e) {
      log(`reply FAILED mention lookup user=${m.user_id} err=${e.message}`);
      console.error(JSON.stringify({ ok: false, code: e.code || 'MENTION_LOOKUP_FAILED', error: `--mention: user lookup failed for ${m.user_id} (${e.message}); nothing sent` }));
      process.exit(1);
    }
    if (!u || !/^\d{4,}$/.test(String(u.identity_number || ''))) {
      console.error(JSON.stringify({ ok: false, code: 'MENTION_LOOKUP_FAILED', error: `--mention: no identity_number for ${m.user_id}; nothing sent` }));
      process.exit(1);
    }
    m.identity_number = String(u.identity_number);
  }
  const missing = mentions.filter((m) => !new RegExp(`@${m.identity_number}(?!\\d)`).test(text));
  if (missing.length) {
    text = missing.map((m) => `@${m.identity_number} `).join('') + text;
  }
  log(`reply mention users=${mentions.map((m) => m.user_id).join(',')} prefixed=${missing.length}`);
  return { mentions, text };
}

function cleanTempDirs(dirs) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'ENOENT') log(`WARN temp dir cleanup failed err=${e.message}`);
    }
  }
}

(async () => {
  const o = parseArgs();
  if (o['check-encryption']) {
    process.exit(await require('./check-encryption').main(['--conversation', o.conversation]));
  }
  if (o.recall) {
    if (o._order.length || o.quote != null || o.mention) {
      console.error(JSON.stringify({ ok: false, code: 'usage', error: '--recall cannot be combined with content flags, --quote or --mention' }));
      console.error(USAGE);
      process.exit(2);
    }
    if (!o.conversation) {
      console.error(JSON.stringify({ ok: false, code: 'usage', error: '--recall needs --conversation' }));
      console.error(USAGE);
      process.exit(2);
    }
    const keystore = loadKeystore();
    const API_BASE = process.env.MIXIN_API_BASE || '';
    const api = MixinApi(API_BASE ? { keystore, requestConfig: { baseURL: API_BASE } } : { keystore });
    process.exit(await require('./recall').runRecall({ o, api, keystore, log, sleep, base64RawURLEncode }));
  }

  const extras = o._order.filter((k) => k !== 'text');
  let text = o.text;
  if (!extras.length) {
    if (text === undefined || text === '-') text = (await readStdin()).replace(/\s+$/, '');
  } else if (text === '-') {
    text = (await readStdin()).replace(/\s+$/, '');
  }
  if (!o.conversation || !o['reply-to'] || (!text && !extras.length)) {
    console.error(USAGE);
    process.exit(2);
  }

  const keystore = loadKeystore();
  const API_BASE = process.env.MIXIN_API_BASE || '';
  const api = MixinApi(API_BASE ? { keystore, requestConfig: { baseURL: API_BASE } } : { keystore });
  const ctx = createUploadCtx(api);

  const resolved = await resolveMentions(o, text, keystore, api);
  text = resolved.text;
  const mentions = resolved.mentions;

  let items;
  try {
    items = buildItems(o, text, mentions, keystore.app_id, ctx);
  } catch (e) {
    if (e && e.code === 'ATTACH_PATH_DENIED') {
      log(`reply refused code=ATTACH_PATH_DENIED conv=${o.conversation} (nothing sent)`);
      console.error(JSON.stringify({ ok: false, code: 'ATTACH_PATH_DENIED', error: e.message }));
      process.exit(2);
    }
    if (e instanceof UsageError) {
      console.error(JSON.stringify({ ok: false, code: 'usage', error: e.message }));
      console.error(USAGE);
      process.exit(2);
    }
    throw e;
  }

  const transport = await createTransport({ o, items, mentions, api, keystore });
  const sent = [];
  const remoteRecords = [];

  async function flushRemote() {
    if (!remoteRecords.length || !transport.endpoint || transport.endpoint.type !== 'ssh') return;
    try {
      const r = await sendEp.recordViaEndpoint(remoteRecords.splice(0), { endpoint: transport.endpoint });
      log(`reply record remote items=${r.recorded} context=${r.context} endpoint=ssh:${transport.endpoint.host}`);
    } catch (e) {
      log(`WARN reply record remote failed code=${e.code} (reply was sent; gateway host misses it in sent-log/context)`);
    }
  }

  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const req = await transport.sendItem(it, i === 0 ? o.quote : undefined);
      const via = transport.getMode();
      sent.push({
        kind: it.kind,
        message_id: it.id,
        category: req.category,
        ...(it.attachment ? { attachment_id: ctx.lastAttachment } : {}),
      });
      try {
        require('./sent-log').record({ message_id: it.id, conversation_id: o.conversation, category: req.category, via });
      } catch (e) {
        log(`WARN sent-log record failed err=${e.message}`);
      }
      const ctxOn = /^(1|true|yes|on)$/i.test(process.env.MIXIN_WEBHOOK_CONTEXT || '');
      remoteRecords.push({
        message_id: it.id,
        conversation_id: o.conversation,
        category: req.category,
        via,
        ...(ctxOn && typeof it.summary === 'string'
          ? { context: { text: it.summary.slice(0, 8000), created_at: new Date().toISOString() } }
          : {}),
      });
      try {
        const cs = require('./context-store');
        if (cs.enabled()) {
          cs.append({
            conversation_id: o.conversation,
            user_id: keystore.app_id,
            message_id: it.id,
            text: it.summary,
            created_at: new Date().toISOString(),
            from_bot: true,
          });
        }
      } catch (e) {
        log(`WARN context record failed err=${e.message}`);
      }
    }
  } catch (e) {
    await flushRemote();
    cleanTempDirs(ctx.cleanup);
    if (e.gaveUp) {
      log('reply GAVE UP after retries');
      process.exit(1);
    }
    log(`reply FAILED code=${e.code} err=${e.message}`);
    console.error(JSON.stringify({ ok: false, code: e.code, error: e.message, ...(items.length > 1 ? { sent } : {}) }));
    process.exit(1);
  }

  await flushRemote();
  cleanTempDirs(ctx.cleanup);
  const first = sent[0];
  const mOut = mentions ? { mentions: mentions.map((m) => ({ user_id: m.user_id, identity_number: m.identity_number })) } : {};
  if (items.length === 1 && first.kind === 'text') {
    console.log(JSON.stringify({ ok: true, message_id: first.message_id, category: first.category, ...mOut }));
  } else {
    console.log(JSON.stringify({ ok: true, message_id: first.message_id, category: first.category, messages: sent, ...mOut }));
  }
})();
