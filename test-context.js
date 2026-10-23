'use strict';
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cs = require('./context-store');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
const o = { dir, max: 3, maxAgeMs: 3600e3, maxText: 10, maxFileBytes: 100000 };
const now = Date.now(), iso = (d) => new Date(now - d).toISOString();
const C = 'c0ffee00-0000-4000-8000-000000000001';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };
t('empty', () => assert.deepStrictEqual(cs.recent(C, null, o), []));
t('append + exclude current', () => {
  cs.append({ conversation_id: C, user_id: 'u1', message_id: 'm1', text: 'hello', created_at: iso(5000) }, o);
  cs.append({ conversation_id: C, user_id: 'u1', message_id: 'm2', text: 'world', created_at: iso(4000) }, o);
  const r = cs.recent(C, 'm2', o);
  assert.deepStrictEqual(r, [{ user_id: 'u1', message_id: 'm1', text: 'hello', created_at: iso(5000), from_bot: false }]);
});
t('dedupe by message_id', () => { cs.append({ conversation_id: C, message_id: 'm1', text: 'hello', created_at: iso(5000) }, o); assert.strictEqual(cs.recent(C, null, o).length, 2); });
t('count cap N', () => {
  cs.append({ conversation_id: C, user_id: 'bot', message_id: 'm3', text: 'r', created_at: iso(3000), from_bot: true }, o);
  cs.append({ conversation_id: C, message_id: 'm4', text: 'x', created_at: iso(2000) }, o);
  const r = cs.recent(C, null, o); assert.deepStrictEqual(r.map((m) => m.message_id), ['m2', 'm3', 'm4']); assert.strictEqual(r[1].from_bot, true);
});
t('age cap', () => {
  const C2 = C.replace(/1$/, '2');
  cs.append({ conversation_id: C2, message_id: 'old', text: 'o', created_at: iso(7200e3) }, o);
  cs.append({ conversation_id: C2, message_id: 'new', text: 'n', created_at: iso(1000) }, o);
  assert.deepStrictEqual(cs.recent(C2, null, o).map((m) => m.message_id), ['new']);
});
t('text truncated', () => { cs.append({ conversation_id: C, message_id: 'm5', text: 'abcdefghijklmnop', created_at: iso(500) }, o); assert.strictEqual(cs.recent(C, null, o).pop().text.length, 10); });
t('file byte cap', () => {
  const C3 = C.replace(/1$/, '3'); const o2 = { ...o, max: 100, maxText: 1000, maxFileBytes: 600 };
  for (let i = 0; i < 20; i++) cs.append({ conversation_id: C3, message_id: 'b' + i, text: 'y'.repeat(100), created_at: iso(10000 - i) }, o2);
  assert.ok(fs.statSync(path.join(dir, C3 + '.json')).size <= 600); assert.strictEqual(cs.recent(C3, null, o2).pop().message_id, 'b19');
});
t('path traversal sanitized, no tmp/lock left', () => {
  cs.append({ conversation_id: '../../etc/x', message_id: 'z', text: 't' }, o);
  assert.ok(fs.existsSync(path.join(dir, 'etcx.json')));
  assert.ok(!fs.readdirSync(dir).some((f) => /\.(tmp|lock)$/.test(f)));
});
t('corrupt file tolerated', () => { const C4 = C.replace(/1$/, '4'); fs.writeFileSync(path.join(dir, C4 + '.json'), '{bad'); cs.append({ conversation_id: C4, message_id: 'q', text: 'q' }, o); assert.strictEqual(cs.recent(C4, null, o).length, 1); });
t('enabled flag defaults off', () => { delete process.env.MIXIN_WEBHOOK_CONTEXT; assert.strictEqual(cs.enabled(), false); process.env.MIXIN_WEBHOOK_CONTEXT = '1'; assert.strictEqual(cs.enabled(), true); delete process.env.MIXIN_WEBHOOK_CONTEXT; });
t('concurrent writers (child processes)', () => {
  const C5 = C.replace(/1$/, '5'); const { spawnSync } = require('child_process');
  const code = `const cs=require(${JSON.stringify(path.resolve('context-store.js'))});for(let i=0;i<30;i++)cs.append({conversation_id:'${C5}',message_id:process.argv[1]+i,text:'t'},{dir:${JSON.stringify(dir)},max:1000,maxAgeMs:1e9,maxText:10,maxFileBytes:1e6});`;
  const r = spawnSync('bash', ['-c', 'for p in a b c; do "$0" -e "$1" $p & done; wait', process.execPath, code], { timeout: 30000 });
  assert.strictEqual(r.status, 0, String(r.stderr));
  assert.strictEqual(cs.recent(C5, null, { ...o, max: 1000 }).length, 90);
});
console.log(`context tests passed: ${n}`);
