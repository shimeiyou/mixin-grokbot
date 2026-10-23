'use strict';
// Test-only preload (-r): points the hard-coded wss://blaze.mixin.one at TEST_BLAZE_URL so the OLD gateway
// (which has no URL option) can run against the fake Blaze server. Never used in production.
const wsPath = require.resolve('ws', { paths: [require.resolve('@mixin.dev/mixin-node-sdk')] });
const Orig = require(wsPath);
class Redirect extends Orig {
  constructor(address, protocols, options) { super(String(address).replace(/^wss:\/\/blaze\.mixin\.one/, process.env.TEST_BLAZE_URL), protocols, options); }
}
for (const k of ['default', 'WebSocket', 'Server', 'WebSocketServer']) if (Orig[k] && k !== 'default' && k !== 'WebSocket') Redirect[k] = Orig[k];
for (const k of ['default', 'WebSocket']) Object.defineProperty(Redirect, k, { value: Redirect, configurable: true, writable: true });
require.cache[wsPath].exports = Redirect;
