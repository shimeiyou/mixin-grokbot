# Webhook payload

The gateway `POST`s one JSON object per message (or per merged burst) to `MIXIN_WEBHOOK_URL`
(`Content-Type: application/json`). If `MIXIN_WEBHOOK_KEY` is set it is sent in every header of
`MIXIN_WEBHOOK_KEY_HEADERS` (default `Authorization,X-Webhook-Key`; `Authorization` gets `Bearer <key>`).
Any 2xx = delivered. 4xx (except 408/429) = permanent failure; everything else is retried with exponential backoff
(`Retry-After` honoured). With the queue on (default), payloads are persisted before the Blaze ACK.

Your receiver should be **idempotent on `message_id`** (retries reuse it), answer quickly (2xx) and do the work
asynchronously, then reply with `reply.js`.

## Base fields (always)
| field | type | notes |
|---|---|---|
| `conversation_id` | uuid | 1:1 or group conversation |
| `user_id` | uuid | sender |
| `message_id` | uuid | Mixin message id (pass as `--reply-to`) |
| `category` | string | normalized, e.g. `PLAIN_TEXT` (ENCRYPTED_* are decrypted and reported as PLAIN_*) |
| `original_category` | string | category on the wire |
| `encrypted` | bool | arrived E2E-encrypted |
| `text` | string | text, or a readable rendering for non-text messages (`MIXIN_PAYLOAD_TEXT_V2=1`) |
| `created_at` | ISO time | |

## Structured fields (`MIXIN_PAYLOAD_V2=1`, additive)
`display_text`, `received_at`, `delay_ms`, `quote_message_id` + `quote` (cached quoted message),
`attachment` (`attachment_id`, `mime_type`, `size`, `name`, `width`, `height`, `duration`, … and with
`MIXIN_MEDIA_DOWNLOAD=1`: `local_path`, `local_mime`, `sha256`; with `MIXIN_MEDIA_VIEW_URL`: `view_url`),
`sticker`, `contact`, `location`, `live`, `app_card`, `buttons`, `transcript` + `transcript_count`,
`recalled_message_id`, `pin`, `system`, `decrypt_error`, `parse_error`.
`MIXIN_PAYLOAD_LOOKUP=1` adds `sender_name`, `sender_identity_number`. `MIXIN_WEBHOOK_CONTEXT=1` adds `context`
(recent messages of the conversation, capped by `MIXIN_CONTEXT_*`).

## Coalescing: `merged_count`, `merged_messages`
With `MIXIN_WEBHOOK_COALESCE_MS` > 0 (queue on), a burst from the same sender in the same conversation is held and
delivered as ONE webhook: the latest message's normal payload plus
- `merged_count` — number of messages in the burst (≥ 2)
- `merged_messages` — array, oldest first, including the latest; each item is the message payload without
  conversation-level fields (`conversation_id`, `context`, `sender_name`, …).

Flush after `MIXIN_WEBHOOK_COALESCE_IDLE_MS` without a new message, at the latest `MIXIN_WEBHOOK_COALESCE_MS` after the
first, or at `MIXIN_WEBHOOK_COALESCE_MAX` messages. A single message is sent unchanged (no `merged_*`). A message
recalled while held is removed from the burst.

## Outage annotation: `offline_ms`
After a Blaze outage longer than `MIXIN_OFFLINE_THRESHOLD_MS` (30 s), messages received within
`MIXIN_OFFLINE_ANNOTATE_MS` (10 min) of reconnecting get
`offline_ms` (int) and `gateway_status: {offline_ms, offline_since, reconnected_at, reason}` — useful to tell the user
"sorry, I was offline".

## Gateway events (`kind`)
Normal messages have no `kind`. Additive events reuse the base fields (`category` `SYSTEM_*`, a deterministic `message_id`):
- `kind:"gateway_alert"` + `gateway_alert: {status, host, service, service_state, check, heartbeat_age_s, outage_id,
  outage_since, detected_at, effect, runbook, …}` — sent once per outage by the heartbeat timer, or by the gateway
  itself when the auth breaker opens (`status:"auth_failed"`). Targeted at `MIXIN_ALERT_USER` (a Mixin user uuid) if
  set; posted to `MIXIN_ALERT_URL` (default: the webhook URL).
- `kind:"member_alert"` + `member_alert: {conversation_id, members_total, missing_total, new_missing, missing, …}` —
  group members whose clients cannot receive encrypted messages (`MIXIN_MEMBER_ALERT=1`, default).

## Size cap
Bodies larger than `MIXIN_WEBHOOK_MAX_BYTES` (6000) are trimmed (context/transcript first). Categories in
`MIXIN_WEBHOOK_DROP_CATEGORIES` are not forwarded.

## Example
```json
{"conversation_id":"00000000-0000-0000-0000-000000000001","user_id":"00000000-0000-0000-0000-000000000002",
 "message_id":"00000000-0000-0000-0000-000000000003","category":"PLAIN_TEXT","original_category":"ENCRYPTED_TEXT",
 "encrypted":true,"text":"hello","created_at":"2026-01-01T00:00:00.000Z","display_text":"hello",
 "received_at":"2026-01-01T00:00:00.400Z","delay_ms":400}
```
