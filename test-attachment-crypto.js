'use strict';
// Encrypted attachment format tests, incl. an independent cross-check against the openssl CLI.
const crypto = require('crypto'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const ac = require('./attachment-crypto');
const { check, finish, tmpdir } = require('./test-helpers');

for (const n of [0, 1, 15, 16, 17, 1000, 65536 + 3]) {
  const p = crypto.randomBytes(n); const e = ac.encryptAttachment(p);
  check(`round trip ${n} bytes, length formula`, ac.decryptAttachment(e.data, e.key.toString('base64'), e.digest.toString('base64')).equals(p) && e.data.length === ac.ciphertextLength(n));
}
const p = Buffer.from('图片 bytes ✓'.repeat(50)); const e = ac.encryptAttachment(p);
check('url-safe base64 key/digest accepted', ac.decryptAttachment(e.data, e.key.toString('base64url'), e.digest.toString('base64url')).equals(p));
check('int-array key accepted', ac.decryptAttachment(e.data, [...e.key], [...e.digest]).equals(p));
const t1 = Buffer.from(e.data); t1[20] ^= 1;
let err = ''; try { ac.decryptAttachment(t1, e.key, e.digest); } catch (x) { err = x.message; }
check('tampered ciphertext -> digest mismatch', /digest mismatch/.test(err), err);
err = ''; try { ac.decryptAttachment(t1, e.key, ac.sha256(t1)); } catch (x) { err = x.message; }
check('tampered ciphertext with recomputed digest -> HMAC mismatch', /HMAC mismatch/.test(err), err);
err = ''; try { ac.decryptAttachment(e.data, e.key, null); } catch (x) { err = x.message; }
check('missing digest rejected by default', /digest/.test(err), err);
err = ''; try { ac.decryptAttachment(e.data, crypto.randomBytes(32), e.digest); } catch (x) { err = x.message; }
check('32-byte key rejected', /64 bytes/.test(err), err);
err = ''; try { const k = Buffer.from(e.key); k[40] ^= 1; ac.decryptAttachment(e.data, k, e.digest); } catch (x) { err = x.message; }
check('wrong mac key -> HMAC mismatch', /HMAC/.test(err), err);

// Independent vector: build the blob with openssl (AES-256-CBC + HMAC-SHA256) and decrypt it with our code;
// and decrypt our blob with openssl.
const d = tmpdir('attc-'); const key = crypto.randomBytes(64), iv = crypto.randomBytes(16);
const plainFile = path.join(d, 'p.bin'); fs.writeFileSync(plainFile, crypto.randomBytes(777));
const ct = execFileSync('openssl', ['enc', '-aes-256-cbc', '-K', key.subarray(0, 32).toString('hex'), '-iv', iv.toString('hex'), '-in', plainFile]);
fs.writeFileSync(path.join(d, 'ivct.bin'), Buffer.concat([iv, ct]));
const macHex = execFileSync('openssl', ['dgst', '-sha256', '-mac', 'HMAC', '-macopt', 'hexkey:' + key.subarray(32).toString('hex'), '-r', path.join(d, 'ivct.bin')]).toString().split(/\s/)[0];
const blob = Buffer.concat([iv, ct, Buffer.from(macHex, 'hex')]);
check('openssl-built blob decrypts', ac.decryptAttachment(blob, key, ac.sha256(blob)).equals(fs.readFileSync(plainFile)));
const ours = ac.encryptAttachment(fs.readFileSync(plainFile), key, iv);
check('our blob == openssl blob (same key/iv)', ours.data.equals(blob));
fs.writeFileSync(path.join(d, 'ct.bin'), ours.data.subarray(16, ours.data.length - 32));
const back = execFileSync('openssl', ['enc', '-d', '-aes-256-cbc', '-K', key.subarray(0, 32).toString('hex'), '-iv', iv.toString('hex'), '-in', path.join(d, 'ct.bin')]);
check('openssl decrypts our blob', back.equals(fs.readFileSync(plainFile)));
finish('attachment-crypto');
