'use strict';
// Inbound attachment download into a private dir (0700, files 0600) with size/type caps and TTL cleanup.
// PLAIN_*: GET /attachments/{id} -> view_url -> plaintext.  ENCRYPTED_*: same download, then digest + HMAC check and
// AES-256-CBC decrypt with the 64-byte key from the (decrypted) message JSON (see attachment-crypto.js).
const fs = require('fs');
const path = require('path');
const { decryptAttachment, ciphertextLength, sha256 } = require('./attachment-crypto');
const { extForMime, sniffMime, baseMime } = require('./media-info');

const DEFAULT_TYPES = 'image/,video/,audio/,application/pdf,text/,application/json,application/zip,application/msword,application/vnd.openxmlformats-officedocument.,application/vnd.ms-excel,application/vnd.ms-powerpoint';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Files we create are always "<message_id uuid>.<ext>"; cleanup never touches anything else in the dir.
const NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i;
const safeId = (id) => (UUID_RE.test(String(id || '')) ? String(id).toLowerCase() : '');

function createMedia({ api, log = () => {}, dir, maxBytes = 20 << 20, totalMaxBytes = 1 << 30, ttlMs = 24 * 3600e3,
  types = DEFAULT_TYPES, timeoutMs = 60000, fetchImpl = fetch }) {
  const prefixes = String(types).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowed = (m) => { const b = baseMime(m); return !!b && prefixes.some((p) => (p.endsWith('/') || p.endsWith('.') ? b.startsWith(p) : b === p)); };
  function ensureDir() { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch (_) {} }

  // Only touches files this module created (NAME_RE / our .tmp names) inside `dir`.
  function cleanup(now = Date.now()) {
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { return { removed: 0 }; }
    let removed = 0; const live = [];
    for (const f of files) {
      const p = path.join(dir, f);
      const isTmp = /^\.dl-[0-9a-f-]{36}\.\d+\.tmp$/i.test(f);
      if (!isTmp && !NAME_RE.test(f)) continue;
      let st; try { st = fs.statSync(p); } catch (_) { continue; }
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > (isTmp ? 3600e3 : ttlMs)) { try { fs.unlinkSync(p); removed++; } catch (_) {} continue; }
      if (!isTmp) live.push({ p, size: st.size, t: st.mtimeMs });
    }
    let total = live.reduce((s, x) => s + x.size, 0);
    live.sort((a, b) => a.t - b.t);
    while (total > totalMaxBytes && live.length) { const x = live.shift(); try { fs.unlinkSync(x.p); removed++; total -= x.size; } catch (_) {} }
    if (removed) log(`media cleanup removed=${removed}`);
    return { removed, total };
  }

  function remove(messageId) {
    const id = safeId(messageId); if (!id) return 0;
    let n = 0;
    try { for (const f of fs.readdirSync(dir)) if (NAME_RE.test(f) && f.startsWith(id + '.')) { fs.unlinkSync(path.join(dir, f)); n++; } } catch (_) {}
    return n;
  }

  async function readCapped(res, cap) {
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > cap) throw new Error(`too large: content-length ${len} > ${cap}`);
    const chunks = []; let n = 0;
    for await (const ch of res.body) { n += ch.length; if (n > cap) throw new Error(`too large: >${cap} bytes`); chunks.push(Buffer.from(ch)); }
    return Buffer.concat(chunks);
  }

  // att: payload.attachment (public), priv: {key,digest}. Returns {local_path, local_mime, sha256, bytes, view_url}.
  async function download(messageId, att, priv = {}) {
    if (!att || !att.attachment_id) throw new Error('no attachment_id');
    if (!safeId(messageId)) throw new Error('bad message_id');
    const encrypted = priv.key != null;
    if (!allowed(att.mime_type)) throw new Error(`type not allowed: ${baseMime(att.mime_type) || 'unknown'}`);
    if (att.size != null && att.size > maxBytes) throw new Error(`too large: ${att.size} > ${maxBytes}`);
    const meta = await api.attachment.fetch(att.attachment_id);
    if (!meta || !meta.view_url) throw new Error('no view_url');
    const cap = encrypted ? ciphertextLength(maxBytes) : maxBytes;
    const res = await fetchImpl(meta.view_url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`download status ${res.status}`);
    let buf = await readCapped(res, cap);
    if (encrypted) buf = decryptAttachment(buf, priv.key, priv.digest);
    if (buf.length > maxBytes) throw new Error(`too large: ${buf.length} > ${maxBytes}`);
    const sniffed = sniffMime(buf);
    const mime = sniffed || baseMime(att.mime_type) || 'application/octet-stream';
    if (sniffed && !allowed(sniffed)) throw new Error(`type not allowed (sniffed): ${sniffed}`);
    if (!sniffed && baseMime(att.mime_type).startsWith('image/')) throw new Error('content is not a recognised image');
    ensureDir();
    const id = safeId(messageId);
    const file = path.join(dir, `${id}.${extForMime(mime)}`);
    const tmp = path.join(dir, `.dl-${id}.${process.pid}.tmp`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    cleanup();
    return { local_path: file, local_mime: mime, sha256: sha256(buf).toString('hex'), bytes: buf.length, view_url: encrypted ? undefined : meta.view_url };
  }
  return { download, cleanup, remove, allowed, ensureDir, dir };
}
module.exports = { createMedia, DEFAULT_TYPES };
