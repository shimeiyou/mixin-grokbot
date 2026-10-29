'use strict';

const NOVAL = new Set(['--encrypted', '--silent', '--check-encryption']);
const BOOL = new Set(['encrypted', 'silent', 'check-encryption']);
const CONTENT = ['text', 'sticker', 'location', 'contact', 'card', 'buttons', 'image', 'video', 'audio', 'file'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HELP_TEXT = `Send a reply (text, media, cards, ...) to a Mixin conversation (1:1 or group).

usage: node reply.js --conversation <id> --reply-to <message_id> [--user <id>] [content flags...] [options]
       echo "text" | node reply.js --conversation <id> --reply-to <message_id> [--user <id>]
       node reply.js --help | -h

required:
  --conversation <uuid>        conversation to reply in (1:1 CONTACT or GROUP)
  --reply-to <message_id>      incoming message being answered; reply ids are derived from it (UUIDv5), so a
                               retry never sends the same reply twice

target / mode:
  --user <uuid>                sender of the incoming message. 1:1: recipient_id. Groups: target of the private
                               encrypted fallback (no --user -> no fallback, exit 1)
  --encrypted                  1:1: send ENCRYPTED_* (falls back to plain on failure). Groups are always encrypted
  --incoming-category <cat>    category of the incoming message; ENCRYPTED_* implies --encrypted

content (each flag becomes its own message, in command-line order):
  --text <text|->              text; "-" or no --text (and no other content) reads stdin. Markdown-looking or
                               >500 chars -> POST, otherwise TEXT
  --sticker <sticker_id>       sticker
  --contact <user_id>          contact card of a user
  --location "lat,lng[,name[,address]]" | <json>   location
  --card <json|@file>          APP_CARD; app_id = bot; "shareable" is always sent (default true).
                               legacy V0: {title, description, icon_url(https), action}
                               new V1:    {actions:[{label, action, color?}], title?, description?, cover_url?, cover?}
                               "action" together with "actions" is refused (iOS would ignore "actions").
                               WARN: description >1024; any input: action (iOS can't forward such a card).
                               No encrypted form: refused in groups (exit 2)
  --buttons <json|@file>       APP_BUTTON_GROUP, 1..6 [{label, action, color?}]. Refused in groups (exit 2)
  --image <path>               image (jpeg/png/gif/webp)
  --video <path>               video (needs ffprobe)
  --audio <path>               voice message (converted to ogg/opus with ffmpeg if needed)
  --file <path>                file (DATA)

options:
  --quote <message_id>         quote this message (on the first message only)
  --name <filename>            file name for --file (default: basename of the path)
  --caption <text>             caption for --image/--video/--file
                               --image/--video/--audio/--file paths must resolve (realpath) inside MIXIN_ATTACH_DIRS
                               (colon list; default: the media dir, e.g. ~/mixin-media); URLs are refused.
                               Otherwise exit 2, code ATTACH_PATH_DENIED, nothing sent.
  --mention <user_id>          @-mention a user in --text (repeatable, or comma-separated). Adds "@<identity_number> "
                               in front of the text unless the text already contains it (official clients render it as
                               @name and notify that user), sends the text as TEXT (not POST), and sets the Blaze
                               "mentions" field in groups. Needs --text; not the bot itself; lookup: GET /users/<id>
  --silent                     silent message (no notification)
  --seq <n>                    extra salt so a second reply to the same --reply-to gets new message ids
  --help, -h                   show this help and exit

other modes (no message content; --reply-to not needed):
  --recall <message_id>[,<id>...]   recall messages the BOT itself sent in --conversation (repeatable). Only ids found
                               in the local sent-log / context store / gateway.log are accepted, otherwise nothing is
                               sent (exit 2). 1:1: MESSAGE_RECALL via REST (recipient_id = --user or the other member).
                               Groups: refused (exit 2) because MESSAGE_RECALL has no encrypted form; MIXIN_GROUP_RECALL=1
                               allows it (sent on the gateway's main connection via the send endpoint only). Prints
                               {"ok":true,"recalled":[{message_id,recall_message_id,category,via}]}
  --check-encryption           read-only: list the members of --conversation and whether each can receive encrypted
                               messages; prints JSON, exit 0 all can, 3 someone cannot, 1 lookup error
                               (same as: node check-encryption.js --conversation <id>)

Groups are ALWAYS encrypted and never plain, and are sent ONLY on the gateway's main Blaze connection through its send
endpoint (via=gateway; reply.js never opens a Blaze connection of its own). If Mixin rejects the group message (or a
member has no key) -> private encrypted message to --user (via=rest, visible only to that user). If the endpoint cannot
be reached -> exit 1 with code ENDPOINT_UNAVAILABLE and nothing sent (no private fallback). 1:1 replies use REST only.
endpoint: MIXIN_SEND_ENDPOINT unset = local socket (MIXIN_SEND_SOCKET or <dir>/run/send.sock); unix:/abs/send.sock;
          ssh:<host>:/abs/send.sock = the gateway on another host, reached by "ssh -W" (OpenSSH streamlocal over stdio,
          BatchMode, key from ~/.ssh/config); 0 = disabled (group sends fail). With ssh:, every successful send is also
          recorded on the gateway host (sent-log / context) so receipts, recall and webhook context keep working.

output: {"ok":true,"message_id":...,"category":...} (+ "messages":[...] for more than one item, + "mentions":
        [{user_id, identity_number}] with --mention) on stdout.
exit codes: 0 sent, 1 send failed, 2 usage error or refused (nothing sent), 3 --check-encryption: someone cannot receive.
env: MIXIN_KEYSTORE_JSON (required), MIXIN_GATEWAY_LOG, MIXIN_UPLOAD_MAX_BYTES, MIXIN_SEND_SOCKET,
     MIXIN_SEND_ENDPOINT (see above), MIXIN_SEND_ENDPOINT_TRIES (3), MIXIN_SEND_ENDPOINT_TIMEOUT_MS (30000),
     MIXIN_SSH_CONNECT_TIMEOUT_S (10), MIXIN_BLAZE_SEND_TRIES, MIXIN_GROUP_ENCRYPT=0, MIXIN_CONV_CACHE_FILE, MIXIN_WEBHOOK_CONTEXT, MIXIN_CONTEXT_DIR,
     MIXIN_GROUP_RECALL=1, MIXIN_SENT_LOG_FILE
`;

const USAGE = 'usage: node reply.js --conversation <id> [--user <id>] --reply-to <message_id> --text <text> [--mention <user_id>]... [--encrypted] [--incoming-category <cat>]  (or text via stdin)\n' +
  '       optional: [--quote <message_id>] [--sticker <id>] [--location "lat,lng[,name[,address]]"] [--contact <user_id>] [--card <json|@file>] [--buttons <json|@file>]\n' +
  '                 [--image <path>] [--video <path>] [--audio <path>] [--file <path>] [--name <filename>] [--caption <text>] [--silent] [--seq <n>]';

class UsageError extends Error {}

function checkHelpExit(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    if (argv[i].startsWith('--') && !NOVAL.has(argv[i])) {
      i++;
    }
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const o = {};
  Object.defineProperty(o, '_order', { value: [], enumerable: false });
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (BOOL.has(k)) {
      o[k] = true;
      continue;
    }
    if (k === 'recall') {
      const next = String(argv[i + 1] == null ? '' : argv[i + 1]).split(',');
      o.recall = (o.recall || []).concat(next);
      i++;
      continue;
    }
    if (k === 'mention') {
      const next = String(argv[i + 1] == null ? '' : argv[i + 1]).split(',').map((x) => x.trim());
      o.mention = (o.mention || []).concat(next);
      i++;
      continue;
    }
    o[k] = argv[i + 1];
    i++;
    if (CONTENT.includes(k) && !o._order.includes(k)) {
      o._order.push(k);
    }
  }
  return o;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) {
    s += c;
  }
  return s;
}

module.exports = { CONTENT, UUID, USAGE, UsageError, checkHelpExit, parseArgs, readStdin };
