'use strict';

const fs = require('fs');
const { render, baseType } = require('./message-parse');

function createAllowlist({ file, log }) {
  let allowSet = new Set();
  let allowMtimeMs = null;
  let allowWarnedEmpty = false;

  function reload() {
    let mtimeMs = -1;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch (_) { mtimeMs = -1; }
    if (allowMtimeMs !== null && mtimeMs === allowMtimeMs) return;
    allowMtimeMs = mtimeMs;
    const next = new Set();
    try {
      if (mtimeMs === -1) throw new Error('ENOENT');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) {
        for (const id of raw) {
          if (typeof id === 'string' && id) next.add(id);
        }
      }
    } catch (e) {
      if (e.message !== 'ENOENT') log(`WARN allowlist load failed path=${file} err=${e.message}`);
    }
    allowSet = next;
    if (allowSet.size === 0) {
      if (!allowWarnedEmpty) {
        log(`WARN allowlist empty/missing — blocking all users path=${file}`);
        allowWarnedEmpty = true;
      }
    } else {
      allowWarnedEmpty = false;
      log(`allowlist loaded count=${allowSet.size}`);
    }
  }

  reload();
  return {
    isAllowed: (userId) => {
      reload();
      return !!(userId && allowSet.has(userId));
    },
  };
}

function createSeenStore({ file, max = 20000, log }) {
  let seenList = [];
  try { seenList = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  const seen = new Set(seenList);
  let saveTimer = null;

  function flush() {
    saveTimer = null;
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(seenList));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      log('WARN seen save failed', e.message);
    }
  }

  function mark(id) {
    seen.add(id);
    seenList.push(id);
    if (seenList.length > max) {
      seenList.splice(0, seenList.length - max).forEach((x) => seen.delete(x));
    }
    if (!saveTimer) saveTimer = setTimeout(flush, 500);
  }

  return {
    has: (id) => seen.has(id),
    mark,
    flush,
  };
}

function createQuoteStore({ v2, max, contextOn, contextStore }) {
  const quoteCache = new Map();

  function remember(e) {
    if (!v2 || max <= 0) return;
    quoteCache.delete(e.message_id);
    quoteCache.set(e.message_id, e);
    while (quoteCache.size > max) {
      quoteCache.delete(quoteCache.keys().next().value);
    }
  }

  function find(conv, id) {
    const q = quoteCache.get(id);
    if (q && q.conversation_id === conv) {
      const { conversation_id, ...rest } = q;
      return rest;
    }
    if (contextOn) {
      try {
        const m = contextStore.recent(conv, null).find((x) => x.message_id === id);
        if (m) return { message_id: m.message_id, user_id: m.user_id, text: m.text, created_at: m.created_at, from_bot: m.from_bot };
      } catch (_) {}
    }
    return null;
  }

  return {
    remember,
    find,
    delete: (id) => quoteCache.delete(id),
  };
}

function createEnricher({ v2, textV2, lookup, media, viewUrl, restApi, log }) {
  const rerender = (payload) => {
    if (!v2) return;
    payload.display_text = render(baseType(payload.category), payload, payload.text);
    if (textV2) payload.text = payload.display_text;
  };

  return async function enrich(payload, priv) {
    if (lookup) {
      const u = await lookup.user(payload.user_id);
      if (u) {
        if (u.full_name != null) payload.sender_name = u.full_name;
        if (u.identity_number != null) payload.sender_identity_number = u.identity_number;
      }
      if (payload.contact && payload.contact.user_id) {
        const c = await lookup.user(payload.contact.user_id);
        if (c) {
          payload.contact.full_name = c.full_name;
          payload.contact.identity_number = c.identity_number;
          rerender(payload);
        }
      }
      if (payload.sticker && payload.sticker.sticker_id) {
        const s = await lookup.sticker(payload.sticker.sticker_id);
        if (s) {
          for (const k of ['name', 'album_id', 'asset_url', 'asset_type', 'asset_width', 'asset_height']) {
            if (payload.sticker[k] == null && s[k] != null) payload.sticker[k] = s[k];
          }
          rerender(payload);
        }
      }
    }
    const a = payload.attachment;
    if (a && media && media.downloadEnabled) {
      try {
        const r = await media.download(payload.message_id, a, priv);
        a.local_path = r.local_path;
        a.local_mime = r.local_mime;
        a.sha256 = r.sha256;
        if (viewUrl && r.view_url) a.view_url = r.view_url;
        log(`media saved msg=${payload.message_id} bytes=${r.bytes} mime=${r.local_mime}`);
      } catch (e) {
        a.download_error = String(e.message).slice(0, 200);
        log(`media download failed msg=${payload.message_id} err=${a.download_error}`);
      }
    } else if (a && viewUrl && !a.encrypted && a.attachment_id) {
      try {
        const m = await restApi.attachment.fetch(a.attachment_id);
        if (m && m.view_url) a.view_url = m.view_url;
      } catch (e) {
        log(`view_url fetch failed msg=${payload.message_id} err=${e.message}`);
      }
    }
  };
}

module.exports = { createAllowlist, createSeenStore, createQuoteStore, createEnricher };
