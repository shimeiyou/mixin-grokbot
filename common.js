'use strict';
const fs = require('fs');
const path = require('path');
const LOG_FILE = process.env.MIXIN_GATEWAY_LOG || path.join(__dirname, 'gateway.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  process.stderr.write(line);
}
function loadKeystore() {
  const raw = process.env.MIXIN_KEYSTORE_JSON;
  if (!raw) throw new Error('MIXIN_KEYSTORE_JSON not set');
  let ks;
  try { ks = JSON.parse(raw); } catch (_) { throw new Error('MIXIN_KEYSTORE_JSON is not valid JSON'); }
  if (!ks.app_id && ks.client_id) ks.app_id = ks.client_id;
  return ks;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { log, loadKeystore, sleep };
