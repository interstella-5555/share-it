---
name: share-it
description: Use when the user asks to upload, share, host, or update a file via share-it. Trigger phrases include "share this file", "upload this to share-it", "share the PDF", "put this on my share", "update the file on share-it", "get me a public URL for this", "host this on my share", "stick this on share-it".
---

# share-it

A thin Claude Code skill over the share-it HTTP API. One job: upload a file and report back a URL. When the user wants to update an existing upload, discover its id.

**Operating principle:** assume the user has already set up the skill and just try to upload. Don't probe `/health`, don't validate config shape, don't ask questions ahead of time. If something goes wrong, THEN diagnose and ask. This keeps the happy path to a single `curl` + one printed line.

## Config shape

Lives at `~/.share-it/config.json`, mode `600`:

```json
{
  "baseUrl": "https://share.example.app",
  "apiKey": "<uuid>"
}
```

`baseUrl` — the user's share-it instance, no trailing slash. `apiKey` — the caller's active API key UUID, lowercase. Used as `X-Api-Key` on every request. Never log it, never echo it back unless the user asks.

## Upload flow (optimistic, default)

1. **Identify the file.** Priority:
   - Explicit path in the user's message.
   - Attachment in the message.
   - A file the conversation just created / modified that matches the user's description.
   - Otherwise, list candidates from the conversation and ask.

2. **Read the config.** `jq -r '.baseUrl,.apiKey' ~/.share-it/config.json`. If the file is missing or unparseable, skip to **Recover from failure** with cause = `no-config`.

3. **Resolve the MIME type from the file extension.** DO NOT rely on curl's default — on macOS curl often sends `application/octet-stream` for extensions not listed in `/etc/mime.types` (`.md`, `.json` etc.), and the server rejects that with `415`. Use this mapping — every upload MUST pass explicit `;type=<mime>`:

   | Extension          | MIME to pass       |
   | ------------------ | ------------------ |
   | `.html`, `.htm`    | `text/html`        |
   | `.txt`             | `text/plain`       |
   | `.md`, `.markdown` | `text/markdown`    |
   | `.json`            | `application/json` |
   | `.png`             | `image/png`        |
   | `.jpg`, `.jpeg`    | `image/jpeg`       |
   | `.gif`             | `image/gif`        |

   Anything else → tell the user the file type isn't supported; don't bother hitting the server.

4. **POST the file.**

   ```bash
   curl -sS -X POST \
     -H "X-Api-Key: $API_KEY" \
     -F "file=@<absolute-path>;type=<resolved-mime>" \
     "$BASE_URL/share"
   ```

   Concrete:

   ```bash
   curl -sS -X POST -H "X-Api-Key: $API_KEY" \
     -F 'file=@/Users/you/notes.md;type=text/markdown' \
     "$BASE_URL/share"
   ```

   For explicit updates with a known id: append `?id=<known-id-or-shortId>`. Parse the response JSON. Success: `{ "success": true, "url", "shortUrl", "id", "shortId", "version" }`.

5. **Report.** One line, prefixed with 🔗:

   ```
   🔗 <file-path> → <shortUrl> [ (v<N>) ]
   ```

   - Prefer `shortUrl` when present; fall back to `url` only on old server versions that don't return it.
   - Append ` (v<N>)` only when `version > 1`.

   Single-file example:

   ```
   🔗 ~/report.pdf → https://share.example.app/share/Ab3xKp9qZ2 (v3)
   ```

   Batch:

   ```
   🔗 ~/logo.png     → https://share.example.app/share/xK9mP2nQrT
   🔗 ~/changelog.md → https://share.example.app/share/qW8eRtY5uI (v2)
   🔗 ~/pitch.html   → https://share.example.app/share/zXcVbNm3aS (v5)
   ```

6. **If the HTTP call fails** (non-200 status, network error, unparseable body) → **Recover from failure**.

## Recover from failure

This is the only branch where the skill asks questions. The goal: figure out from the failure what's actually wrong, propose the next action, and let the user decide. Do NOT silently retry into a broken state.

### Step A — classify the failure

Inspect what we got:

| Signal                                           | Cause                           |
| ------------------------------------------------ | ------------------------------- |
| Config file missing / malformed JSON             | `no-config`                     |
| DNS error, connection refused, timeout           | `instance-unreachable`          |
| `502`/`503`/`504`, HTML body, non-JSON response  | `instance-down` (probe /health) |
| `401 { error: "API key required" }`              | `missing-key` (config edge)     |
| `401/403` with key-related error                 | `bad-key`                       |
| `403 { error: "API key is suspended" }`          | `suspended-key`                 |
| `403 { error: "API key is inactive" }`           | `inactive-key`                  |
| `413` / `415` / `400` / `403-forbidden-not-auth` | `content-error` (not our fault) |

### Step B — for `instance-down`, probe `/health` first

```bash
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 "$BASE_URL/health"
curl -sS --max-time 5 "$BASE_URL/health"
```

- `200` + `ok` → the server is up; the upload failure is request-specific. Surface the raw original response (status + body) and stop.
- Anything else → the instance itself is down/misconfigured. Report both the upload-failure status and the health-probe status. Do not retry.

### Step C — diagnose + prompt

Each cause gets a tight prompt. Always state what went wrong concretely (status, response body) before the question.

**`no-config`** →

> "No share-it config found at `~/.share-it/config.json`. Do you want to:
> (a) Paste an existing API key (and its base URL) I should save?
> (b) Provide the instance `ADMIN_KEY` once so I can create a fresh API key for you?
> (c) Point me at a different path where your config lives?"

On `(a)` / `(b)`, run the **Setup** flow below.

**`bad-key`** / `missing-key` →

> "The stored API key was rejected (`403 Unknown API key`). It was probably rotated or deleted server-side. Do you want to:
> (a) Paste a new API key?
> (b) Provide `ADMIN_KEY` so I can issue a fresh one?
> (c) Switch to a different share-it instance?"

**`suspended-key`** →

> "Your API key is suspended on `<baseUrl>`. That's a soft block — an admin flipped the status. Contact the instance admin to reactivate it, or paste a different active key."

No retry, no ADMIN_KEY upgrade offered — suspension is intentional.

**`inactive-key`** →

> "Your API key is marked inactive. Uploads are blocked until an admin reactivates it, or until you switch keys. Paste a different key, or have the admin PATCH this one back to `active`."

**`instance-unreachable` / `instance-down`** →

> "Can't reach `<baseUrl>` — `<specific error>`. Options:
> (a) Wait and retry in a minute.
> (b) Fix the URL (edit `~/.share-it/config.json` or paste a new baseUrl).
> (c) Switch to a different instance."

**`content-error`** → no prompt; surface the server's error verbatim with the HTTP status. The user needs to fix the file, not the config. Example:

> `415 — Unsupported file type 'application/zip' with extension '.zip'. Allowed: HTML, plain text, Markdown, JSON, PNG, JPEG, GIF.`

### Step D — act on the user's choice

- "Paste key / URL / admin key" → run **Setup** with the provided pieces, writing a fresh `~/.share-it/config.json`.
- "Switch instance" → same as fresh setup; asks for new baseUrl + key.
- "Retry" → re-run the upload once. If it fails again with the same cause, tell the user and stop.
- "Edit the config myself" → wait until the user confirms they've edited, then re-run the upload.

## Setup

Only run when Recover decided we need new creds. **Don't run this on every invocation.**

1. If not already known from the failure context, ask for the **base URL** (example `https://share.example.app`). Accept it only if it starts with `http://` or `https://`.

2. Probe `GET <baseUrl>/health` (`--max-time 5`, expect `200` + body `ok`). If it fails, tell the user precisely what came back (status / body / curl error) and re-ask.

3. Obtain an **API key**, one of:
   - User pastes an existing UUID-shaped key.
   - User provides the instance `ADMIN_KEY` (used once, NEVER stored): the skill `POST /admin/keys` with `{"status":"active"}` and `X-Admin-Key: <uuid>`, then pulls `apiKey` from the response.

4. Validate the API key matches `[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}` (case-insensitive). Lowercase before storing.

5. Sanity-check with `GET <baseUrl>/files` + the key → expect `200 { "success": true, "files": [...] }`. If `403`, the key is bad / inactive / suspended — tell the user which and re-ask.

6. Persist:

   ```bash
   mkdir -p ~/.share-it && chmod 700 ~/.share-it
   printf '%s' '{"baseUrl":"...","apiKey":"..."}' > ~/.share-it/config.json
   chmod 600 ~/.share-it/config.json
   ```

7. Confirm: `Config saved to ~/.share-it/config.json (owner-only permissions).` Then **immediately retry the original upload** so the user gets their URL without having to ask again.

### Migration from legacy `~/.easy-share/config.json`

Before running the "no config" prompt, check for a file at `~/.easy-share/config.json` (the project's prior name). If it exists and the new `~/.share-it/config.json` does not:

```bash
mkdir -p ~/.share-it && chmod 700 ~/.share-it
cp ~/.easy-share/config.json ~/.share-it/config.json
chmod 600 ~/.share-it/config.json
```

Tell the user once: `Migrated ~/.easy-share/config.json → ~/.share-it/config.json`. Do not delete the old file (user can clean up). Proceed with the original upload — the migrated config already has `baseUrl` + `apiKey`.

## Update flow

The skill treats an upload as an **update** only when:

- The user explicitly says so: "update X", "new version of X", "replace the X I uploaded", etc.
- OR the conversation context carries a prior upload's `id` or `shortId` that the user's current request references.

Otherwise, default to a plain new upload.

When the update target is known (from session context):

```bash
curl -sS -X POST \
  -H "X-Api-Key: $API_KEY" \
  -F "file=@<absolute-path>;type=<resolved-mime>" \
  "$BASE_URL/share?id=<known-id-or-shortId>"
```

(Same MIME-from-extension rule as new uploads — see the mapping table above.)

If `version > 1` in the response, include it in the report line.

### Disambiguating an update target

When the user asks to update but the id isn't in the session context:

1. Call:

   ```bash
   curl -sS -H "X-Api-Key: $API_KEY" "$BASE_URL/files"
   ```

   Response:

   ```json
   {
     "success": true,
     "files": [
       {
         "id": "...",
         "shortId": "...",
         "originalName": "report.pdf",
         "latestVersion": 3,
         "size": 1234,
         "lastUploadAt": 1776380000000
       }
     ]
   }
   ```

   Sorted by `lastUploadAt` desc.

2. Filter by `originalName === <basename-of-target>`.

3. Decide:
   - **Exactly one match** → use its `id`. Note: `Updating <originalName> (<shortId>, last uploaded <human-time>)`. Then POST `?id=<that>`.
   - **Multiple matches** → list and ask:

     ```
     Multiple files match "report.pdf":
       1. Ab3xKp9qZ2   last: 2 days ago   (v3)
       2. 99887766qW   last: 2 weeks ago  (v1)
     Which one to update? (1/2/none)
     ```

   - **No match** → same picker with top 5 recent files.

4. Never silently guess when there's ambiguity. Asking beats a wrong update.

## Content-type and filename rules

Server validates both the extension AND the declared `Content-Type`. **curl's default Content-Type detection is unreliable** — on macOS it falls back to `application/octet-stream` for `.md`, `.json`, and other extensions that `/etc/mime.types` doesn't cover. To avoid a wasted `415` roundtrip, always pass explicit `;type=<mime>` using the extension→MIME table from the Upload flow. The table and the `curl` example there are the source of truth — don't guess, don't rely on curl auto-detection.

Allowed extensions: `.html` / `.htm`, `.txt`, `.md`, `.json`, `.png`, `.jpg` / `.jpeg`, `.gif`. Anything else → `415` surfaced to the user.

## Things this skill does NOT do

- **Doesn't probe `/health` on every invocation.** Only after an upload failure of ambiguous shape.
- **Doesn't list files proactively.** Only during update-disambiguation.
- **Doesn't persist local state beyond `~/.share-it/config.json`.** No per-file mapping — `/tmp` files re-posted across sessions are new uploads unless the user says otherwise.
- **Doesn't cache the `ADMIN_KEY`.** One-shot during setup.
- **Doesn't delete or cascade.** Out of scope — user can hit the API directly if needed.

## Output discipline

Tight. One `🔗` line per uploaded file. For errors, one line with status + message. For setup, one short prompt per step. No wrap-ups, no "I have successfully done X". The user sees the URL and moves on.
