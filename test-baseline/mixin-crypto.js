'use strict';
// Port of bot-api-go-client EncryptMessageData / DecryptMessageData.
// Layout: ver(1)=1 | sessionCount(2,LE) | senderCurvePub(32) | N*[sessionUUID(16)|iv(16)|AES-CBC(key16+pkcs7)(32)] | nonce(12) | AES-GCM(ciphertext+tag)
const crypto = require('crypto');
const { ed25519, x25519 } = require('@noble/curves/ed25519.js');

const b64urlDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlEncode = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const uuidBytes = (u) => Buffer.from(u.replace(/-/g, ''), 'hex');
const bytesUuid = (b) => { const h = Buffer.from(b).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

function seedFromKeystore(ks) {
  const s = ks.session_private_key;
  const b = /^[0-9a-fA-F]{64,128}$/.test(s) ? Buffer.from(s, 'hex') : b64urlDecode(s);
  return b.subarray(0, 32);
}
const curvePriv = (seed) => Buffer.from(ed25519.utils.toMontgomerySecret(seed));
const curvePubFromSeed = (seed) => Buffer.from(x25519.getPublicKey(curvePriv(seed)));
const edPubToCurve = (pub) => Buffer.from(ed25519.utils.toMontgomery(pub));

function cbc(dec, key, iv, data) {
  const c = (dec ? crypto.createDecipheriv : crypto.createCipheriv)('aes-256-cbc', key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

// sessions: [{session_id, public_key}]; public_key is base64url Curve25519 key as returned by /sessions/fetch (verified: equals our curve pub)
function encryptMessageData(plain, sessions, seed) {
  const key = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const g = crypto.createCipheriv('aes-128-gcm', key, nonce);
  const ct = Buffer.concat([g.update(Buffer.from(plain)), g.final(), g.getAuthTag()]);
  const priv = curvePriv(seed);
  const padded = Buffer.concat([key, Buffer.alloc(16, 16)]); // PKCS7 pad 16 -> 32
  const parts = sessions.map((s) => {
    const shared = Buffer.from(x25519.getSharedSecret(priv, b64urlDecode(s.public_key)));
    const iv = crypto.randomBytes(16);
    return Buffer.concat([uuidBytes(s.session_id), iv, cbc(false, shared, iv, padded)]);
  });
  const n = Buffer.alloc(2); n.writeUInt16LE(sessions.length);
  return b64urlEncode(Buffer.concat([Buffer.from([1]), n, curvePubFromSeed(seed), ...parts, nonce, ct]));
}

function decryptMessageData(dataB64, sessionId, seed) {
  const b = b64urlDecode(dataB64);
  if (b.length < 35 || b[0] !== 1) throw new Error('bad encrypted version/size');
  const count = b.readUInt16LE(1);
  const senderPub = b.subarray(3, 35);
  const end = 35 + count * 64;
  if (b.length < end + 12 + 16) throw new Error('bad encrypted size');
  const want = uuidBytes(sessionId);
  let entry = null;
  for (let i = 0; i < count; i++) { const e = b.subarray(35 + i * 64, 99 + i * 64); if (e.subarray(0, 16).equals(want)) { entry = e; break; } }
  if (!entry) throw new Error('session not in recipient list');
  const shared = Buffer.from(x25519.getSharedSecret(curvePriv(seed), senderPub));
  const kp = cbc(true, shared, entry.subarray(16, 32), entry.subarray(32, 64));
  const pad = kp[kp.length - 1];
  if (pad < 1 || pad > 16) throw new Error('bad key padding');
  const key = kp.subarray(0, kp.length - pad);
  const nonce = b.subarray(end, end + 12), body = b.subarray(end + 12);
  const d = crypto.createDecipheriv(`aes-${key.length * 8}-gcm`, key, nonce);
  d.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
}

const sessionsChecksum = (ids) => crypto.createHash('md5').update([...ids].sort().join('')).digest('hex');
module.exports = { encryptMessageData, decryptMessageData, seedFromKeystore, sessionsChecksum, b64urlDecode, b64urlEncode, bytesUuid };
