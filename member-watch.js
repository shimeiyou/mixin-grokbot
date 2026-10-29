'use strict';
const fs = require('fs');
const path = require('path');
const { v5: uuidv5 } = require('uuid');
const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const MEMBER_ACTIONS = new Set(['ADD', 'REMOVE', 'JOIN', 'EXIT', 'ROLE', 'CREATE']);

function createMemberWatch({ convInfo, botId, log, submit, isAllowed = () => true, alert = true, delayMs = 3000, recheckMs = 5000,
  stateFile = process.env.MIXIN_MEMBER_ALERT_STATE_FILE || path.join(__dirname, 'member-alert-state.json'), v2 = false }) {
  let state = {}; try { const d = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (d && typeof d === 'object' && !Array.isArray(d)) state = d; } catch (_) {}
  const saveState = () => { try { const tmp = `${stateFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, stateFile); } catch (e) { log(`WARN member alert state save failed err=${e.message}`); } };
  const processed = new Set(); // redelivered system messages
  const pending = new Map(); // conv -> { timer, trigger }
  const inflight = new Set();

  function onSystem(msg, sys) {
    try {
      const conv = msg.conversation_id; if (!conv || !msg.message_id || processed.has(msg.message_id)) return;
      processed.add(msg.message_id); if (processed.size > 2000) processed.delete(processed.values().next().value);
      const action = String((sys && sys.action) || '').toUpperCase();
      const participant = (sys && sys.participant_id) || '';
      let inv = false; try { inv = convInfo.invalidate(conv); } catch (e) { log(`WARN conv cache invalidate failed err=${e.message}`); }
      log(`member change conv=${conv} action=${action || '-'} participant=${participant || '-'} msg=${msg.message_id} cache=${inv ? 'invalidated' : 'none'}`);
      if (!alert || !MEMBER_ACTIONS.has(action)) return;
      if ((action === 'REMOVE' || action === 'EXIT') && participant === botId) { delete state[conv]; saveState(); log(`member check skipped conv=${conv} reason=bot_left`); return; }
      const trigger = { message_id: msg.message_id, action, participant_id: participant || null, user_id: msg.user_id || null, created_at: msg.created_at || null };
      const p = pending.get(conv); if (p) clearTimeout(p.timer);
      const timer = setTimeout(() => { pending.delete(conv); check(conv, trigger, false); }, delayMs); timer.unref && timer.unref();
      pending.set(conv, { timer, trigger });
    } catch (e) { log(`WARN member change handling failed err=${e.message}`); }
  }

  async function check(conv, trigger, rechecked) {
    if (inflight.has(conv)) { const t = setTimeout(() => check(conv, trigger, rechecked), 1000); t.unref && t.unref(); return; }
    inflight.add(conv);
    try {
      let r; try { r = await convInfo.members(conv, { fresh: true }); } catch (e) { log(`member check failed conv=${conv} err=${e.message}`); return; }
      const c = r.conversation || {};
      if (c.category !== 'GROUP') return;
      const users = (c.participants || []).map((x) => x.user_id);
      if (!users.some((u) => u !== botId && isAllowed(u))) { log(`member check skipped conv=${conv} reason=no_allowlisted_member`); return; }
      const missing = r.members.filter((m) => !m.can_receive);
      const ids = missing.map((m) => m.user_id);
      if (!rechecked && trigger.participant_id && ids.includes(trigger.participant_id) && (trigger.action === 'ADD' || trigger.action === 'JOIN')) {
        log(`member check conv=${conv} participant=${trigger.participant_id} cannot receive yet, rechecking in ${recheckMs}ms`); // sessions can lag right after joining
        const t = setTimeout(() => check(conv, trigger, true), recheckMs); t.unref && t.unref(); return;
      }
      const prev = new Set(Array.isArray(state[conv]) ? state[conv] : []);
      const fresh = ids.filter((u) => !prev.has(u));
      if (ids.length) state[conv] = ids; else delete state[conv];
      saveState();
      if (!fresh.length) { log(`member check conv=${conv} members=${r.members.length} missing=${ids.length} new_missing=0`); return; }
      const now = new Date().toISOString();
      const text = `[成员加密告警] 群内 ${ids.length} 名成员无法接收加密消息（新增 ${fresh.length} 名），群回复将改为只有提问者可见的私密加密消息`;
      const payload = {
        conversation_id: conv, user_id: trigger.user_id || botId, message_id: uuidv5(`member-alert:${conv}:${trigger.message_id}:${[...fresh].sort().join(',')}`, NS),
        category: 'SYSTEM_CONVERSATION', text, created_at: now, encrypted: false, original_category: 'SYSTEM_CONVERSATION',
        ...(v2 ? { display_text: text } : {}),
        kind: 'member_alert',
        member_alert: {
          conversation_id: conv, members_total: r.members.length, missing_total: ids.length, new_missing: fresh,
          missing: missing.map((m) => ({ user_id: m.user_id, reason: m.reason, sessions: m.sessions, sessions_with_key: m.sessions_with_key, new: fresh.includes(m.user_id) })),
          trigger, checked_at: now, effect: 'group replies fall back to a private encrypted message to the asker until these members leave or update their client',
        },
      };
      log(`member alert conv=${conv} new_missing=${fresh.join(',')} missing=${ids.length} msg=${payload.message_id}`);
      submit(payload);
    } finally { inflight.delete(conv); }
  }
  const stop = () => { for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); };
  return { onSystem, stop, _check: check, _state: () => state };
}
module.exports = { createMemberWatch, MEMBER_ACTIONS };
