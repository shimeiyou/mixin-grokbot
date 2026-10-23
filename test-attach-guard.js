'use strict';
// attach-guard.js + reply.js --image/--video/--audio/--file path allowlist (2026-10-19). Offline: fake Mixin API,
// temp dirs, clean env. Checks: realpath containment (symlinks, ".."), URL refusal, MIXIN_ATTACH_DIRS / media-dir
// default, and that a refused run exits 2 with code ATTACH_PATH_DENIED and sends NOTHING (no upload, no message).
const fs = require('fs'); const path = require('path');
const { check, finish, uuid, fakeKeystore, ksJson, tmpdir, fakeMixinApi, runNode, curvePub } = require('./test-helpers');
const { checkAttachPath, allowedDirs } = require('./attach-guard');
const { uniqueConversationId } = require('./conversation-target');
const crypto = require('crypto');
const HERE = __dirname;
const W = tmpdir('attach-guard-'); const OK = path.join(W, 'media'); const OUT = path.join(W, 'outside'); const OK2 = path.join(W, 'second');
for (const d of [OK, OUT, OK2, path.join(OK, 'sub')]) fs.mkdirSync(d, { recursive: true });
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 10, 0, 0, 0, 7, 8, 2, 0, 0, 0]), crypto.randomBytes(200)]);
fs.writeFileSync(path.join(OK, 'a.png'), PNG); fs.writeFileSync(path.join(OK, 'sub', 'b.txt'), 'x');
fs.writeFileSync(path.join(OUT, 'secret.env'), 'MIXIN_FAKE_SECRET=1'); fs.writeFileSync(path.join(OUT, 'o.png'), PNG); fs.writeFileSync(path.join(OK2, 'c.txt'), 'y');
fs.symlinkSync(path.join(OUT, 'secret.env'), path.join(OK, 'link-out.env'));   // symlink inside -> file outside
fs.symlinkSync(OUT, path.join(OK, 'dirlink'));                                  // symlinked dir inside -> outside
fs.symlinkSync(path.join(OK, 'a.png'), path.join(OK, 'link-in.png'));           // symlink inside -> inside (allowed)
const env = { MIXIN_ATTACH_DIRS: `${OK}:${OK2}` };
const denied = (p, e = env) => { try { checkAttachPath(p, { env: e }); return false; } catch (err) { return err.code === 'ATTACH_PATH_DENIED'; } };

(async () => {
  // ---- unit ----
  check('allowedDirs: MIXIN_ATTACH_DIRS colon list (realpath, relative entries ignored)', JSON.stringify(allowedDirs({ MIXIN_ATTACH_DIRS: `${OK}:rel/dir:${OK2}` })) === JSON.stringify([fs.realpathSync(OK), fs.realpathSync(OK2)]));
  check('allowedDirs default: MIXIN_MEDIA_DIR', JSON.stringify(allowedDirs({ MIXIN_MEDIA_DIR: OK })) === JSON.stringify([fs.realpathSync(OK)]));
  check('allowedDirs default without env: <gateway>/../mixin-media', allowedDirs({})[0].endsWith(`${path.sep}mixin-media`) && path.dirname(allowedDirs({}, HERE)[0]) === fs.realpathSync(path.dirname(HERE)));
  check('file inside allowed dir -> ok (real path returned)', checkAttachPath(path.join(OK, 'a.png'), { env }).real === fs.realpathSync(path.join(OK, 'a.png')));
  check('file in a subdir and in the 2nd dir -> ok', !denied(path.join(OK, 'sub', 'b.txt')) && !denied(path.join(OK2, 'c.txt')));
  check('symlink inside -> inside: ok, resolves to the target', checkAttachPath(path.join(OK, 'link-in.png'), { env }).real === fs.realpathSync(path.join(OK, 'a.png')));
  check('symlink inside -> file outside: DENIED', denied(path.join(OK, 'link-out.env')));
  check('through a symlinked dir: DENIED', denied(path.join(OK, 'dirlink', 'secret.env')));
  check('".." escape: DENIED', denied(`${OK}/../outside/secret.env`) && denied(`${OK}/sub/../../outside/o.png`));
  check('outside absolute path: DENIED (/etc/passwd, other dir)', denied('/etc/passwd') && denied(path.join(OUT, 'o.png')));
  check('the allowed dir itself / prefix-sibling dir: DENIED', denied(OK) && (fs.mkdirSync(OK + 'x', { recursive: true }), fs.writeFileSync(path.join(OK + 'x', 'z.png'), PNG), denied(path.join(OK + 'x', 'z.png'))));
  check('URLs: http/https/file/data/ftp and //host -> DENIED', ['http://x/a.png', 'https://x/a.png', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'ftp://h/f', '//host/a.png'].every((u) => denied(u)));
  check('empty / NUL path -> DENIED', denied('') && denied(`${OK}/a\0.png`));
  { const r = checkAttachPath(path.join(OK, 'missing.png'), { env }); check('missing file inside -> {missing:true} (reply.js keeps "file not found")', r.missing === true); }
  check('missing file outside -> DENIED', denied(path.join(OUT, 'nope.png')));
  check('relative path resolved against cwd', (() => { const cwd = process.cwd(); try { process.chdir(OK); return !denied('a.png') && denied('../outside/o.png'); } finally { process.chdir(cwd); } })());

  // ---- reply.js end to end: refused runs send nothing ----
  const ks = fakeKeystore(); const USER = uuid(); const CONV = uniqueConversationId(ks.app_id, USER);
  const rSess = { session_id: uuid(), public_key: curvePub(crypto.randomBytes(32)), user_id: USER };
  const run = async (args, extraEnv = {}) => {
    const api = await fakeMixinApi({ sessions: { [USER]: [rSess] } });
    const p = runNode(['reply.js', '--conversation', CONV, '--user', USER, '--reply-to', uuid(), ...args], { cwd: HERE, timeoutMs: 60000,
      env: { MIXIN_KEYSTORE_JSON: ksJson(ks), MIXIN_GATEWAY_LOG: path.join(W, 'g.log'), MIXIN_API_BASE: api.url, HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', MIXIN_CONV_CACHE_FILE: path.join(W, 'cc.json'), MIXIN_CONTEXT_DIR: path.join(W, 'ctx'), MIXIN_BLAZE_URL: 'ws://127.0.0.1:9', MIXIN_SEND_ENDPOINT: '0', ...env, ...extraEnv } });
    const r = await p.done; await api.close();
    let json = null; try { json = JSON.parse(r.err.trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch (_) {}
    return { ...r, api: api.state, reqs: api.reqs, json };
  };
  const nothing = (n) => n.api.created.length === 0 && (n.api.messages || []).length === 0 && (n.api.encrypted || []).length === 0 && Object.keys(n.api.uploads || {}).length === 0;
  { const n = await run(['--image', path.join(OK, 'a.png')]);
    check('allowed --image: sent (PLAIN_IMAGE, exit 0)', n.code === 0 && n.api.messages.length === 1 && n.api.messages[0].category === 'PLAIN_IMAGE', n.err.slice(-300)); }
  for (const [name, args] of [
    ['--image outside', ['--image', path.join(OUT, 'o.png')]],
    ['--file symlink escape', ['--file', path.join(OK, 'link-out.env')]],
    ['--file ".." escape', ['--file', `${OK}/../outside/secret.env`]],
    ['--image https URL', ['--image', 'https://example.com/a.png']],
    ['--video file:// URL', ['--video', 'file:///etc/hostname']],
    ['--audio /etc/passwd', ['--audio', '/etc/passwd']],
    ['--text + denied --image (text must NOT go out either)', ['--text', 'hi', '--image', path.join(OUT, 'o.png')]],
  ]) {
    const n = await run(args);
    check(`${name}: exit 2, code ATTACH_PATH_DENIED, nothing uploaded or sent`, n.code === 2 && n.json && n.json.code === 'ATTACH_PATH_DENIED' && nothing(n), { code: n.code, json: n.json });
  }
  { const n = await run(['--file', path.join(OUT, 'secret.env')]);
    check('denied run: stdout/stderr/log never contain the file content', !n.out.includes('MIXIN_FAKE_SECRET') && !n.err.includes('MIXIN_FAKE_SECRET') && !fs.readFileSync(path.join(W, 'g.log'), 'utf8').includes('MIXIN_FAKE_SECRET')); }
  { const n = await run(['--image', path.join(OK, 'a.png')], { MIXIN_ATTACH_DIRS: '', MIXIN_MEDIA_DIR: OK });
    check('MIXIN_ATTACH_DIRS unset -> media dir default allows it', n.code === 0 && n.api.messages.length === 1, n.err.slice(-300)); }
  { const n = await run(['--image', path.join(OK, 'a.png')], { MIXIN_ATTACH_DIRS: '', MIXIN_MEDIA_DIR: OK2 });
    check('file outside the media-dir default -> DENIED', n.code === 2 && n.json && n.json.code === 'ATTACH_PATH_DENIED' && nothing(n)); }
  { const n = await run(['--text', 'plain only']); check('no attachment flags -> unchanged (text sent)', n.code === 0 && n.api.messages.length === 1); }
  fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(OK + 'x', { recursive: true, force: true });
  finish('attach-guard');
})().catch((e) => { console.error('FAIL crash', e); process.exit(1); });
