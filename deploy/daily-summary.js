#!/usr/bin/env node
'use strict';
// Daily VPS health summary (no AI, no network, no secrets, no message bodies). Run by the systemd --user timer
// mixin-gateway-daily.timer (20:15 Asia/Shanghai) or by hand: node deploy/daily-summary.js [--stdout]
// Writes <gw>/run/daily-summary.txt (0600) + a dated copy run/daily/daily-summary-YYYY-MM-DD.txt (CST date; copies
// older than MIXIN_SUMMARY_KEEP_DAYS=7 are removed). Folds in the checks of the box's deploy/check-vps.sh (service +
// heartbeat timer active, heartbeat fresh, no open heartbeat outage, no auth pause). Last line is exactly `OK` or
// `ALERT: <reasons>`. Exit 0 = OK, 1 = ALERT. Reads only gateway.log / alert.log metadata lines, systemctl, ps, df.
const fs = require('fs'); const path = require('path'); const os = require('os');
const { execFileSync } = require('child_process');
const GW = path.resolve(__dirname, '..');
const env = process.env;
const LOG = env.MIXIN_GATEWAY_LOG || path.join(GW, 'gateway.log');
const ALOG = env.MIXIN_ALERT_LOG || path.join(GW, 'alert.log');
const RUN = env.MIXIN_SUMMARY_DIR || path.join(GW, 'run');
const QDIR = env.MIXIN_QUEUE_DIR || path.join(GW, 'queue');
const SERVICE = env.MIXIN_ALERT_SERVICE != null ? env.MIXIN_ALERT_SERVICE : 'mixin-gateway.service';
const TIMER = env.MIXIN_HEARTBEAT_TIMER || 'mixin-gateway-heartbeat.timer';
const NOW = env.MIXIN_SUMMARY_NOW ? Date.parse(env.MIXIN_SUMMARY_NOW) : Date.now(); // tests
const SINCE = NOW - 24 * 3600e3;
const KEEP = parseInt(env.MIXIN_SUMMARY_KEEP_DAYS || '7', 10);
const num = (n, d) => { const v = parseInt(env[n] || '', 10); return Number.isFinite(v) ? v : d; };

function sh(cmd, args, opts = {}) {
  try { return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, ...opts }).trim() }; }
  catch (e) { return { code: typeof e.status === 'number' ? e.status : 127, out: String(e.stdout || '').trim() || String(e.message).split('\n')[0] }; }
}
const cst = (t) => new Date(t + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' CST';
const show = (unit, prop) => (SERVICE || unit !== SERVICE ? sh('systemctl', ['--user', 'show', '-p', prop, '--value', unit]).out : '');
const hms = (s) => (s == null ? '-' : `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h ${Math.floor(s % 3600 / 60)}m`);

function linesSince(file, since) { // only timestamped lines inside the window; bodies are never in these logs
  let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return { all: [], win: [] }; }
  const all = []; for (const l of txt.split('\n')) { const m = /^\[([^\]]+)\] (.*)$/.exec(l); if (!m) continue; const t = Date.parse(m[1]); if (Number.isFinite(t)) all.push({ t, s: m[2] }); }
  return { all, win: all.filter((x) => x.t >= since && x.t <= NOW) };
}

const g = linesSince(LOG, SINCE);
const cnt = (re) => g.win.filter((x) => re.test(x.s)).length;
// process starts in the window; "unclean" = a start whose previous process did not log `shutdown SIG…` (crash, watchdog exit, OOM kill)
let clean = true, starts = 0, unclean = 0, seenStart = false;
for (const x of g.all) {
  if (/^shutdown SIG/.test(x.s)) clean = true;
  if (/^gateway started /.test(x.s)) { if (x.t >= SINCE) { starts++; if (seenStart && !clean) unclean++; } seenStart = true; clean = false; }
}
const recycles = cnt(/blaze recreate in \d+ms \(gen=\d+ periodic recycle\)/);
const closes = cnt(/^blaze closed gen=/), connects = cnt(/^blaze connected gen=/);
const outages = g.win.map((x) => /gateway reconnected after outage offline_ms=(\d+)/.exec(x.s)).filter(Boolean).map((m) => +m[1]);
const maxOutageMs = outages.length ? Math.max(...outages) : 0;
let merged = 0, mergedHooks = 0; for (const x of g.win) { const m = /^webhook ok .* merged=(\d+)/.exec(x.s); if (m) { mergedHooks++; merged += +m[1]; } }
const w = {
  recv: cnt(/^recv msg=/), pushed: cnt(/^webhook ok msg=/), merged_webhooks: mergedHooks, merged_messages: merged,
  filtered: cnt(/^webhook filtered /), coalesce_holds: cnt(/^webhook coalesce hold /), dedup: cnt(/^webhook dedupe skip /), recalled_unsent: cnt(/^webhook skipped msg=/),
  retried: cnt(/^webhook (retryable|error) /), failed: cnt(/^webhook (GAVE UP|FAILED)/), blocked: cnt(/^blocked user=/),
};
const qFiles = (() => { try { return fs.readdirSync(QDIR).filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f)).length; } catch (_) { return null; } })();
const deadNew = (() => { try { const d = path.join(QDIR, 'dead'); return fs.readdirSync(d).filter((f) => fs.statSync(path.join(d, f)).mtimeMs >= SINCE).length; } catch (_) { return 0; } })();
const errs = { warn: cnt(/\bWARN\b/), error_lines: cnt(/\b(error|FAILED|FATAL|unhandledRejection)\b/i), fatal: cnt(/\bFATAL\b|unhandledRejection/), watchdog: cnt(/^WATCHDOG /), watchdog_dead: cnt(/WATCHDOG blaze dead/), tick_gaps: cnt(/WATCHDOG tick gap/), auth_fail: cnt(/blaze auth failure /), auth_circuit: cnt(/AUTH circuit open/) };
const al = linesSince(ALOG, SINCE);
const alerts = { heartbeat_alerts_sent: al.win.filter((x) => /ALERT sent kind=gateway_alert/.test(x.s)).length, heartbeat_alert_failed: al.win.filter((x) => /ALERT delivery FAILED/.test(x.s)).length,
  auth_failed_alerts: cnt(/ALERT submitted kind=gateway_alert status=auth_failed/), member_alerts: cnt(/^member alert conv=/) };

// service / timer / process
const st = SERVICE ? (sh('systemctl', ['--user', 'is-active', SERVICE]).out.split('\n')[0] || 'unknown') : 'skipped';
const timer = SERVICE ? (sh('systemctl', ['--user', 'is-active', TIMER]).out.split('\n')[0] || 'unknown') : 'skipped';
const nrestarts = SERVICE ? show(SERVICE, 'NRestarts') : '';
const activeSince = SERVICE ? show(SERVICE, 'ActiveEnterTimestamp') : '';
let uptime = null; if (activeSince) { const r = sh('date', ['-d', activeSince, '+%s']); if (r.code === 0) uptime = Math.max(0, Math.round(NOW / 1000 - +r.out)); }
const pg = sh('pgrep', ['-fx', 'node gateway.js']); const pid = pg.code === 0 ? pg.out.split('\n').filter((x) => /^\d+$/.test(x)) : [];
const rssKb = (() => { if (!pid.length) return null; const v = parseInt(sh('ps', ['-o', 'rss=', '-p', pid[0]]).out, 10); return Number.isFinite(v) ? v : null; })();
const memCur = SERVICE ? show(SERVICE, 'MemoryCurrent') : '';
const hb = sh(path.join(GW, 'check-heartbeat.sh'), [], { cwd: GW, env: { ...env, MIXIN_GATEWAY_LOG: LOG } });
const hbAge = (/last heartbeat (\d+)s ago/.exec(hb.out) || [])[1];
const outageOpen = fs.existsSync(path.join(RUN, 'alert-state.json'));
const authOpen = fs.existsSync(path.join(RUN, 'auth-alert-state.json'));
const df = sh('df', ['-Pk', GW]).out.split('\n').pop().split(/\s+/); const freeMb = df.length > 3 ? Math.round(+df[3] / 1024) : null;
const logMb = (() => { try { return +(fs.statSync(LOG).size / 1048576).toFixed(1); } catch (_) { return null; } })();

const reasons = [];
if (SERVICE && st !== 'active') reasons.push(`service ${SERVICE} is ${st}`);
if (SERVICE && timer !== 'active') reasons.push(`heartbeat timer is ${timer}`);
if (hb.code !== 0) reasons.push(`heartbeat stale (${hbAge != null ? hbAge + 's' : 'none'})`);
if (outageOpen) reasons.push('open heartbeat outage (run/alert-state.json)');
if (authOpen || errs.auth_circuit) reasons.push('auth circuit open: Blaze reconnect paused (fix keystore, restart service)');
if (unclean) reasons.push(`${unclean} unclean restart(s) in 24h`);
if (errs.watchdog_dead) reasons.push(`${errs.watchdog_dead} watchdog exit(s)`);
if (errs.fatal) reasons.push(`${errs.fatal} FATAL/unhandledRejection line(s)`);
if (w.failed || deadNew) reasons.push(`${w.failed} webhook(s) failed / ${deadNew} new dead-letter(s)`);
if (qFiles != null && qFiles > num('MIXIN_SUMMARY_MAX_QUEUE', 20)) reasons.push(`webhook queue backlog ${qFiles}`);
if (rssKb != null && rssKb > num('MIXIN_SUMMARY_MAX_RSS_MB', 200) * 1024) reasons.push(`RSS ${Math.round(rssKb / 1024)}MB`);
if (freeMb != null && freeMb < num('MIXIN_SUMMARY_MIN_FREE_MB', 500)) reasons.push(`disk free ${freeMb}MB`);
if (alerts.heartbeat_alerts_sent || alerts.auth_failed_alerts) reasons.push(`${alerts.heartbeat_alerts_sent + alerts.auth_failed_alerts} gateway_alert(s) sent in 24h`);
if (outages.length && (maxOutageMs >= num('MIXIN_DAILY_OUTAGE_ALERT_MS', 120000) || outages.length > num('MIXIN_DAILY_OUTAGE_ALERT_COUNT', 3))) reasons.push(`${outages.length} outage(s) > threshold (max ${Math.round(maxOutageMs / 1000)}s)`);

const out = [
  `Mixin gateway daily summary — host ${env.MIXIN_ALERT_HOST || os.hostname()} — generated ${cst(NOW)} (window: last 24h since ${cst(SINCE)})`,
  `service: ${st} | uptime ${hms(uptime)} (since ${activeSince || '-'}) | NRestarts ${nrestarts || '-'} | pid ${pid.join(',') || 'none'} | RSS ${rssKb != null ? Math.round(rssKb / 1024) + 'MB' : '-'} | MemoryCurrent ${memCur && /^\d+$/.test(memCur) ? Math.round(+memCur / 1048576) + 'MB' : '-'}`,
  `heartbeat: ${hb.code === 0 ? 'fresh' : 'STALE'} age ${hbAge != null ? hbAge + 's' : '-'} | heartbeat timer ${timer} | open outage ${outageOpen ? 'YES' : 'no'} | auth paused ${authOpen ? 'YES' : 'no'}`,
  `process: starts ${starts} (unclean ${unclean}) | blaze connects ${connects} closes ${closes} periodic recycles ${recycles} other reconnects ${Math.max(0, connects - recycles - starts)} | outages>threshold ${outages.length}${outages.length ? ` (max ${Math.round(Math.max(...outages) / 1000)}s)` : ''} | tick gaps ${errs.tick_gaps} | watchdog lines ${errs.watchdog} (exits ${errs.watchdog_dead})`,
  `errors: WARN ${errs.warn} | error/FAILED lines ${errs.error_lines} | FATAL/unhandled ${errs.fatal} | auth failures ${errs.auth_fail} | auth circuit opened ${errs.auth_circuit}`,
  `inbound: received ${w.recv} | blocked (not allowlisted) ${w.blocked}`,
  `webhooks: pushed ${w.pushed} | merged webhooks ${w.merged_webhooks} carrying ${w.merged_messages} msgs | coalesce holds ${w.coalesce_holds} | filtered ${w.filtered} | recalled-before-push ${w.recalled_unsent} | dedupe skips ${w.dedup} | retried ${w.retried} | failed ${w.failed} | queue pending ${qFiles != null ? qFiles : '-'} | new dead-letters ${deadNew}`,
  `alerts: heartbeat gateway_alert sent ${alerts.heartbeat_alerts_sent} (delivery failures ${alerts.heartbeat_alert_failed}) | auth_failed alerts ${alerts.auth_failed_alerts} | member_alert ${alerts.member_alerts}`,
  `disk: free ${freeMb != null ? freeMb + 'MB' : '-'} | gateway.log ${logMb != null ? logMb + 'MB' : '-'}`,
  `box-side checks (not visible from the VPS): no box gateway + deploy/MIGRATED_TO_VPS marker — the box refuses to start a gateway while the marker exists`,
  reasons.length ? `ALERT: ${reasons.join('; ')}` : 'OK',
].join('\n') + '\n';

if (process.argv.includes('--stdout')) { process.stdout.write(out); process.exit(reasons.length ? 1 : 0); }
fs.mkdirSync(path.join(RUN, 'daily'), { recursive: true, mode: 0o700 });
const write = (f) => { const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, out, { mode: 0o600 }); fs.renameSync(tmp, f); };
const day = new Date(NOW + 8 * 3600e3).toISOString().slice(0, 10);
write(path.join(RUN, 'daily-summary.txt')); write(path.join(RUN, 'daily', `daily-summary-${day}.txt`));
for (const f of fs.readdirSync(path.join(RUN, 'daily'))) { const m = /^daily-summary-(\d{4}-\d{2}-\d{2})\.txt$/.exec(f); if (m && Date.parse(m[1] + 'T00:00:00+08:00') < NOW - KEEP * 86400e3) { try { fs.unlinkSync(path.join(RUN, 'daily', f)); } catch (_) {} } }
process.stdout.write(out);
process.exit(reasons.length ? 1 : 0);
