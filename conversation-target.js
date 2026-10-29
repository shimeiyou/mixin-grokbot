'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function uniqueConversationId(a, b) {
  let [x, y] = [String(a), String(b)]; if (x > y) [x, y] = [y, x];
  const h = crypto.createHash('md5').update(x).update(y).digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const CACHE_MAX = 1000;
function createConvInfo({ api, botId, log = () => {}, cacheFile = process.env.MIXIN_CONV_CACHE_FILE || path.join(__dirname, 'conv-cache.json') }) {
  const memo = new Map(); // conversation_id -> conversation object (this process only)
  let disk = null;
  const load = () => { if (disk) return disk; try { const d = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); disk = d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch (_) { disk = {}; } return disk; };
  const save = () => {
    try {
      const ids = Object.keys(disk); if (ids.length > CACHE_MAX) for (const id of ids.sort((p, q) => (disk[p].at || 0) - (disk[q].at || 0)).slice(0, ids.length - CACHE_MAX)) delete disk[id];
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(disk), { mode: 0o600 }); fs.renameSync(tmp, cacheFile);
    } catch (e) { log(`WARN conv cache save failed err=${e.message}`); }
  };
  async function conversation(id, { fresh = false } = {}) {
    if (!fresh && memo.has(id)) return memo.get(id);
    const c = await api.request({ method: 'GET', url: `/conversations/${id}` });
    if (!c || typeof c !== 'object') throw new Error('GET /conversations returned no data');
    memo.set(id, c);
    if (c.category === 'CONTACT' || c.category === 'GROUP') { const d = load(); if (!d[id] || d[id].category !== c.category) { d[id] = { category: c.category, at: Date.now() }; save(); } }
    return c;
  }
  async function category(id, userId) {
    if (userId && botId && uniqueConversationId(botId, userId) === id) return 'CONTACT';
    const d = load(); if (d[id] && (d[id].category === 'CONTACT' || d[id].category === 'GROUP')) return d[id].category;
    try { const c = await conversation(id); return c.category === 'CONTACT' || c.category === 'GROUP' ? c.category : null; }
    catch (e) { log(`reply conversation lookup failed conv=${id} err=${e.message}`); return null; }
  }
  function invalidate(id) {
    memo.delete(id);
    disk = null; const d = load(); // re-read: another process (reply.js / gateway) may have written it
    if (d[id]) { delete d[id]; save(); return true; }
    return false;
  }
  async function members(id, { fresh = false } = {}) {
    const g = await groupSessions(id, { fresh });
    return { conversation: g.conversation, members: g.byUser.map(([u, l]) => {
      const withKey = l.filter((s) => s.public_key).length;
      const reason = !l.length ? 'no_session' : withKey < l.length ? 'no_public_key' : null;
      return { user_id: u, sessions: l.length, sessions_with_key: withKey, can_receive: !reason, ...(reason ? { reason } : {}) };
    }) };
  }
  async function groupSessions(id, { fresh = false } = {}) {
    const c = await conversation(id, { fresh });
    const users = [...new Set((c.participants || []).map((p) => p.user_id).filter((u) => u && u !== botId))];
    const byUser = new Map(users.map((u) => [u, []]));
    for (const s of c.participant_sessions || []) if (s && s.user_id !== botId && s.session_id) { if (!byUser.has(s.user_id)) byUser.set(s.user_id, []); byUser.get(s.user_id).push(s); }
    const noSession = [...byUser].filter(([, l]) => !l.length).map(([u]) => u);
    if (noSession.length) { // participant_sessions can lag behind; ask once for these users
      try { for (const s of (await api.request({ method: 'POST', url: '/sessions/fetch', data: noSession })) || []) if (s && byUser.has(s.user_id) && s.session_id) byUser.get(s.user_id).push(s); }
      catch (e) { log(`reply sessions fetch failed conv=${id} err=${e.message}`); }
    }
    const missing = [], sessions = [], seenS = new Set();
    for (const [u, l] of byUser) {
      if (!l.length || l.some((s) => !s.public_key)) missing.push(u);
      for (const s of l) if (!seenS.has(s.session_id)) { seenS.add(s.session_id); sessions.push({ user_id: u, session_id: s.session_id, public_key: s.public_key }); }
    }
    // Blaze conversation_checksum: MD5 of sorted participant_sessions session_ids.
    const allIds = [...new Set((c.participant_sessions || []).map((s) => s && s.session_id).filter(Boolean))];
    const result = { sessions, missing, participants: byUser.size, allSessionIds: allIds };
    Object.defineProperty(result, 'byUser', { value: [...byUser], enumerable: false });
    Object.defineProperty(result, 'conversation', { value: c, enumerable: false });
    return result;
  }
  return { category, conversation, groupSessions, members, invalidate };
}
module.exports = { uniqueConversationId, createConvInfo };
