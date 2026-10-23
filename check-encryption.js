#!/usr/bin/env node
'use strict';
// Read-only: can every member of a conversation receive encrypted messages?
//   node check-encryption.js --conversation <id>        (also: node reply.js --check-encryption --conversation <id>)
// Uses GET /conversations/<id> and, for members with no listed session, POST /sessions/fetch (both read-only).
// A member can receive when it has at least one session and every session has a public_key (the rule reply.js uses
// before it group-encrypts; otherwise the group reply falls back to a private message).
// stdout: JSON {ok, conversation_id, category, members_total, all_can_receive, missing:[user_id], members:[{user_id,
//   sessions, sessions_with_key, can_receive, reason?}]}. The bot itself is not listed.
// exit: 0 everyone can receive, 3 someone can't, 1 lookup error, 2 usage. Nothing is sent; names/keys are not printed.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'usage: node check-encryption.js --conversation <uuid>   (exit 0 all can receive encrypted, 3 someone cannot, 1 error, 2 usage)';

async function check({ conversation, api, botId, log = () => {} }) {
  const { createConvInfo } = require('./conversation-target');
  const conv = createConvInfo({ api, botId, log });
  const { conversation: c, members } = await conv.members(conversation, { fresh: true });
  const missing = members.filter((m) => !m.can_receive).map((m) => m.user_id);
  return { ok: true, conversation_id: conversation, category: c.category || null, members_total: members.length, all_can_receive: missing.length === 0, missing, members };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE + '\n'); return 0; }
  const i = argv.indexOf('--conversation'); const id = i >= 0 ? argv[i + 1] : null;
  if (!UUID.test(id || '')) { console.error(JSON.stringify({ ok: false, code: 'usage', error: '--conversation <uuid> required' })); console.error(USAGE); return 2; }
  require('./ws-shim');
  const { MixinApi } = require('@mixin.dev/mixin-node-sdk');
  const { log, loadKeystore } = require('./common');
  let keystore; try { keystore = loadKeystore(); } catch (e) { console.error(JSON.stringify({ ok: false, code: 'NO_KEYSTORE', error: e.message })); return 1; }
  const API_BASE = process.env.MIXIN_API_BASE || ''; // tests only
  const api = MixinApi(API_BASE ? { keystore, requestConfig: { baseURL: API_BASE, timeout: 15000 } } : { keystore, requestConfig: { timeout: 15000 } });
  try {
    const r = await check({ conversation: id, api, botId: keystore.app_id, log });
    log(`check-encryption conv=${id} members=${r.members_total} missing=${r.missing.length}`);
    console.log(JSON.stringify(r));
    return r.all_can_receive ? 0 : 3;
  } catch (e) {
    const code = (e.response && e.response.data && e.response.data.error && e.response.data.error.code) || e.code || (e.response && e.response.status) || 'ERROR';
    console.error(JSON.stringify({ ok: false, code, error: `conversation lookup failed: ${e.message}` }));
    return 1;
  }
}
module.exports = { check, main };
if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(JSON.stringify({ ok: false, code: 'ERROR', error: e.message })); process.exit(1); });
