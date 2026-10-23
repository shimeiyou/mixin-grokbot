'use strict';
// Step 3: persistent webhook queue (unit level, fake webhook server, temp dirs).
const fs = require('fs'); const path = require('path');
const { createDelivery } = require('./webhook-queue');
const { check, finish, tmpdir, httpServer, waitFor, sleep, uuid } = require('./test-helpers');
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);

(async () => {
  let status = 503; const got = [];
  const hook = await httpServer((r) => { if (r.method === 'POST') { if (status === 200) got.push(JSON.parse(r.body)); return { status, body: '' }; } });
  const logs = [];
  const mk = (dir, extra = {}) => createDelivery({ url: hook.url, log: (...a) => logs.push(a.join(' ')), headers: () => ({ 'Content-Type': 'application/json', 'X-Webhook-Key': 'k' }),
    queue: { enabled: true, dir, baseBackoffMs: 50, maxBackoffMs: 200, scanMs: 100, ...extra } });
  const dir = tmpdir('q-'); const qdir = path.join(dir, 'queue');
  const pl = (i) => ({ conversation_id: 'c', user_id: 'u', message_id: uuid(), category: 'PLAIN_TEXT', text: `t${i}`, created_at: new Date().toISOString() });

  // 1) records are on disk synchronously (before the caller ACKs), 0600 in a 0700 dir
  const d1 = mk(qdir); const p1 = [pl(1), pl(2), pl(3)];
  const res = p1.map((p) => d1.submit(p, null, false));
  const files = fs.readdirSync(qdir).filter((f) => f.endsWith('.json'));
  check('submit is synchronous + persisted', res.every((r) => r === 'queued') && files.length === 3, { res, files });
  check('perms dir 0700, files 0600', mode(qdir) === '700' && files.every((f) => mode(path.join(qdir, f)) === '600'), { d: mode(qdir) });
  await waitFor(() => logs.filter((l) => /retryable status=503/.test(l)).length >= 6, 5000);
  check('retries with backoff while webhook is 503', logs.filter((l) => /retryable status=503/.test(l)).length >= 6);
  const rec = JSON.parse(fs.readFileSync(path.join(qdir, files[0])));
  check('attempts + next_at persisted', rec.attempts >= 1 && rec.next_at > rec.enqueued_at, rec);
  // 2) "crash": drop the instance without any flush, start a new one on the same dir, webhook recovers
  d1.stop(); await sleep(300);
  // leave an interrupted tmp write + a corrupt record behind
  fs.writeFileSync(path.join(qdir, '.junk.json.12345.tmp'), '{'); fs.writeFileSync(path.join(qdir, 'bad-record.json'), '{not json');
  status = 200; logs.length = 0;
  const d2 = mk(qdir);
  await waitFor(() => got.length >= 3, 5000);
  check('after restart all 3 delivered exactly once', got.length === 3 && new Set(got.map((g) => g.message_id)).size === 3 && p1.every((p) => got.some((g) => g.message_id === p.message_id)), got.length);
  check('payload delivered unchanged', JSON.stringify(got.find((g) => g.message_id === p1[0].message_id)) === JSON.stringify(p1[0]));
  check('queue dir emptied, tmp cleaned, corrupt -> dead/', fs.readdirSync(qdir).filter((f) => f !== 'dead' && f !== 'sent-ids.txt').length === 0 && fs.existsSync(path.join(qdir, 'dead', 'bad-record.corrupt.json')), fs.readdirSync(qdir));
  check('loaded log line', logs.some((l) => /queue loaded pending=3/.test(l)) && logs.some((l) => /corrupt record bad-record.json/.test(l)));
  // 3) non-retryable 400 -> dead letter, no more attempts; priv stripped
  status = 400; logs.length = 0;
  const p4 = pl(4); d2.submit(p4, { key: 'SECRET' }, false);
  await waitFor(() => logs.some((l) => /non-retryable/.test(l)), 3000); await sleep(100);
  const deadf = path.join(qdir, 'dead', `${p4.message_id}.json`);
  check('400 -> dead/ with reason, not retried', fs.existsSync(deadf) && JSON.parse(fs.readFileSync(deadf)).dead_reason === 'status 400' && logs.filter((l) => /msg=/.test(l) && l.includes(p4.message_id)).length === 1);
  check('dead record carries no private key material', !fs.readFileSync(deadf, 'utf8').includes('SECRET'));
  // 4) max attempts -> GAVE UP -> dead
  status = 500; logs.length = 0; d2.stop();
  const d3 = mk(qdir, { maxAttempts: 3 }); const p5 = pl(5); d3.submit(p5, null, false);
  await waitFor(() => logs.some((l) => /GAVE UP/.test(l)), 5000);
  check('max attempts -> GAVE UP -> dead/', logs.some((l) => l.includes(`GAVE UP msg=${p5.message_id}`)) && fs.existsSync(path.join(qdir, 'dead', `${p5.message_id}.json`)) && logs.filter((l) => /retryable status=500/.test(l)).length === 3, logs);
  d3.stop();
  // 5) caps: maxItems -> overflow goes to in-memory delivery (not dropped)
  status = 503; logs.length = 0; const q2 = path.join(dir, 'q2');
  const d4 = createDelivery({ url: hook.url, log: (...a) => logs.push(a.join(' ')), headers: () => ({}), sleep: () => sleep(10), maxRetries: 0, queue: { enabled: true, dir: q2, maxItems: 2, baseBackoffMs: 10000 } });
  const r5 = [pl(6), pl(7), pl(8)].map((p) => d4.submit(p, null, false));
  check('maxItems cap -> 3rd in-memory', r5.join() === 'queued,queued,memory' && logs.some((l) => /queue full\/oversize/.test(l)), r5);
  const big = pl(9); big.text = 'x'.repeat(2 << 20);
  check('record size cap -> in-memory', d4.submit(big, null, false) === 'memory');
  check('duplicate submit ignored', d4.submit({ ...r5 && JSON.parse(fs.readFileSync(path.join(q2, fs.readdirSync(q2).find((f) => f.endsWith('.json'))))).payload }, null, false) === 'queued-dup');
  d4.stop();
  // 6) enrichment runs once in the worker, result persisted, priv removed after enrichment
  status = 200; got.length = 0; const q3 = path.join(dir, 'q3'); let enrichCalls = 0;
  const d5 = createDelivery({ url: hook.url, log: () => {}, headers: () => ({}), enrich: async (p, priv) => { enrichCalls++; p.attachment = { local_path: '/x', saw_key: priv.key === 'K' }; }, queue: { enabled: true, dir: q3 } });
  const p10 = pl(10); d5.submit(p10, { key: 'K' }, true);
  check('priv held on disk only until enrichment', fs.readFileSync(path.join(q3, `${p10.message_id}.json`), 'utf8').includes('"key":"K"'));
  await waitFor(() => got.some((g) => g.message_id === p10.message_id), 3000);
  const g10 = got.find((g) => g.message_id === p10.message_id) || {};
  check('enrich ran once with priv, enriched payload delivered', enrichCalls === 1 && g10.attachment && g10.attachment.local_path === '/x' && g10.attachment.saw_key === true, g10);
  d5.stop();
  // 7) queue OFF = legacy path (same log lines as old postWebhook)
  logs.length = 0; status = 200;
  const d6 = createDelivery({ url: hook.url, log: (...a) => logs.push(a.join(' ')), headers: () => ({}), queue: { enabled: false } });
  const p11 = pl(11); check('queue off -> memory', d6.submit(p11, null, false) === 'memory');
  await waitFor(() => logs.length, 3000);
  check('legacy log line', logs[0] === `webhook ok msg=${p11.message_id} status=200`, logs);
  await hook.close(); finish('queue');
})().catch((e) => { console.error(e); process.exit(1); });
