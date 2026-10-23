'use strict';
// reply.js --recall <message_id>[,<id>...] (repeatable): recall messages the bot itself sent.
// Protocol: category MESSAGE_RECALL, data {"message_id":"<target>"}. Official clients send it as a PLAIN control
// message (there is no ENCRYPTED_ form): Android SendMessageJob L201 routes isRecall() to sendPlainMessage (Blaze
// CREATE_MESSAGE, no recipient_id); flutter sending_job.dart _runRecallJob L120-145 the same; receivers handle it by
// its raw category (Android DecryptMessage L223, flutter decrypt_message.dart L196). It carries only the target id.
//  - CONTACT: REST POST /messages with recipient_id (1:1 keeps the existing plain path).
//  - GROUP: refused by default (a group recall can only be sent unencrypted). MIXIN_GROUP_RECALL=1 explicitly allows
//    it: Blaze CREATE_MESSAGE without recipient_id via the gateway endpoint (main connection) ONLY. Endpoint unreachable
//    -> exit 1 code ENDPOINT_UNAVAILABLE (no second Blaze connection, audit W-6). With an ssh: endpoint the recall is
//    also mirrored to the gateway host (its context store drops the recalled message).
//  - Every target must be one of OUR messages in THIS conversation (sent-log.js: sent-log / context store / gateway.log),
//    otherwise nothing at all is sent (exit 2). Recall ids are UUIDv5("mixin-recall:<target>") -> retries are idempotent.
// exit: 0 all recalled, 1 send failed (JSON lists what was recalled), 2 refused/usage (nothing sent).
const { v5: uuidv5 } = require('uuid');
const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const on = (n) => /^(1|true|yes|on)$/i.test(process.env[n] || '');

function refuse(code, error, extra = {}) { console.error(JSON.stringify({ ok: false, code, error, ...extra })); return 2; }

async function runRecall({ o, api, keystore, log, sleep, base64RawURLEncode }) {
  const targets = [...new Set(o.recall.map((x) => String(x).trim()).filter(Boolean))];
  if (!targets.length || targets.some((t) => !UUID.test(t))) return refuse('usage', '--recall needs message ids (uuid), comma-separated or repeated');
  const sentLog = require('./sent-log');
  const notOwn = targets.filter((t) => !sentLog.isOwn(o.conversation, t, { botId: keystore.app_id }).own);
  if (notOwn.length) { log(`reply recall refused not_own=${notOwn.join(',')} conv=${o.conversation}`); return refuse('NOT_OWN_MESSAGE', 'only messages the bot itself sent in this conversation can be recalled; nothing sent', { message_ids: notOwn }); }
  const { createConvInfo } = require('./conversation-target');
  const conv = createConvInfo({ api, botId: keystore.app_id, log });
  const cat = await conv.category(o.conversation, o.user);
  const isContact = cat === 'CONTACT';
  if (!isContact) {
    if (cat !== 'GROUP') return refuse('CONVERSATION_LOOKUP_FAILED', 'conversation category unknown; recall refused (nothing sent)');
    if (!on('MIXIN_GROUP_RECALL')) {
      log(`reply recall refused conv=${o.conversation} reason=group_recall_plaintext targets=${targets.length}`);
      return refuse('GROUP_RECALL_REFUSED', 'MESSAGE_RECALL has no encrypted form (official clients send it unencrypted; it carries only the message id). Group recall is off because groups never get unencrypted messages; set MIXIN_GROUP_RECALL=1 to allow it. Nothing sent.');
    }
  }
  let recipient = o.user;
  if (isContact && !recipient) {
    try { recipient = ((await conv.conversation(o.conversation)).participants || []).map((p) => p.user_id).find((u) => u && u !== keystore.app_id); } catch (e) { log(`reply recall lookup failed err=${e.message}`); }
    if (!recipient) return refuse('NO_RECIPIENT', '1:1 recall needs --user (could not read the conversation); nothing sent');
  }
  const sendEp = require('./send-endpoint');
  let endpoint = null, endpointErr = null;
  try { endpoint = sendEp.parseEndpoint(); } catch (e) { endpointErr = e; }
  const EP_TRIES = Math.max(1, parseInt(process.env.MIXIN_SEND_ENDPOINT_TRIES || '3', 10));
  const remote = [];
  const flushRemote = async () => {
    if (!remote.length || !endpoint || endpoint.type !== 'ssh') return;
    const items = remote.splice(0);
    try { const r = await sendEp.recordViaEndpoint(items, { endpoint }); log(`reply record remote recall items=${items.length} removed=${r.removed || 0} endpoint=ssh:${endpoint.host}`); }
    catch (e) { log(`WARN reply record remote failed code=${e.code} (recall was sent)`); }
  };
  const done = [];
  try {
    for (const t of targets) {
      const req = { conversation_id: o.conversation, message_id: uuidv5(`mixin-recall:${t}`, NS), category: 'MESSAGE_RECALL', data_base64: base64RawURLEncode(Buffer.from(JSON.stringify({ message_id: t }))) };
      let via, epTries = 0;
      for (let attempt = 0; ; attempt++) {
        try {
          if (isContact) { via = 'rest'; await api.message.sendOne({ ...req, recipient_id: recipient }); }
          else { via = 'gateway'; if (endpointErr) throw endpointErr; await sendEp.sendViaEndpoint({ ...req, status: 'SENT' }, { endpoint }); }
          break;
        } catch (e) {
          if (via === 'gateway' && (e.unavailable || e.code === 'ENDPOINT_CONFIG')) {
            if (e.retryable && ++epTries < EP_TRIES) { const w = Math.min(10000, 1000 * 2 ** (epTries - 1)); log(`reply gateway endpoint unavailable code=${e.code} try=${epTries}/${EP_TRIES} wait=${w}`); await sleep(w); attempt--; continue; }
            log(`reply gateway endpoint unavailable code=${e.code} -> giving up (no second Blaze connection)`);
            const f = new Error(`gateway send endpoint unavailable (${e.message}); group recall needs the gateway's connection. Nothing sent for this target.`); f.code = 'ENDPOINT_UNAVAILABLE'; throw f;
          }
          const code = (e.response && e.response.data && e.response.data.error && e.response.data.error.code) || e.code || (e.response && e.response.status);
          const st = e.response && e.response.status;
          if ((code === 429 || code === 500 || code === 'ECONNRESET' || code === 'ETIMEDOUT' || st === 429 || st >= 500) && attempt < 3) { const w = 1000 * 2 ** attempt; log(`reply recall retry code=${code} wait=${w} via=${via}`); await sleep(w); continue; }
          e.code = code; throw e;
        }
      }
      log(`reply recall sent target=${t} msg=${req.message_id} conv=${o.conversation} via=${via} mode=${isContact ? 'contact' : 'group-control'}`);
      done.push({ message_id: t, recall_message_id: req.message_id, category: 'MESSAGE_RECALL', via });
      try { const cs = require('./context-store'); if (cs.enabled()) cs.remove(o.conversation, t); } catch (_) {}
      remote.push({ message_id: t, conversation_id: o.conversation, category: 'MESSAGE_RECALL', via, remove_context: true });
    }
  } catch (e) {
    await flushRemote();
    log(`reply recall FAILED code=${e.code} err=${e.message}`);
    console.error(JSON.stringify({ ok: false, code: e.code, error: e.message, recalled: done }));
    return 1;
  }
  await flushRemote();
  console.log(JSON.stringify({ ok: true, recalled: done }));
  return 0;
}
module.exports = { runRecall };
