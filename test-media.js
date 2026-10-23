'use strict';
// Step 5 (inbound): attachment download, decrypt, caps, TTL cleanup, permissions. Fake API + fake blob server.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { MixinApi } = require('@mixin.dev/mixin-node-sdk');
const { createMedia } = require('./media');
const { encryptAttachment, sha256 } = require('./attachment-crypto');
const { check, finish, tmpdir, fakeMixinApi, fakeKeystore, ksJson, uuid } = require('./test-helpers');
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 10, 0, 0, 0, 7]), crypto.randomBytes(200)]);

(async () => {
  const ks = fakeKeystore();
  const plainId = uuid(), encId = uuid(), badId = uuid(), exeId = uuid(), bigId = uuid();
  const enc = encryptAttachment(PNG);
  const api0 = await fakeMixinApi({ blobs: { [plainId]: PNG, [encId]: enc.data, [badId]: enc.data, [exeId]: Buffer.from('MZ\x90\x00 fake exe'), [bigId]: crypto.randomBytes(3000) } });
  const api = MixinApi({ keystore: JSON.parse(ksJson(ks)), requestConfig: { baseURL: api0.url, timeout: 5000 } });
  const dir = path.join(tmpdir('media-'), 'mixin-media');
  const logs = []; const m = createMedia({ api, dir, log: (s) => logs.push(s), maxBytes: 2000, totalMaxBytes: 300 });
  const mid = uuid();
  const r1 = await m.download(mid, { attachment_id: plainId, mime_type: 'image/png', size: PNG.length }, {});
  check('plain download saved, sniffed mime, sha256', fs.readFileSync(r1.local_path).equals(PNG) && r1.local_mime === 'image/png' && r1.local_path.endsWith(`${mid}.png`) && r1.sha256 === sha256(PNG).toString('hex') && r1.view_url, r1);
  check('dir 0700 + file 0600', mode(dir) === '700' && mode(r1.local_path) === '600', [mode(dir), mode(r1.local_path)]);
  const mid2 = uuid();
  const r2 = await m.download(mid2, { attachment_id: encId, mime_type: 'image/png', size: PNG.length }, { key: enc.key.toString('base64'), digest: enc.digest.toString('base64') });
  check('encrypted download decrypted + digest/HMAC verified, no view_url', fs.readFileSync(r2.local_path).equals(PNG) && r2.view_url === undefined);
  check('total cap enforced (oldest removed)', !fs.existsSync(r1.local_path) && fs.existsSync(r2.local_path));
  let err = ''; try { await m.download(uuid(), { attachment_id: badId, mime_type: 'image/png' }, { key: enc.key, digest: crypto.randomBytes(32).toString('base64') }); } catch (e) { err = e.message; }
  check('wrong digest rejected, nothing written', /digest mismatch/.test(err) && fs.readdirSync(dir).length === 1, err);
  err = ''; try { await m.download(uuid(), { attachment_id: exeId, mime_type: 'application/x-msdownload' }, {}); } catch (e) { err = e.message; }
  check('disallowed type rejected before download', /type not allowed/.test(err), err);
  err = ''; try { await m.download(uuid(), { attachment_id: bigId, mime_type: 'image/png', size: 3000 }, {}); } catch (e) { err = e.message; }
  check('declared size over cap rejected', /too large/.test(err), err);
  err = ''; try { await m.download(uuid(), { attachment_id: bigId, mime_type: 'image/png', size: 10 }, {}); } catch (e) { err = e.message; }
  check('actual size over cap rejected while streaming (lying size)', /too large/.test(err), err);
  err = ''; try { await m.download(uuid(), { attachment_id: exeId, mime_type: 'image/png', size: 10 }, {}); } catch (e) { err = e.message; }
  check('declared image but bytes are not an image -> rejected', /not a recognised image/.test(err) && fs.readdirSync(dir).length === 1, err);
  err = ''; try { await m.download('../../etc/passwd', { attachment_id: plainId, mime_type: 'image/png' }, {}); } catch (e) { err = e.message; }
  check('non-uuid message_id rejected (no path tricks)', /bad message_id/.test(err), err);
  // TTL cleanup + foreign files untouched
  const foreign = path.join(dir, 'notes.txt'); fs.writeFileSync(foreign, 'keep me');
  const old = new Date(Date.now() - 2 * 86400e3); fs.utimesSync(r2.local_path, old, old); fs.utimesSync(foreign, old, old);
  const c = m.cleanup();
  check('TTL cleanup removes expired media only', !fs.existsSync(r2.local_path) && fs.existsSync(foreign) && c.removed >= 1, c);
  const r3 = await m.download(mid, { attachment_id: plainId, mime_type: 'image/png' }, {});
  check('remove(message_id) (recall)', m.remove(mid) === 1 && !fs.existsSync(r3.local_path));
  check('allowed(): prefixes', m.allowed('image/jpeg') && m.allowed('application/vnd.openxmlformats-officedocument.wordprocessingml.document') && !m.allowed('application/x-sh') && !m.allowed(''));
  await api0.close(); finish('media');
})().catch((e) => { console.error(e); process.exit(1); });
