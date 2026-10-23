# Sending APP_CARD messages

`node reply.js --conversation <uuid> --reply-to <message_id> --card '<json>'` (or `--card @file.json`).
`app_id` defaults to (and must be) the bot's own app id. Cards are plain-only, so they are refused in groups
(groups are always encrypted).

## Two generations — never mix them
| | V0 (legacy) | V1 (new) |
|---|---|---|
| trigger | non-empty `action` | no `action` |
| required | `title`, `description`, `icon_url` (https), `action` | `title` and/or `description`, plus `actions` or a cover |
| buttons | none (whole card taps to `action`) | `actions: [{label, action, color?}]`, no count limit |
| cover | — | `cover_url` (https) or `cover: {url, width, height, mime_type, thumbnail}` |

Rules (from client behaviour):
- With a non-empty `action`, iOS parses the card as V0 and **ignores `actions`** → `reply.js` refuses `action` + `actions`.
- V1 **requires `shareable`**, otherwise iOS renders nothing → `reply.js` always sends `shareable` (default `true`).
- V1 without buttons is allowed only with a cover; it is sent as `"actions": []`. Such a card has no tap target
  (Android linkifies URLs in the description).
- `title` > 36 chars may be truncated; `description` > 1024 chars may be truncated or rejected (warning only).
- `input:` actions make a card unforwardable on iOS; `input:share` does not exist (it just sends "share").
- Actions must be `https://…`, `mixin://…` or `input:…`.
- `APP_BUTTON_GROUP` (`--buttons`) is a separate message type with 1..6 buttons.

## resource_patterns
Mixin clients only load card images and open links whose URLs match the **resource patterns** configured for your
app in the Mixin developer dashboard. If a cover/icon does not show or a button does nothing, add the host
(e.g. `https://your-cdn.example.com`) to the app's resource patterns.

## Cover sizing
Android shows covers only when each side is 64..1024 px. `tools/card-cover.py` letterboxes an image to a ratio
(default 16:9, max width 1024) so the whole image stays visible, and prints the `cover` fields:
```bash
python3 tools/card-cover.py in.jpg cover.png --ratio 16:9 --max-w 1024   # needs Pillow
# -> {"width":1024,"height":576,"mime_type":"image/png","thumbnail":"<blurhash>"}
node tools/upload-attachment.js cover.png   # or host it on your own https server; add "url" to the cover object
```
Example V1 card:
```json
{"title":"Weekly report","description":"Summary is ready.","cover":{"url":"https://your-cdn.example.com/cover.png","width":1024,"height":576,"mime_type":"image/png","thumbnail":"<blurhash>"},
 "actions":[{"label":"Open","action":"https://your-server.example.com/report","color":"#3D75E3"}]}
```
