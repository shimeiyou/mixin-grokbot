#!/usr/bin/env bash
# Optional (remote send via SSH): copy one downloaded attachment from the gateway host (payload attachment.local_path
# is a path on that host) into a local dir. Usage: deploy/fetch-media.sh <attachment.local_path> [dest dir, default ~/mixin-media]
# Prints the local path. Only "<uuid>.<ext>" files inside the remote media dir are accepted. (env: VPS_HOST = ssh host alias, default "vps")
set -euo pipefail
src="${1:?usage: fetch-media.sh <local_path> [dest dir]}"; dest="${2:-$HOME/mixin-media}"
if ! printf '%s' "$src" | grep -Eq '^/home/[a-z_][a-z0-9_-]*/mixin-media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]{1,10}$'; then
  echo "refused: not a remote media path: $src" >&2; exit 2; fi
mkdir -p "$dest"; chmod 700 "$dest"
out="$dest/$(basename "$src")"; tmp="$out.part.$$"
( umask 077; ssh -o BatchMode=yes -o ConnectTimeout=15 "${VPS_HOST:-vps}" "cat -- '$src'" > "$tmp" ) || { rm -f "$tmp"; echo "fetch failed: $src" >&2; exit 1; }
mv "$tmp" "$out"; echo "$out"
