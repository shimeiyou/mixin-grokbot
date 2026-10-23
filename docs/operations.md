# Operations: deploy, upgrade, rollback

Assumes the gateway lives in `~/mixin-gateway` on your server and runs as a `systemd --user` service
(units in `deploy/systemd-user/`). Run exactly **one** gateway per bot session: two Blaze connections for the
same session steal messages from each other.

## Deploy
```bash
sudo loginctl enable-linger "$USER"          # keep user services running without a login
git clone <your-fork-url> ~/mixin-gateway && cd ~/mixin-gateway
npm ci
mkdir -p ~/.mixin-secrets && chmod 700 ~/.mixin-secrets
cp .env.example ~/.mixin-secrets/mixin-gateway.env && chmod 600 ~/.mixin-secrets/mixin-gateway.env
$EDITOR ~/.mixin-secrets/mixin-gateway.env    # MIXIN_KEYSTORE_JSON, MIXIN_WEBHOOK_URL, MIXIN_WEBHOOK_KEY
cp allowlist.example.json allowlist.json      # Mixin user / conversation uuids allowed to reach the webhook
deploy/config-check.sh                        # prints names/shapes only, never values
deploy/systemd-user/install-units.sh --start
systemctl --user status mixin-gateway
```
Hosts without systemd: `deploy/ensure-running.sh` (idempotent; call it from cron, see `deploy/crontab.example`).

## Health
- `systemctl --user status mixin-gateway`, `journalctl --user -u mixin-gateway`, `tail gateway.log`
- `node gateway-status.js` — Blaze state, auth breaker, queue
- `./check-heartbeat.sh` — fresh heartbeat line in `gateway.log`
- `run/daily-summary.txt` — written by `mixin-gateway-daily.timer`
- `mixin-gateway-heartbeat.timer` posts one `gateway_alert` webhook event per outage (see `docs/webhook.md`).

## Upgrade
```bash
cd ~/mixin-gateway
tar --exclude=node_modules -czf ~/mixin-gateway-backup-$(date +%Y%m%d%H%M).tgz .   # state + code backup
git fetch && git log --oneline HEAD..origin/main     # review
git pull --ff-only && npm ci
OFFLINE=1 ./run-tests.sh
systemctl --user restart mixin-gateway && systemctl --user status mixin-gateway
```
The webhook queue (`queue/`), dedupe (`seen.json`, `queue/sent-ids.txt`) and context survive restarts, so nothing
is lost or pushed twice across an upgrade.

## Rollback
- **Code**: `git checkout <previous-tag-or-commit> && npm ci && systemctl --user restart mixin-gateway`.
- **Full**: stop the service, restore the backup tarball into `~/mixin-gateway`, `npm ci`, start the service.
- If you re-run units after a rollback: `deploy/systemd-user/install-units.sh` (daemon-reload included).

## Auth circuit breaker
After `MIXIN_AUTH_FAIL_LIMIT` (3) consecutive Blaze auth failures the gateway pauses reconnecting and sends one
`gateway_alert` (`status:"auth_failed"`). This is a credentials problem, not a reason to roll back: fix
`MIXIN_KEYSTORE_JSON` in the env file, then `systemctl --user restart mixin-gateway`.

## Optional: remote send via SSH socket
The gateway exposes a local send endpoint at `run/send.sock` (0600). `reply.js` / `recall.js` use it to send through
the gateway's single Blaze connection. If your AI agent runs on a different machine than the gateway, it can send
over SSH instead (OpenSSH `ssh -W` stream forwarding to the unix socket):

- per call: `MIXIN_SEND_ENDPOINT=ssh:<ssh-host-alias>:/home/<user>/mixin-gateway/run/send.sock`, or
- once per client checkout: a marker file `deploy/MIGRATED_TO_VPS` (path overridable with `MIXIN_MIGRATION_MARKER`)
  whose first non-comment line is that endpoint. While the marker exists, `run.sh` / `ensure-running.sh` on the client
  refuse to start a second local gateway. A marker without a valid endpoint fails closed.

`MIXIN_SSH_BIN`, `MIXIN_SSH_CONNECT_TIMEOUT_S`, `MIXIN_SEND_ENDPOINT_TIMEOUT_MS`, `MIXIN_SEND_ENDPOINT_TRIES` tune it.
Attachments downloaded by the gateway live on the gateway host; `deploy/fetch-media.sh` copies one over SSH
(`VPS_HOST` = ssh host alias).
