'use strict';
// Upload a local file (attach-guard allowlist applies) to Mixin's attachment storage and print its public view_url.
// usage: node tools/upload-attachment.js <path>   (needs the gateway env / keystore like reply.js). Prints {"ok","attachment_id","view_url"}.
const fs = require('fs'); const path = require('path');
const { MixinApi } = require('@mixin.dev/mixin-node-sdk'); const { loadKeystore } = require('../common'); const { checkAttachPath } = require('../attach-guard');
(async () => {
  const p = process.argv[2]; if (!p) { console.error('usage: node tools/upload-attachment.js <path>'); process.exit(2); }
  try { checkAttachPath(path.resolve(p), { flag: 'image' }); } catch (e) { console.log(JSON.stringify({ ok: false, code: e.code || 'ATTACH_PATH_DENIED', error: e.message })); process.exit(2); }
  const api = MixinApi({ keystore: loadKeystore() }); const a = await api.attachment.create();
  const r = await fetch(a.upload_url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'x-amz-acl': 'public-read' }, body: fs.readFileSync(p), signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`upload status ${r.status}`);
  const g = await api.attachment.fetch(a.attachment_id);
  console.log(JSON.stringify({ ok: true, attachment_id: a.attachment_id, view_url: g.view_url }));
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) })); process.exit(1); });
