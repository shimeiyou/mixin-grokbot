'use strict';
// Offline cross-validation of mixin-crypto.js against mixin_bot (pinned 2a070d0) lib/mixin_bot/api/encrypted_message.rb
// encrypt_message / decrypt_message and utils/crypto.rb generate_user_checksum. The reference below is an independent JS
// port of that Ruby code: it uses Node's built-in X25519 (no @noble), JOSE-style secret_to_curve25519 (SHA-512 + clamp)
// and pk_to_curve25519 (u = (1+y)/(1-y) mod p with BigInt), and OpenSSL ciphers like the Ruby code. Throwaway test keys
// only; no Ruby, no real keystore, no network.
const crypto = require('crypto');
const mc = require('./mixin-crypto');
let pass = 0, fail = 0;
const check = (n, ok, info) => { ok ? pass++ : fail++; console.log(ok ? 'PASS' : 'FAIL', n, ok || info === undefined ? '' : JSON.stringify(info)); };

// ---- reference port (mixin_bot) ----
const P = (1n << 255n) - 19n;
const modpow = (b, e) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const leToBig = (buf) => BigInt('0x' + Buffer.from(buf).reverse().toString('hex'));
const bigToLe = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse();
function pkToCurve25519(edPub) { // JOSE::JWA::Ed25519.pk_to_curve25519
  const b = Buffer.from(edPub); b[31] &= 0x7f; const y = leToBig(b);
  return bigToLe(((1n + y) * modpow((1n - y + P) % P, P - 2n)) % P);
}
function secretToCurve25519(seed) { // JOSE::JWA::Ed25519.secret_to_curve25519
  const h = crypto.createHash('sha512').update(seed).digest().subarray(0, 32); h[0] &= 248; h[31] &= 127; h[31] |= 64; return h;
}
function x25519Shared(pub, priv) { // JOSE::JWA::X25519.shared_secret(pub, priv) via Node crypto
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), priv]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), pub]), format: 'der', type: 'spki' });
  return crypto.diffieHellman({ privateKey, publicKey });
}
const packUuid = (u) => Buffer.from(u.replace(/-/g, ''), 'hex');
const b64u = (b) => Buffer.from(b).toString('base64url'), unb64u = (s) => Buffer.from(s, 'base64url');
function rbEncrypt(dataB64, sessions, sk, pk, rnd = crypto.randomBytes) { // encrypt_message(data, sessions, sk:, pk:)
  const key = rnd(16), nonce = rnd(12); // encrypter.random_key / random_iv (GCM iv = 12)
  const g = crypto.createCipheriv('aes-128-gcm', key, nonce); g.setAAD(Buffer.alloc(0));
  const ciphertext = Buffer.concat([g.update(unb64u(dataB64)), g.final(), g.getAuthTag()]);
  const out = [Buffer.from([1]), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(sessions.length); return b; })(), pkToCurve25519(pk)];
  for (const s of sessions) {
    const aesKey = x25519Shared(unb64u(s.public_key), secretToCurve25519(sk));
    const padding = 16 - (key.length % 16); const padtext = Buffer.alloc(padding, padding);
    const iv = rnd(16); const c = crypto.createCipheriv('aes-256-cbc', aesKey, iv); // update() only, like the Ruby code
    out.push(packUuid(s.session_id), iv, c.update(Buffer.concat([key, padtext])));
  }
  out.push(nonce, ciphertext);
  return b64u(Buffer.concat(out));
}
function rbDecrypt(data, sk, si) { // decrypt_message(data, sk:, si:) -> base64url plaintext, '' when not for us
  const bytes = unb64u(data); const size = 16 + 48;
  if (bytes.length < 1 + 2 + 32 + size + 12) return '';
  const sessionLength = bytes[1]; // Ruby: bytes[1...3].pack('v*').unpack1('C*') == low byte only
  const prefix = 35 + sessionLength * size; let key = Buffer.alloc(0);
  for (let i = 35; i < prefix; i += size) {
    if (mc.bytesUuid(bytes.subarray(i, i + 16)) === si) {
      const aesKey = x25519Shared(bytes.subarray(3, 35), secretToCurve25519(sk));
      const d = crypto.createDecipheriv('aes-256-cbc', aesKey, bytes.subarray(i + 16, i + 32));
      key = d.update(bytes.subarray(i + 32, i + size)).subarray(0, 16); break; // update() holds back the padded last block
    }
  }
  if (key.length !== 16) return '';
  const d = crypto.createDecipheriv('aes-128-gcm', key, bytes.subarray(prefix, prefix + 12));
  d.setAuthTag(bytes.subarray(bytes.length - 16));
  const out = d.update(bytes.subarray(prefix + 12, bytes.length - 16)); d.final(); // throws on a bad tag (Ruby: CipherError)
  return b64u(out);
}
const rbChecksum = (sessions) => { const l = sessions.map((s) => s.session_id).filter(Boolean).sort(); return l.length ? crypto.createHash('md5').update(l.join('')).digest('hex') : ''; };

// ---- throwaway identities ----
function ident() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const session_id = crypto.randomUUID();
  return { seed, pub, session_id, sess: { user_id: crypto.randomUUID(), session_id, public_key: b64u(pkToCurve25519(pub)) } };
}
const A = ident(), B = ident(), C = ident(), D = ident();
const msg = Buffer.from(JSON.stringify({ text: '交叉验证 cross-validation ✓', n: 42 }));

// 1 key derivation agrees (our curve pub for a seed == mixin_bot pk_to_curve25519(ed pub); session public_key form)
{ const ours = b64u(mc.encryptMessageData(Buffer.from('x'), [B.sess], A.seed) && unb64u(mc.encryptMessageData(Buffer.from('x'), [B.sess], A.seed)).subarray(3, 35));
  check('sender curve key in our header == mixin_bot pk_to_curve25519(ed25519 pub)', ours === b64u(pkToCurve25519(A.pub))); }
// 2 ours -> mixin_bot decrypt, for each of 3 recipient sessions
{ const enc = mc.encryptMessageData(msg, [B.sess, C.sess, D.sess], A.seed);
  const okAll = [B, C, D].every((r) => unb64u(rbDecrypt(enc, r.seed, r.session_id)).equals(msg));
  check('mixin-crypto encrypt (3 sessions) -> mixin_bot decrypt_message recovers the payload for every session', okAll);
  check('mixin_bot decrypt_message returns "" for a session not in the list', rbDecrypt(enc, A.seed, A.session_id) === ''); }
// 3 mixin_bot encrypt -> ours decrypt
{ const enc = rbEncrypt(b64u(msg), [B.sess, C.sess], A.seed, A.pub);
  check('mixin_bot encrypt_message (2 sessions) -> mixin-crypto decrypt recovers the payload for both', mc.decryptMessageData(enc, B.session_id, B.seed).equals(msg) && mc.decryptMessageData(enc, C.session_id, C.seed).equals(msg));
  let threw = false; try { mc.decryptMessageData(enc, D.session_id, D.seed); } catch (_) { threw = true; }
  check('mixin-crypto decrypt rejects a session that is not a recipient', threw); }
// 4 byte-identical output with the same randomness (key, nonce, then one iv per session: same order in both)
{ const seq = [crypto.randomBytes(16), crypto.randomBytes(12), crypto.randomBytes(16), crypto.randomBytes(16)];
  let i = 0; const orig = crypto.randomBytes; crypto.randomBytes = (n) => { const b = seq[i++]; if (!b || b.length !== n) throw new Error(`unexpected randomBytes(${n}) #${i}`); return Buffer.from(b); };
  let ours; try { ours = mc.encryptMessageData(msg, [B.sess, C.sess], A.seed); } finally { crypto.randomBytes = orig; }
  let j = 0; const ref = rbEncrypt(b64u(msg), [B.sess, C.sess], A.seed, A.pub, (n) => Buffer.from(seq[j++]));
  check('fixed key/nonce/ivs -> mixin-crypto output is byte-identical to the mixin_bot port (test vector)', ours === ref && i === 4 && j === 4, { i, j, lenO: ours && ours.length, lenR: ref.length }); }
// 5 empty and large payloads, both directions
{ const big = crypto.randomBytes(70000), empty = Buffer.alloc(0);
  check('empty + 70KB payloads round-trip both ways', [empty, big].every((p) => unb64u(rbDecrypt(mc.encryptMessageData(p, [B.sess], A.seed), B.seed, B.session_id)).equals(p) && mc.decryptMessageData(rbEncrypt(b64u(p), [B.sess], A.seed, A.pub), B.session_id, B.seed).equals(p))); }
// 6 tampering: both reject a modified GCM tag / body
{ const enc = unb64u(mc.encryptMessageData(msg, [B.sess], A.seed)); enc[enc.length - 1] ^= 1; const bad = b64u(enc);
  let t1 = false, t2 = false; try { mc.decryptMessageData(bad, B.session_id, B.seed); } catch (_) { t1 = true; } try { rbDecrypt(bad, B.seed, B.session_id); } catch (_) { t2 = true; }
  check('flipped tag bit -> both implementations reject', t1 && t2); }
// 7 checksum == generate_user_checksum (sorted session ids, md5 hex), independent of order
{ const ss = [D.sess, B.sess, C.sess];
  check('sessionsChecksum == mixin_bot generate_user_checksum (order-independent)', mc.sessionsChecksum(ss.map((s) => s.session_id)) === rbChecksum(ss) && mc.sessionsChecksum([C, B, D].map((r) => r.session_id)) === rbChecksum(ss)); }
// 8 known keystore forms: hex seed+pub (64 bytes) and base64url both give the same seed
{ const hex = Buffer.concat([A.seed, A.pub]).toString('hex');
  check('seedFromKeystore: hex(seed||pub) and base64url(seed||pub) -> same 32-byte seed as mixin_bot session_private_key[0...32]', mc.seedFromKeystore({ session_private_key: hex }).equals(A.seed) && mc.seedFromKeystore({ session_private_key: b64u(Buffer.concat([A.seed, A.pub])) }).equals(A.seed)); }

console.log(fail ? `crypto-xval: ${fail} FAILED, ${pass} passed` : `crypto-xval: ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
