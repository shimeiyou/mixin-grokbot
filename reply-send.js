'use strict';
const { base64RawURLEncode } = require('@mixin.dev/mixin-node-sdk');
const { log, sleep } = require('./common');
const { encryptMessageData, seedFromKeystore, sessionsChecksum } = require('./mixin-crypto');
const sendEp = require('./send-endpoint');
function errInfo(e) {
  const code = e.code || e.status || (e.response && e.response.status);
  const httpStatus = e.response && e.response.status;
  const apiCode = e.response && e.response.data && e.response.data.error && e.response.data.error.code;
  const transient = code === 429 || code === 500 || code === 'ECONNRESET' || code === 'ETIMEDOUT' || httpStatus === 429 || httpStatus >= 500;
  return { code: apiCode || code, transient };
}
async function postEncrypted(api, req) {
  const r = await api.request({ method: 'POST', url: '/encrypted_messages', data: [req] });
  const st = Array.isArray(r) && r[0] ? r[0].state : undefined;
  if (st && st !== 'SUCCESS') {
    const err = new Error(`encrypted state=${st}`);
    err.code = 'ENC_' + st;
    throw err;
  }
}
async function createTransport({ o, items, mentions, api, keystore }) {
  const { createConvInfo } = require('./conversation-target');
  const conv = createConvInfo({ api, botId: keystore.app_id, log });
  const convCategory = await conv.category(o.conversation, o.user);
  const isContact = convCategory === 'CONTACT';
  const seed = seedFromKeystore(keystore);
  const BLAZE_TRIES = parseInt(process.env.MIXIN_BLAZE_SEND_TRIES || '3', 10);
  const EP_TRIES = Math.max(1, parseInt(process.env.MIXIN_SEND_ENDPOINT_TRIES || '3', 10));
  let endpoint = null;
  let endpointErr = null;
  try { endpoint = sendEp.parseEndpoint(); } catch (e) { endpointErr = e; }
  let mode = 'contact';
  let gSessions = null;
  let gChecksum = null;
  let pSessions = null;
  const fallback = (reason) => {
    if (mode !== 'private') {
      log(`reply FALLBACK reason=${reason} conv=${o.conversation} mode=private-encrypted recipient_id=${o.user || 'none'} (reply visible only to that user)`);
    }
    mode = 'private';
  };
  async function loadGroup(fresh) {
    const g = await conv.groupSessions(o.conversation, { fresh });
    if (g.missing.length) return { missing: g.missing };
    if (!g.sessions.length) return { missing: ['(no member sessions)'] };
    gSessions = g.sessions;
    gChecksum = sessionsChecksum(g.allSessionIds);
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
        if (mentions && gSessions) {
          const members = new Set(gSessions.map((x) => x.user_id));
          const out = mentions.filter((m) => !members.has(m.user_id));
          if (out.length) log(`WARN --mention user not in the group (no member session): ${out.map((m) => m.user_id).join(',')}`);
        }
      } catch (e) { fallback(`session_lookup_failed err=${e.message}`); }
    }
  }
  async function privateSessions(fresh) {
    if (pSessions && !fresh) return pSessions;
    if (!o.user) throw Object.assign(new Error('private encrypted fallback needs --user; nothing sent (never plain in a group)'), { code: 'NO_PRIVATE_TARGET' });
    const raw = (await api.request({ method: 'POST', url: '/sessions/fetch', data: [o.user] })) || [];
    const s = raw.filter((x) => x.session_id && x.public_key);
    if (!s.length) throw Object.assign(new Error('--user has no session with a public key; nothing sent (never plain in a group)'), { code: 'NO_PRIVATE_SESSIONS' });
    pSessions = s;
    return pSessions;
  }
  const wantEnc = o.encrypted || /^ENCRYPTED_/.test(o['incoming-category'] || '');
  let sessions = null;
  async function contactSessions(fresh) {
    let s;
    if (o.user) s = await api.request({ method: 'POST', url: '/sessions/fetch', data: [o.user] });
    else {
      if (fresh) conv.invalidate(o.conversation);
      const c = await conv.conversation(o.conversation, { fresh });
      s = (c.participant_sessions || []).filter((x) => x.user_id !== keystore.app_id);
    }
    s = (s || []).filter((x) => x.session_id && x.public_key);
    if (!s.length) throw new Error('no recipient sessions with public keys');
    return s;
  }
  if (isContact && wantEnc && items.some((it) => it.enc)) {
    try { sessions = await contactSessions(false); }
    catch (e) { log(`reply encrypt unavailable, sending plain err=${e.message}`); sessions = null; }
  }
  async function payload(it, enc) {
    const memo = it._data || (it._data = {});
    const k = enc ? 'e' : 'p';
    if (!memo[k]) memo[k] = await it.data(enc);
    return memo[k];
  }
  async function build(it, enc, quote) {
    const data = await payload(it, enc);
    const prefix = enc ? 'ENCRYPTED_' : it.type.startsWith('APP_') ? '' : 'PLAIN_';
    return {
      conversation_id: o.conversation,
      message_id: it.id,
      category: prefix + it.type,
      data_base64: enc ? encryptMessageData(data, sessions, seed) : base64RawURLEncode(data),
      ...(o.user ? { recipient_id: o.user } : {}),
      ...(enc ? { checksum: sessionsChecksum(sessions.map((s) => s.session_id)), recipient_sessions: sessions.map((s) => ({ session_id: s.session_id })) } : {}),
      ...(quote ? { quote_message_id: quote } : {}),
      ...(o.silent ? { silent: true } : {}),
    };
  }
  async function buildEnc(it, quote, target) {
    const data = await payload(it, true);
    const req = {
      conversation_id: o.conversation,
      message_id: it.id,
      category: 'ENCRYPTED_' + it.type,
      ...(quote ? { quote_message_id: quote } : {}),
      ...(o.silent ? { silent: true } : {}),
    };
    if (target === 'group') {
      req.data_base64 = encryptMessageData(data, gSessions, seed);
      req.conversation_checksum = gChecksum;
      if (mentions && it.kind === 'text') req.mentions = mentions.map((m) => m.user_id);
    } else {
      req.recipient_id = o.user;
      req.data_base64 = encryptMessageData(data, pSessions, seed);
      req.checksum = sessionsChecksum(pSessions.map((s) => s.session_id));
      req.recipient_sessions = pSessions.map((s) => ({ session_id: s.session_id }));
    }
    return req;
  }
  async function sendGroupOrPrivate(it, quote) {
    let refreshed = false;
    let blazeTries = 0;
    let privRefreshed = false;
    let privTries = 0;
    let epTries = 0;
    for (;;) {
      if (mode === 'group') {
        const req = await buildEnc(it, quote, 'group');
        try {
          if (endpointErr) throw endpointErr;
          await sendEp.sendViaEndpoint(req, { endpoint });
          const epTag = endpoint.type === 'ssh' ? ' endpoint=ssh:' + endpoint.host : '';
          log(`reply sent msg=${it.id} conv=${o.conversation} cat=${req.category} via=gateway mode=group-encrypted sessions=${gSessions.length}${epTag}`);
          return req;
        } catch (e) {
          if (e.unavailable || e.code === 'ENDPOINT_CONFIG') {
            if (e.retryable && ++epTries < EP_TRIES) {
              const wait = Math.min(10000, 1000 * 2 ** (epTries - 1));
              log(`reply gateway endpoint unavailable code=${e.code} try=${epTries}/${EP_TRIES} wait=${wait}`);
              await sleep(wait);
              continue;
            }
            log(`reply gateway endpoint unavailable code=${e.code} -> giving up (no second Blaze connection; nothing sent for msg=${it.id})`);
            throw Object.assign(new Error(`gateway send endpoint unavailable (${e.message}); group messages need the gateway's connection. Nothing sent for this message.`), { code: 'ENDPOINT_UNAVAILABLE', endpointCode: e.code });
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
            log(`reply retry code=${code} wait=${wait} via=gateway`);
            await sleep(wait);
            continue;
          }
          fallback(`group_send_rejected code=${code}${e.extra && e.extra.field ? ' field=' + e.extra.field : ''}`);
          continue;
        }
      }
      await privateSessions(privRefreshed);
      const req = await buildEnc(it, quote, 'private');
      try {
        await postEncrypted(api, req);
        log(`reply sent msg=${it.id} conv=${o.conversation} cat=${req.category} via=rest mode=private-encrypted recipient_id=${o.user}`);
        return req;
      } catch (e) {
        const { code, transient } = errInfo(e);
        if (transient && ++privTries < 6) {
          const wait = Math.min(30000, 1000 * 2 ** (privTries - 1));
          log(`reply retry code=${code} wait=${wait} via=rest-private`);
          await sleep(wait);
          continue;
        }
        if (code === 'ENC_FAILED' && !privRefreshed) {
          privRefreshed = true;
          log('reply private sessions refreshed code=ENC_FAILED, retrying encrypted once');
          continue;
        }
        throw Object.assign(new Error(`private encrypted fallback failed (${e.message}); nothing sent plain`), { code });
      }
    }
  }
  async function sendOne(it, quote) {
    let useEnc = !!(sessions && it.enc);
    let encRefreshed = false;
    let req;
    try { req = await build(it, useEnc, quote); }
    catch (e) {
      if (!useEnc) throw e;
      log(`reply encrypt unavailable, sending plain err=${e.message}`);
      useEnc = false;
      req = await build(it, false, quote);
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        if (req.category.startsWith('ENCRYPTED_')) await postEncrypted(api, req);
        else await api.message.sendOne(req);
        log(`reply sent msg=${it.id} conv=${o.conversation} cat=${req.category}`);
        return req;
      } catch (e) {
        const { code, transient } = errInfo(e);
        const rawCode = e.code || e.status || (e.response && e.response.status);
        if (transient) {
          const wait = Math.min(30000, 1000 * 2 ** attempt);
          log(`reply retry code=${rawCode} attempt=${attempt} wait=${wait}`);
          await sleep(wait);
          continue;
        }
        if (useEnc && !encRefreshed) {
          encRefreshed = true;
          try {
            sessions = await contactSessions(true);
            req = await build(it, true, quote);
            log(`reply contact sessions refreshed code=${rawCode} sessions=${sessions.length}, retrying encrypted once`);
            attempt--;
            continue;
          } catch (e2) { log(`reply contact session refresh failed err=${e2.message}`); }
        }
        if (useEnc) {
          log(`reply encrypted rejected code=${rawCode}, falling back to plain`);
          useEnc = false;
          req = await build(it, false, quote);
          attempt--;
          continue;
        }
        e.code = rawCode;
        throw e;
      }
    }
    throw Object.assign(new Error('GAVE UP'), { gaveUp: true });
  }
  return {
    isContact,
    endpoint,
    getMode: () => (isContact ? 'contact' : mode),
    sendItem: (it, quote) => (isContact ? sendOne(it, quote) : sendGroupOrPrivate(it, quote)),
  };
}
module.exports = { createTransport };
