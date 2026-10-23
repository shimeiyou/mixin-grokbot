'use strict';
// Test-only preload (-r): forces every MixinApi() client to TEST_API_BASE (used to run the OLD reply.js against
// the fake API). Never used in production.
const sdk = require('@mixin.dev/mixin-node-sdk');
const orig = sdk.MixinApi;
sdk.MixinApi = (cfg = {}) => orig({ ...cfg, requestConfig: { ...(cfg.requestConfig || {}), baseURL: process.env.TEST_API_BASE } });
