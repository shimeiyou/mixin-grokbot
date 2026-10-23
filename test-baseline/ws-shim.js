'use strict';
// Workaround for @mixin.dev/mixin-node-sdk 7.6.0: its Blaze client opens the WebSocket without a
// User-Agent header, and blaze.mixin.one now rejects that with 202 / code 10006 "Update required".
// Its 3s handshake timeout is also too short on slow networks. This patches the shared `ws` module
// (must be required BEFORE the SDK) so every connection gets a User-Agent and a longer timeout.
const wsPath = require.resolve('ws', { paths: [require.resolve('@mixin.dev/mixin-node-sdk')] });
const OrigWS = require(wsPath);
const UA = process.env.MIXIN_USER_AGENT || 'Mixin-Node-SDK/7.6.0 mixin-gateway/1.0';
const TIMEOUT = parseInt(process.env.MIXIN_WS_HANDSHAKE_TIMEOUT_MS || '15000', 10);
class PatchedWS extends OrigWS {
  constructor(address, protocols, options = {}) {
    options = { ...options, headers: { 'User-Agent': UA, ...(options.headers || {}) } };
    if (!options.handshakeTimeout || options.handshakeTimeout < TIMEOUT) options.handshakeTimeout = TIMEOUT;
    super(address, protocols, options);
  }
}
for (const k of ["default", "WebSocket"]) Object.defineProperty(PatchedWS, k, { value: PatchedWS, configurable: true, writable: true });
require.cache[wsPath].exports = PatchedWS;
module.exports = PatchedWS;
