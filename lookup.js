'use strict';
const fs = require('fs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createLookup({ api, log = () => {}, ttlMs = 24 * 3600e3, negTtlMs = 10 * 60e3, max = 2000, file = null, timeoutMs = 5000 }) {
  const cache = new Map(); // key -> { v, t, neg }
  const inflight = new Map();
  if (file) {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      const now = Date.now();
      for (const [k, e] of Object.entries(o || {})) if (e && !e.neg && now - e.t < ttlMs) cache.set(k, e);
    } catch (_) {}
  }
  let saveTimer = null;
  const save = () => {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const obj = {}; for (const [k, e] of cache) if (!e.neg) obj[k] = e;
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 }); fs.renameSync(tmp, file);
      } catch (e) { log(`WARN lookup cache save failed err=${e.message}`); }
    }, 1000);
    if (saveTimer.unref) saveTimer.unref();
  };
  const withTimeout = (p) => { let t; return Promise.race([p, new Promise((_, r) => { t = setTimeout(() => r(new Error('lookup timeout')), timeoutMs); })]).finally(() => clearTimeout(t)); };
  async function get(key, fetcher) {
    const e = cache.get(key), now = Date.now();
    if (e && now - e.t < (e.neg ? negTtlMs : ttlMs)) { cache.delete(key); cache.set(key, e); return e.neg ? null : e.v; }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try { const v = await withTimeout(fetcher()); cache.set(key, { v, t: Date.now() }); save(); return v; }
      catch (err) { log(`lookup failed key=${key.split(':')[0]} err=${err.message}`); cache.set(key, { v: null, t: Date.now(), neg: true }); return null; }
      finally { inflight.delete(key); while (cache.size > max) cache.delete(cache.keys().next().value); }
    })();
    inflight.set(key, p);
    return p;
  }
  return {
    user: (id) => (UUID.test(id || '') ? get(`user:${id}`, async () => { const u = await api.user.fetch(id); return u ? { user_id: u.user_id, full_name: u.full_name, identity_number: u.identity_number, is_bot: !!u.app } : null; }) : Promise.resolve(null)),
    sticker: (id) => (UUID.test(id || '') ? get(`sticker:${id}`, async () => { const s = await api.request({ method: 'GET', url: `/stickers/${id}` }); return s ? { sticker_id: s.sticker_id, name: s.name, album_id: s.album_id, asset_url: s.asset_url, asset_type: s.asset_type, asset_width: s.asset_width, asset_height: s.asset_height } : null; }) : Promise.resolve(null)),
    _cache: cache,
  };
}
module.exports = { createLookup, UUID };
