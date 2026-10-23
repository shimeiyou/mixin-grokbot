'use strict';
// Cached lookups (fake API). LIVE=1 adds ONE read-only GET /users/<bot id> with the real keystore (prints field names only).
const fs = require('fs'); const path = require('path');
const { MixinApi } = require('@mixin.dev/mixin-node-sdk');
const { createLookup } = require('./lookup');
const { check, finish, fakeKeystore, ksJson, fakeMixinApi, tmpdir, uuid, sleep } = require('./test-helpers');
(async () => {
  const U = uuid(), S = uuid(), MISSING = uuid();
  const srv = await fakeMixinApi({ users: { [U]: { user_id: U, full_name: 'A', identity_number: '7000' } }, stickers: { [S]: { sticker_id: S, name: 's', asset_url: 'https://a' } } });
  const api = MixinApi({ keystore: JSON.parse(ksJson(fakeKeystore())), requestConfig: { baseURL: srv.url, timeout: 3000 } });
  const file = path.join(tmpdir('lk-'), 'cache.json');
  const lk = createLookup({ api, file, negTtlMs: 200 });
  const [a, b] = await Promise.all([lk.user(U), lk.user(U)]);
  check('user lookup + in-flight dedupe', a.full_name === 'A' && b.identity_number === '7000' && srv.reqs.filter((r) => r.url === `/users/${U}`).length === 1);
  await lk.user(U); check('cached', srv.reqs.filter((r) => r.url === `/users/${U}`).length === 1);
  check('sticker lookup', (await lk.sticker(S)).asset_url === 'https://a');
  check('missing -> null (negative cache)', (await lk.user(MISSING)) === null && (await lk.user(MISSING)) === null && srv.reqs.filter((r) => r.url === `/users/${MISSING}`).length === 1);
  check('non-uuid -> null, no request', (await lk.user('../../x')) === null && !srv.reqs.some((r) => r.url.includes('..')));
  await sleep(1300);
  check('file cache written 0600', (fs.statSync(file).mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(file))[`user:${U}`]);
  const lk2 = createLookup({ api, file }); await lk2.user(U);
  check('file cache reused after restart', srv.reqs.filter((r) => r.url === `/users/${U}`).length === 1);
  await srv.close();
  if (process.env.LIVE === '1') {
    const { loadKeystore } = require('./common'); const ks = loadKeystore();
    const live = createLookup({ api: MixinApi({ keystore: ks }) });
    const me = await live.user(ks.app_id);
    console.log('LIVE GET /users/<bot> fields:', me ? Object.keys(me).filter((k) => me[k] != null).join(',') : 'null');
    check('LIVE read-only user lookup returns full_name + identity_number', !!(me && me.full_name && me.identity_number));
  }
  finish('lookup');
})().catch((e) => { console.error(e); process.exit(1); });
