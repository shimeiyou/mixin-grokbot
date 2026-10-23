'use strict';
const assert = require('assert'); const crypto = require('crypto');
const { ed25519, x25519 } = require('@noble/curves/ed25519.js');
const m = require('./mixin-crypto'); const { loadKeystore } = require('./common');
const ks = loadKeystore(); const seed = m.seedFromKeystore(ks);
const self = { session_id: ks.session_id, public_key: m.b64urlEncode(x25519.getPublicKey(ed25519.utils.toMontgomerySecret(seed))) };
const otherSeed = crypto.randomBytes(32);
const other = { session_id: crypto.randomUUID(), public_key: m.b64urlEncode(x25519.getPublicKey(ed25519.utils.toMontgomerySecret(otherSeed))) };
const msg = '你好 round-trip ✓ ' + crypto.randomBytes(8).toString('hex');
const enc = m.encryptMessageData(msg, [other, self], seed);
assert.strictEqual(m.decryptMessageData(enc, ks.session_id, seed).toString(), msg); console.log('PASS self-session decrypt (2 recipients)');
assert.strictEqual(m.decryptMessageData(enc, other.session_id, otherSeed).toString(), msg); console.log('PASS other-session decrypt (ECDH symmetric)');
assert.throws(() => m.decryptMessageData(m.encryptMessageData(msg, [other], seed), ks.session_id, seed), /not in recipient/); console.log('PASS missing session rejected');
const t = m.b64urlDecode(enc); t[t.length - 1] ^= 1;
assert.throws(() => m.decryptMessageData(m.b64urlEncode(t), ks.session_id, seed)); console.log('PASS tampered ciphertext rejected');
// live: our own session key as published by POST /sessions/fetch (read-only API call, nothing sent)
(async () => {
  const { MixinApi } = require('@mixin.dev/mixin-node-sdk');
  const r = await MixinApi({ keystore: ks }).request({ method: 'POST', url: '/sessions/fetch', data: [ks.app_id] });
  const s = r.filter((x) => x.session_id === ks.session_id);
  assert.strictEqual(m.decryptMessageData(m.encryptMessageData(msg, s, seed), ks.session_id, seed).toString(), msg);
  console.log('PASS round trip with server-published session key');
  // simulate gateway toText on an ENCRYPTED_TEXT blaze message
})().catch((e) => { console.error('FAIL live', e.message); process.exit(1); });
