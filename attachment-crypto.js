'use strict';
// Mixin encrypted-attachment format (same as Android AttachmentCipherOutputStream / Signal):
//   key    = 64 bytes = aesKey(32) | macKey(32)            (sent base64 in the message JSON as "key")
//   blob   = IV(16) | AES-256-CBC-PKCS7(plaintext) | HMAC-SHA256(macKey, IV | ciphertext)(32)
//   digest = SHA-256(blob)                                  (sent base64 in the message JSON as "digest")
// The blob is what gets uploaded to / downloaded from the attachment URL.
const crypto = require('crypto');

// key/digest arrive as base64 (std or url-safe) strings; tolerate Gson-style int arrays too.
function toBuf(v, what) {
  if (Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return Buffer.from(v.map((x) => x & 0xff));
  if (typeof v === 'string' && v) return Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  throw new Error(`missing/invalid attachment ${what}`);
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function encryptAttachment(plain, key = crypto.randomBytes(64), iv = crypto.randomBytes(16)) {
  if (key.length !== 64) throw new Error('attachment key must be 64 bytes');
  if (iv.length !== 16) throw new Error('iv must be 16 bytes');
  const c = crypto.createCipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const mac = crypto.createHmac('sha256', key.subarray(32)).update(iv).update(ct).digest();
  const data = Buffer.concat([iv, ct, mac]);
  return { data, key, digest: sha256(data) };
}

// Verifies digest (if requireDigest or a digest is given), then the HMAC, then decrypts.
function decryptAttachment(blob, keyIn, digestIn, { requireDigest = true } = {}) {
  const key = toBuf(keyIn, 'key');
  if (key.length !== 64) throw new Error(`attachment key must be 64 bytes (got ${key.length})`);
  if (blob.length < 64 || (blob.length - 48) % 16 !== 0) throw new Error(`bad encrypted attachment size ${blob.length}`);
  if (digestIn != null || requireDigest) {
    const want = toBuf(digestIn, 'digest');
    if (want.length !== 32 || !crypto.timingSafeEqual(sha256(blob), want)) throw new Error('attachment digest mismatch');
  }
  const iv = blob.subarray(0, 16), ct = blob.subarray(16, blob.length - 32), mac = blob.subarray(blob.length - 32);
  const calc = crypto.createHmac('sha256', key.subarray(32)).update(iv).update(ct).digest();
  if (!crypto.timingSafeEqual(mac, calc)) throw new Error('attachment HMAC mismatch');
  const d = crypto.createDecipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  return Buffer.concat([d.update(ct), d.final()]);
}

const ciphertextLength = (n) => 16 + (Math.floor(n / 16) + 1) * 16 + 32;
module.exports = { encryptAttachment, decryptAttachment, ciphertextLength, sha256, toBuf };
