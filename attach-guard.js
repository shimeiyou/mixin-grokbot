'use strict';
const fs = require('fs');
const path = require('path');

const CODE = 'ATTACH_PATH_DENIED';
class AttachDenied extends Error { constructor(m) { super(m); this.code = CODE; } }

function allowedDirs(env = process.env, gwDir = __dirname) {
  const raw = env.MIXIN_ATTACH_DIRS != null && String(env.MIXIN_ATTACH_DIRS).trim() !== ''
    ? String(env.MIXIN_ATTACH_DIRS).split(':')
    : [env.MIXIN_MEDIA_DIR || path.resolve(gwDir, '..', 'mixin-media')];
  const out = [];
  for (const d of raw.map((s) => s.trim()).filter(Boolean)) {
    if (!path.isAbsolute(d)) continue; // relative entries are ignored (would depend on the caller's cwd)
    let r; try { r = fs.realpathSync(d); } catch (_) { r = path.resolve(d); } // missing dir: still listed, nothing can match
    if (!out.includes(r)) out.push(r);
  }
  return out;
}
const inside = (p, dir) => p === dir ? false : p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

function checkAttachPath(p, { flag = 'file', env = process.env, gwDir = __dirname } = {}) {
  const s = p == null ? '' : String(p);
  if (!s.trim()) throw new AttachDenied(`--${flag}: empty path`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) throw new AttachDenied(`--${flag}: remote/URL sources are not allowed; give a local file inside MIXIN_ATTACH_DIRS`);
  if (s.includes('\0')) throw new AttachDenied(`--${flag}: invalid path`);
  const dirs = allowedDirs(env, gwDir);
  const abs = path.resolve(s);
  let real, missing = false;
  try { real = fs.realpathSync(abs); } catch (_) { missing = true; real = abs; }
  if (missing) { // resolve the deepest existing parent so a symlinked parent can't sneak out
    let dir = path.dirname(abs), rest = [path.basename(abs)];
    for (;;) { try { real = path.join(fs.realpathSync(dir), ...rest); break; } catch (_) { if (dir === path.dirname(dir)) break; rest.unshift(path.basename(dir)); dir = path.dirname(dir); } }
  }
  if (!dirs.some((d) => inside(real, d))) throw new AttachDenied(`--${flag}: path is outside the allowed attachment dirs (${dirs.join(':') || 'none'}); copy the file there first (e.g. deploy/fetch-media.sh)`);
  return { real, missing };
}
module.exports = { checkAttachPath, allowedDirs, AttachDenied, CODE };
