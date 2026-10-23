#!/usr/bin/env node
'use strict';
// Test-only stand-in for OpenSSH `ssh … -W <socket path> -- <host>` (stdio streamlocal forwarding).
// MOCK_SSH_LOG: append argv as one JSON line. MOCK_SSH_MODE: ok (default) | auth | nosock | hang | refused.
// MOCK_SSH_ROOT: prefix put in front of the remote path (the "remote host" filesystem); default none.
const fs = require('fs'); const net = require('net'); const path = require('path');
const argv = process.argv.slice(2);
if (process.env.MOCK_SSH_LOG) fs.appendFileSync(process.env.MOCK_SSH_LOG, JSON.stringify({ argv, pid: process.pid }) + '\n');
const w = argv.indexOf('-W'), dd = argv.indexOf('--');
if (w < 0 || dd < 0 || dd !== argv.length - 2) { process.stderr.write('usage: mock ssh needs -W <path> -- <host>\n'); process.exit(255); }
const remote = argv[w + 1], host = argv[dd + 1];
const mode = process.env.MOCK_SSH_MODE || 'ok';
if (mode === 'auth') { process.stderr.write(`${host}: Permission denied (publickey).\r\n`); process.exit(255); }
if (mode === 'refused') { process.stderr.write(`ssh: connect to host ${host} port 22: Connection refused\r\n`); process.exit(255); }
if (mode === 'hang') { process.stdin.resume(); setInterval(() => {}, 1000); return; }
const p = path.join(process.env.MOCK_SSH_ROOT || '/', remote);
const s = net.createConnection(p);
s.on('error', () => { process.stderr.write('channel 0: open failed: connect failed: open failed\r\nstdio forwarding failed\r\n'); process.exit(255); });
s.on('connect', () => { process.stdin.pipe(s); s.pipe(process.stdout); });
s.on('end', () => { process.stdout.end(); });
s.on('close', () => process.exit(0));
process.stdin.on('end', () => s.end());
