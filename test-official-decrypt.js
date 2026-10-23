'use strict';
// Offline round trip: encrypt with the gateway's mixin-crypto.js, decrypt with a
// line-by-line JS port of Android EncryptedProtocol.decryptMessage (+ CryptoUtil),
// using node:crypto X25519/AES only (independent of @noble used by the encrypt side).
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const MC = require(path.join(process.env.GW_DIR || __dirname, 'mixin-crypto.js'));
const { ed25519 } = require(require.resolve('@noble/curves/ed25519.js', { paths: [process.env.GW_DIR || __dirname] }));

// --- Android CryptoUtil port ---
function privateKeyToCurve25519(seed32) { // SHA-512(privateKey)[0..31], clamp
  const h = crypto.createHash('sha512').update(seed32).digest().subarray(0, 32);
  h[0] &= 248; h[31] &= 127; h[31] |= 64; return Buffer.from(h);
}
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const xPriv = (raw) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' });
const xPubOfPriv = (raw) => crypto.createPublicKey(xPriv(raw)).export({ format: 'der', type: 'spki' }).subarray(12);
function calculateAgreement(pub, priv) {
  return crypto.diffieHellman({ privateKey: xPriv(priv), publicKey: crypto.createPublicKey({ key: Buffer.concat([SPKI, pub]), format: 'der', type: 'spki' }) });
}
function aesDecryptCbcPkcs5(key, iv, ct) { const d = crypto.createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv); return Buffer.concat([d.update(ct), d.final()]); }
function aesGcmDecrypt(msg, key) { // GCM_IV_LENGTH = 12, 128-bit tag appended
  const iv = msg.subarray(0, 12), body = msg.subarray(12);
  const d = crypto.createDecipheriv(`aes-${key.length * 8}-gcm`, key, iv);
  d.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
}
const leByteArrayToInt = (b) => b[0] + (b[1] << 8);
const uuidToByteArray = (u) => Buffer.from(u.replace(/-/g, ''), 'hex'); // putLong(msb), putLong(lsb)
// --- EncryptedProtocol.decryptMessage port (slice(IntRange(a,b)) is inclusive) ---
function decryptMessage(seed, sessionId, c) {
  const sessionSize = leByteArrayToInt(c.subarray(1, 3));
  const senderPublicKey = c.subarray(3, 35);
  let key = null;
  for (let it = 0; it < sessionSize; it++) {
    const off = it * 64;
    const sid = c.subarray(35 + off, 51 + off);
    if (sessionId.equals(sid)) key = c.subarray(51 + off, 99 + off);
  }
  if (!key) throw new Error('requireNotNull: no key for session');
  const message = c.subarray(35 + 64 * sessionSize);
  const iv = key.subarray(0, 16), content = key.subarray(16);
  const shared = calculateAgreement(senderPublicKey, privateKeyToCurve25519(seed));
  return aesGcmDecrypt(message, aesDecryptCbcPkcs5(shared, iv, content));
}

let pass = 0; const ok = (m) => { pass++; console.log('ok -', m); };
const botSeed = crypto.randomBytes(32);
// Receivers: Android-style key registration (curve pub uploaded = X25519 pub of clamped SHA512(seed))
const rx = Array.from({ length: 8 }, () => {
  const seed = crypto.randomBytes(32);
  return { seed, session_id: crypto.randomUUID(), public_key: MC.b64urlEncode(xPubOfPriv(privateKeyToCurve25519(seed))) };
});
// Cross-check: Edwards->Montgomery of ed pub == X25519 pub of clamped SHA512(seed) (what clients do on both sides)
for (const r of rx) assert.strictEqual(Buffer.from(ed25519.utils.toMontgomery(ed25519.getPublicKey(r.seed))).toString('hex'), MC.b64urlDecode(r.public_key).toString('hex'));
ok('receiver curve keys: ed->montgomery(pub) == X25519(clamp(sha512(seed)))');

const plain = JSON.stringify({ t: 'fake text ' + crypto.randomBytes(4).toString('hex') });
const blob = MC.b64urlDecode(MC.encryptMessageData(plain, rx.map(({ session_id, public_key }) => ({ session_id, public_key })), botSeed));
assert.strictEqual(blob[0], 1); ok('version byte 0x01');
assert.strictEqual(leByteArrayToInt(blob.subarray(1, 3)), 8); ok('session count LE = 8');
assert.strictEqual(blob.subarray(3, 35).toString('hex'), xPubOfPriv(privateKeyToCurve25519(botSeed)).toString('hex'));
assert.strictEqual(blob.subarray(3, 35).toString('hex'), Buffer.from(ed25519.utils.toMontgomery(ed25519.getPublicKey(botSeed))).toString('hex'));
ok('sender pub = publicKeyToCurve25519(bot ed pub) = X25519 pub of bot curve priv');
assert.strictEqual(blob.length, 35 + 8 * 64 + 12 + Buffer.byteLength(plain) + 16); ok('total length = 35 + 64*8 + 12 + len + 16');
rx.forEach((r, i) => assert.ok(blob.subarray(35 + i * 64, 51 + i * 64).equals(uuidToByteArray(r.session_id)))); ok('session ids in order, big-endian UUID bytes');
const keys = new Set();
rx.forEach((r) => {
  const out = decryptMessage(r.seed, uuidToByteArray(r.session_id), blob);
  assert.strictEqual(out.toString(), plain);
  keys.add(MC.b64urlEncode(blob.subarray(35, 35 + 8 * 64)));
});
ok('all 8 sessions decrypt with the official algorithm');
// each entry is distinct (separate IV + separate ECDH)
const entries = rx.map((_, i) => blob.subarray(51 + i * 64, 99 + i * 64).toString('hex'));
assert.strictEqual(new Set(entries).size, 8); ok('8 distinct key entries');
assert.throws(() => decryptMessage(crypto.randomBytes(32), uuidToByteArray(crypto.randomUUID()), blob), /requireNotNull/); ok('foreign session -> no key (client: FAILED/invalid placeholder)');
assert.throws(() => decryptMessage(crypto.randomBytes(32), uuidToByteArray(rx[3].session_id), blob)); ok('right session id, wrong private key -> throws (stale public_key case)');
const bad = Buffer.from(blob); bad[bad.length - 1] ^= 1; assert.throws(() => decryptMessage(rx[0].seed, uuidToByteArray(rx[0].session_id), bad)); ok('tampered tag -> throws');
// gateway wire: base64url; clients use Base64 decode that accepts url-safe (Android decodeBase64 / okio) - check std b64 too
assert.strictEqual(Buffer.from(MC.b64urlEncode(blob), 'base64url').equals(blob), true); ok('base64url round trip');
console.log(`\n${pass} passed`);
