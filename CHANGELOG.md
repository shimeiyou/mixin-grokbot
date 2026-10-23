# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [0.1.0] - 2026-10-23
First public release.
- Blaze WebSocket gateway with own reconnect/backoff, watchdog, ACK-after-handle, dedupe.
- Webhook delivery: persistent on-disk queue, retry with backoff, category filtering, burst coalescing (`merged_messages`), body size cap, sent-id dedupe.
- `offline_ms` outage annotation, Blaze auth circuit breaker with a single `gateway_alert`.
- CLI senders `reply.js` / `recall.js`: text, post, stickers, contacts, locations, APP_CARD V0/V1, buttons, images, video, audio, files, mentions; group E2E encryption.
- Local send endpoint (unix socket) and optional remote send via SSH.
- systemd `--user` units: gateway, heartbeat alert timer, daily summary timer.
- Offline test suite (`OFFLINE=1 ./run-tests.sh`).
