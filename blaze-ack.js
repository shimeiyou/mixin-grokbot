'use strict';

const { randomUUID } = require('crypto');
const { sendRaw, decodeMessage } = require('@mixin.dev/mixin-node-sdk/blaze');
const { MixinApi } = require('@mixin.dev/mixin-node-sdk');

function withTimeout(p, ms, what) {
  if (!p || typeof p.then !== 'function') return Promise.resolve(p);
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timeout ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function createAckDispatcher({ keystore, handler, log, wsOptions, apiConfig, handlerTimeoutMs, ackConfirmMs, ackHttpTimeoutMs, ackFlushMs }) {
  const pendingAcks = new Map();
  const httpAckQueue = new Set();
  let api = null;
  let ackInFlight = false;

  async function dispatch(c, data) {
    let msg;
    try {
      msg = decodeMessage(data, wsOptions);
    } catch (_) {
      return;
    }
    if (!msg) return;
    try {
      if (msg.source === 'ACKNOWLEDGE_MESSAGE_RECEIPT') {
        if (handler.onAckReceipt) await withTimeout(handler.onAckReceipt(msg), handlerTimeoutMs, 'ack handler');
        return;
      }
      if (msg.category === 'SYSTEM_CONVERSATION' && handler.onConversation) {
        await withTimeout(handler.onConversation(msg), handlerTimeoutMs, 'handler');
      } else if (msg.category === 'SYSTEM_ACCOUNT_SNAPSHOT' && handler.onTransfer) {
        await withTimeout(handler.onTransfer(msg), handlerTimeoutMs, 'handler');
      } else {
        await withTimeout(handler.onMessage(msg), handlerTimeoutMs, 'handler');
      }
    } catch (e) {
      log(`handler error ${e.message}`);
    }
    if (!msg.message_id) return;
    const id = randomUUID();
    pendingAcks.set(id, { message_id: msg.message_id, t: Date.now() });
    const ok = !c.dead && (await sendRaw(c.ws, { id, action: 'ACKNOWLEDGE_MESSAGE_RECEIPT', params: { message_id: msg.message_id, status: 'READ' } }));
    if (!ok) {
      pendingAcks.delete(id);
      httpAckQueue.add(msg.message_id);
    }
  }

  async function flushAcks() {
    if (ackInFlight) return;
    ackInFlight = true;
    try {
      for (const [id, a] of pendingAcks) {
        if (Date.now() - a.t > ackConfirmMs) {
          pendingAcks.delete(id);
          httpAckQueue.add(a.message_id);
        }
      }
      if (!httpAckQueue.size) return;
      const batch = [...httpAckQueue].slice(0, 100);
      try {
        api = api || MixinApi(apiConfig ? { keystore, requestConfig: apiConfig } : { keystore });
        await withTimeout(api.message.sendAcknowledges(batch.map((message_id) => ({ message_id, status: 'READ' }))), ackHttpTimeoutMs, 'ack HTTP');
        batch.forEach((x) => httpAckQueue.delete(x));
        log(`ack via HTTP count=${batch.length}`);
      } catch (e) {
        log(`ack via HTTP failed count=${batch.length} err=${e.message}`);
      }
    } finally {
      ackInFlight = false;
    }
  }

  const ackTimer = setInterval(() => {
    flushAcks().catch(() => {});
  }, ackFlushMs);

  return {
    pendingAcks,
    httpAckQueue,
    dispatch,
    stop: () => clearInterval(ackTimer),
  };
}

module.exports = { createAckDispatcher };
