#!/usr/bin/env bash
# Dry configuration check (no Blaze connection, no network, nothing sent). Prints names/shapes only, never values.
# Usage: deploy/config-check.sh   (env: MIXIN_ENV_FILE). Exit 0 = ready to start, 1 = a problem.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
rc=0; bad() { say "PROBLEM $*"; rc=1; }
load_env || bad "required env missing"
cd "$GW_DIR" || exit 1
v=$(node -v 2>/dev/null) || bad "node not on PATH"; say "node $v"; [ "${v#v}" \> "20" ] || bad "node >= 20 needed"
ensure_deps || bad "deps"
node - <<'JS' || rc=1
const fs = require('fs'), path = require('path');
const say = (m) => console.log(`[${new Date().toISOString()}] ${m}`); let ok = true; const bad = (m) => { ok = false; say('PROBLEM ' + m); };
let ks; try { ks = JSON.parse(process.env.MIXIN_KEYSTORE_JSON || ''); } catch (_) { bad('MIXIN_KEYSTORE_JSON is not JSON'); }
if (ks) { const need = ['app_id', 'session_id', 'session_private_key', 'server_public_key']; const miss = need.filter((k) => !ks[k]); if (miss.length) bad('keystore lacks ' + miss.join(',')); else say(`keystore fields ok (${Object.keys(ks).sort().join(',')}; values not shown)`); if (ks.spend_private_key || ks.pin) say('NOTE keystore has spend fields'); }
try { const u = new URL(process.env.MIXIN_WEBHOOK_URL || ''); if (u.protocol !== 'https:') bad('webhook URL is not https'); else say('webhook URL https ok (not shown)'); } catch (_) { bad('MIXIN_WEBHOOK_URL is not a URL'); }
try { const a = JSON.parse(fs.readFileSync(process.env.MIXIN_ALLOWLIST_FILE || 'allowlist.json', 'utf8')); if (!Array.isArray(a) || !a.length) bad('allowlist empty (fail closed)'); else say(`allowlist entries=${a.length}`); } catch (e) { bad('allowlist.json unreadable: ' + e.code); }
const dirs = { run: path.join(__dirname || '.', 'run'), queue: process.env.MIXIN_QUEUE_DIR || 'queue', context: process.env.MIXIN_CONTEXT_DIR || 'context', media: process.env.MIXIN_MEDIA_DIR || path.resolve('..', 'mixin-media') };
for (const [k, d] of Object.entries(dirs)) { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700); fs.accessSync(d, fs.constants.W_OK); say(`dir ${k}=${path.resolve(d)} writable 0700`); } catch (e) { bad(`dir ${k} ${d}: ${e.code}`); } }
const flags = Object.keys(process.env).filter((k) => /^MIXIN_/.test(k) && /^(0|1)$/.test(process.env[k])).map((k) => `${k.slice(6)}=${process.env[k]}`).sort();
say('flags ' + flags.join(' '));
for (const f of fs.readdirSync('.').filter((f) => f.endsWith('.js'))) { try { require('child_process').execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (_) { bad('syntax ' + f); } }
say('all *.js parse');
process.exit(ok ? 0 : 1);
JS
p=$(pgrep -fx 'node gateway.js' | tr '\n' ' '); [ -z "$p" ] && say "no gateway running on this host" || say "NOTE gateway already running here (pid $p)"
[ $rc = 0 ] && say "CONFIG OK (dry: no Blaze connection made)"; exit $rc
