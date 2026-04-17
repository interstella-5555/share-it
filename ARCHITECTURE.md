# share-it — architecture

This document describes how share-it works in detail: the runtime
pipeline, data model, authentication and authorization, versioning, URL
reservation, edge cases, and the rationale behind each design choice.

The canonical API surface is `openapi.json` at the repo root. This file
explains _why_ and _how_, not _what_ — the spec is the source of truth
for request/response contracts.

---

## 1. Philosophy

- **Small.** One binary-sized container. No HTTP framework, no ORM, no
  schema validator, no migrations tool. Zero runtime dependencies beyond
  Bun's standard library and `bun:sqlite`.
- **Readable.** `src/` is under a thousand lines; a motivated reader can
  hold the whole thing in their head in twenty minutes.
- **Explicit.** Every validation, every status code, every side effect
  lives in code you can grep. No decorators, no magic, no implicit
  reflection.
- **AI-friendly.** All responses are enveloped JSON with a stable shape
  (`{ success: bool, … }`) and errors carry a plain-English `error`
  string a model can read and self-correct against.
- **Spam-resistant by default.** `PROTECTED_MODE=true` is the default in
  the Dockerfile; unknown API keys are rejected until an admin registers
  them. Operators who want a wide-open endpoint flip the flag and
  accept the noise.

---

## 2. Stack

| Concern    | Choice                                              |
| ---------- | --------------------------------------------------- |
| Runtime    | Bun 1.x                                             |
| HTTP       | `Bun.serve` (bare — no Express/Hono/Fastify)        |
| Database   | `bun:sqlite` with raw SQL (no ORM)                  |
| Storage    | Content blobs on local disk, one file per version   |
| Hashing    | `Bun.CryptoHasher` (sha256)                         |
| IDs        | `crypto.randomUUID()` (v4)                          |
| Validation | Hand-rolled (UUID regex + MIME/ext allowlist)       |
| Tests      | `bun test` (built-in)                               |
| Container  | `oven/bun:1-alpine`, single stage, no `bun install` |

The project ships **no `node_modules`** in the runtime image — nothing
in `src/` imports from `node_modules`, so the Dockerfile skips
`bun install` entirely. All deps in `package.json` are
`devDependencies` (formatters, type checker, test utils).

---

## 3. Directory layout

```
src/
  server.ts         # Bun.serve wiring + top-level router
  config.ts         # env var parsing + validation
  db.ts             # SQLite connection, schema bootstrap, query methods
  storage.ts        # blob path resolution + read/write/unlink
  hash.ts           # sha256 helper
  auth.ts           # API key / admin key extraction, keyGate, authorizeOwnerOrAdmin
  validation.ts     # UUID regex, allowed MIME/extension table, filename sanitization
  http.ts           # ok() / err() envelope helpers
  routes/
    meta.ts         # GET /, GET /openapi.json (discovery)
    health.ts       # GET /health (plain-text)
    upload.ts       # POST /share
    serve.ts        # GET /share/:id[/:version]
    delete.ts       # DELETE /share/:id, DELETE /share/:id/:version
    admin.ts        # CRUD + rotate + cascade under /admin/keys

tests/
  unit/             # isolated module tests (validation, hash, db, storage, auth, http)
  integration/      # full-stack tests through Bun.serve

openapi.json        # canonical machine-readable spec (3.1)
Dockerfile          # single-stage image, volume-friendly
.env.example        # every variable with its default
```

The split is by responsibility: each file has a single reason to
change. Routes never touch SQL directly; they go through `Db`. Routes
never touch disk paths directly; they go through `storage.ts` helpers.
`http.ts` is the single source of truth for the response envelope.

---

## 4. Data model

### 4.1 SQLite schema

```sql
CREATE TABLE apiKeys (
  apiKey    TEXT PRIMARY KEY,
  status    TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','inactive','suspended')),
  createdAt INTEGER NOT NULL
);

CREATE TABLE files (
  id        TEXT PRIMARY KEY,
  apiKey    TEXT,                          -- NULL for anonymous uploads
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (apiKey) REFERENCES apiKeys(apiKey)
);

CREATE TABLE versions (
  fileId       TEXT NOT NULL REFERENCES files(id),
  version      INTEGER NOT NULL,
  hash         TEXT NOT NULL,              -- sha256 hex
  mime         TEXT NOT NULL,
  ext          TEXT NOT NULL,              -- canonical, see ALLOWED_TYPES
  size         INTEGER NOT NULL,
  originalName TEXT NOT NULL,              -- sanitized, for Content-Disposition
  createdAt    INTEGER NOT NULL,
  PRIMARY KEY (fileId, version)
);

CREATE INDEX idx_versions_hash ON versions(fileId, hash);
CREATE INDEX idx_files_apiKey  ON files(apiKey);
```

Two pragmas are enabled per connection: `journal_mode = WAL` for writer/
reader concurrency, and `foreign_keys = ON` because the default off-by-
default behavior of SQLite FK enforcement is a footgun.

With `foreign_keys = ON`, deleting a file row with referencing version
rows will fail — so every delete path MUST delete `versions` children
first.

### 4.2 Blob layout

Blobs live under `${DATA_DIR}/files/` using a two-level shard on the UUID
prefix:

```
${DATA_DIR}/files/
  <first-2>/<chars-3-4>/<full-id>/v<N>.<ext>
```

Example:

```
/data/files/c1/d2/c1d2e3f4-5678-4abc-9def-0123456789ab/v1.pdf
/data/files/c1/d2/c1d2e3f4-5678-4abc-9def-0123456789ab/v2.pdf
```

Sharding keeps directory fan-out bounded; each level has at most 256
entries. With a 10k-file dataset, the deepest directory holds on
average ~40 blobs — fine for any ext4/apfs filesystem.

---

## 5. Request lifecycle

```
                         ┌──────────────────────────────────────────┐
                         │ Bun.serve (0.0.0.0:$PORT, from config)   │
                         └──────────────────┬───────────────────────┘
                                            │ every request: fetch(req)
                                            ▼
                         ┌──────────────────────────────────────────┐
   try {                 │ router in src/server.ts                  │
                         │  GET  /health               → handleHealth
                         │  GET  /                     → handleRoot
                         │  GET  /openapi.json         → handleOpenapi
                         │  POST /share                → handleUpload
                         │  GET  /share/*              → handleServe
                         │  DELETE /share/*            → handleDelete
                         │  /admin/* (if adminKey set) → handleAdmin
                         │  else                       → notFound
                         └──────────────────┬───────────────────────┘
                                            │
                                            ▼
                         ┌──────────────────────────────────────────┐
                         │ route handler                            │
                         │  • parse + validate                      │
                         │  • auth (keyGate / extractAdminKey /     │
                         │    authorizeOwnerOrAdmin)                │
                         │  • business logic                        │
                         │  • IO (db + storage)                     │
                         │  • return ok(...) | err(...)             │
                         └──────────────────────────────────────────┘
   } catch (e) { internalError(e) }
```

Every route is a pure async function `(req, url, config, db) =>
Response`. The router is a hand-rolled `if` ladder — about 25 lines.

### 5.1 Top-level error handling

A single `try/catch` wraps dispatch. Any thrown error is logged via
`console.error` and surfaced as:

```json
500 { "success": false, "error": "Internal server error" }
```

Routes are expected to catch their own domain errors and return
well-shaped 4xx. The top-level catch is purely a safety net.

---

## 6. Response envelope

**Every operational response** (upload, serve errors, delete, admin)
uses a uniform JSON envelope.

### 6.1 The shape

```jsonc
// success — always 200
{ "success": true, "url": "…", "id": "…", "version": 1 }

// error — any 4xx / 5xx
{ "success": false, "error": "File size 11534336 bytes exceeds limit of 10485760 bytes" }
```

### 6.2 Rules

| Status class | Shape                                                 |
| ------------ | ----------------------------------------------------- |
| 2xx          | Always `200`. `{ "success": true, …fields }`.         |
| 3xx          | Only `304 Not Modified` from `GET /share/:id`, empty. |
| 4xx / 5xx    | `{ "success": false, "error": "…" }`.                 |

Fields in success responses are **spread** into the envelope — no
nesting under `data`. Arrays pick a semantic key: for instance
`GET /admin/keys` returns `{ "success": true, "keys": [ … ] }`.

### 6.3 Exceptions

Three endpoints are deliberately not enveloped because they are
non-operational:

- `GET /health` — plain text `ok` (readiness probe)
- `GET /` — discovery JSON: `{ "name", "version", "openapi" }`
- `GET /openapi.json` — the spec itself

And one endpoint is non-JSON on 200:

- `GET /share/:id[/:version]` — the file **content**, with
  `Content-Type` matching the uploaded file. Errors from this endpoint
  (400/404/500) still use the envelope.

### 6.4 Helpers

Both envelope shapes come from `src/http.ts`:

```ts
export function ok(body: Record<string, unknown> = {}): Response;
export function err(status: number, message: string): Response;
```

Every route imports these two. No route constructs its own JSON
response. That single seam is what keeps the envelope consistent.

---

## 7. Authentication and authorization

Two orthogonal credentials, each in its own header:

| Header        | Carries    | Used for                          |
| ------------- | ---------- | --------------------------------- |
| `X-Api-Key`   | User UUID  | upload, delete own files          |
| `X-Admin-Key` | Admin UUID | `/admin/*`, delete anyone's files |

`X-Api-Key` additionally accepts the OAuth-ish form `Authorization:
Bearer <uuid>` for convenience.

### 7.1 API key lifecycle

Three statuses, enforced by a CHECK constraint in SQL:

| Status      | Can upload? | Files readable? | Key can be re-issued? |
| ----------- | ----------- | --------------- | --------------------- |
| `active`    | ✓           | ✓               | —                     |
| `inactive`  | ✗           | ✓               | via PATCH             |
| `suspended` | ✗           | **✗**           | via PATCH             |

`suspended` is a soft-delete escape hatch: the owner's files become
404 (from `GET /share/:id`) without losing the on-disk blobs or
ability to revert.

### 7.2 Protected mode

`PROTECTED_MODE=true` (default): uploads require a pre-registered,
active API key. Unknown keys → 403 `"Unknown API key. Contact admin."`

`PROTECTED_MODE=false`: unknown API keys are auto-inserted as `active`
on first upload. Missing API keys are allowed — the file is uploaded
anonymously (`files.apiKey IS NULL`), which makes it **permanently
immutable** (see §10.3). This mode is intended for trusted networks
only.

### 7.3 Admin endpoint gate

`ADMIN_KEY` is optional. When unset, `/admin/*` returns 404 as if the
routes didn't exist. When set, requests without a matching
`X-Admin-Key` → 401 `"Admin access required"`.

`PROTECTED_MODE=true` without an `ADMIN_KEY` is rejected at startup: no
one could register keys and uploads would be impossible.

### 7.4 Owner-or-admin authorization (delete)

`src/auth.ts :: authorizeOwnerOrAdmin(req, db, file, config)` returns
one of four outcomes:

| Outcome             | Maps to HTTP | When                                                    |
| ------------------- | ------------ | ------------------------------------------------------- |
| `"admin"`           | proceed      | Valid `X-Admin-Key`                                     |
| `"owner"`           | proceed      | Valid `X-Api-Key`, status `active`, matches file owner  |
| `"forbidden"`       | 403          | Key exists but: wrong owner, not `active`, or anon file |
| `"unauthenticated"` | 401          | No creds / wrong admin key                              |

Anonymous files (`files.apiKey IS NULL`) can only be deleted by admin —
there is no "owner" to match.

---

## 8. API surface

All JSON responses below use the envelope. Example bodies elide
`success` for readability — assume `success: true` on 200,
`success: false` on 4xx/5xx.

### 8.1 Upload

```http
POST /share[?id=<uuid>]
X-Api-Key: <uuid>
Content-Type: multipart/form-data; boundary=…

[part: name="file", filename="report.pdf", Content-Type: application/pdf]
```

**Without `?id`:** new file, random UUID assigned. Response:

```jsonc
200 { "success": true,
      "url": "https://share.example.com/share/c1d2e3f4-…",
      "id":  "c1d2e3f4-…",
      "version": 1 }
```

**With `?id=<existing-owned-by-you>`:** append a new version.
Dedup applies (see §9).

**With `?id=<existing-owned-by-someone-else>`:** 403.

**With `?id=<anonymous-file-id>`:** 403 — anonymous URLs are immutable.

See §9 for the full upload pipeline including MIME validation, hashing,
and dedup.

### 8.2 Serve

```http
GET /share/:id
GET /share/:id/:version        # addressable per-version
GET /share/:id?download=1      # forces Content-Disposition: attachment
```

200 on success with `Content-Type` matching the uploaded file, `ETag`
header containing the sha256, and `Cache-Control: immutable` (for
anonymous files) or `no-cache` (for owned files).

If the caller sends `If-None-Match: "<hash>"` matching the current
version, → `304 Not Modified` with empty body.

See §10 for full serve semantics.

### 8.3 Delete

```http
DELETE /share/:id                    # whole file
DELETE /share/:id/:version           # one version
DELETE /admin/keys/:keyId?cascade=true   # key + all files
```

All return `200 { "success": true }` on success. See §11 for
semantics, including **URL reservation** (deleted URLs stay bound to
their original owner so they can't be silently claimed by anyone else).

### 8.4 Admin — keys

Every admin response is enveloped.

| Method / path                         | Purpose                                          |
| ------------------------------------- | ------------------------------------------------ |
| `POST   /admin/keys`                  | Create a key. Body: `{ "apiKey"?, "status"? }`.  |
| `GET    /admin/keys`                  | List all keys w/ `fileCount` and `versionCount`. |
| `GET    /admin/keys/:keyId`           | Fetch one key w/ stats.                          |
| `PATCH  /admin/keys/:keyId`           | Change status. Body: `{ "status": "inactive" }`. |
| `DELETE /admin/keys/:keyId[?cascade]` | Delete. 409 if it has files and no cascade.      |
| `POST   /admin/keys/:keyId/rotate`    | Issue a new UUID, transfer all files to it.      |

Success shapes:

```jsonc
// POST /admin/keys and GET /admin/keys/:keyId
{ "success": true, "apiKey": "…", "status": "active", "createdAt": 1776…,
  "fileCount": 0, "versionCount": 0 }

// GET /admin/keys
{ "success": true, "keys": [ /* rows, one per key */ ] }

// POST /admin/keys/:keyId/rotate
{ "success": true, "oldKey": "…", "newKey": "…", "filesTransferred": 3 }
```

### 8.5 Discovery

```http
GET /health         → 200 text/plain  "ok"
GET /               → 200 JSON        { "name", "version", "openapi" }
GET /openapi.json   → 200 JSON        (the full OpenAPI 3.1 document)
```

These are the only endpoints not enveloped. Root also sets an RFC 8631
`Link: </openapi.json>; rel="service-desc"; type="application/openapi+json"`
header for clients that follow discovery conventions.

---

## 9. Upload pipeline (detailed)

```
POST /share
  │
  ▼
extractApiKey        — headers: X-Api-Key | Authorization: Bearer
  │  rejects malformed keys with 400 before anything else
  ▼
keyGate              — applies PROTECTED_MODE + key-status rules
  │  returns the authorized apiKey (or null for anon in non-protected)
  ▼
queryId = ?id        — if present, must be a valid UUID (400 otherwise)
  │
  ▼
parse multipart      — Bun.request.formData()
  │  400 if no "file" field
  ▼
size check           — 413 if size > MAX_FILE_SIZE_MB
  │
  ▼
extension check      — 415 if not in ALLOWED_TYPES (see §12.1)
  │
  ▼
declared-MIME check  — extract Content-Type from RAW body (Bun re-sniffs
  │  file.type from the filename, losing the client-declared value).
  │  If declared ≠ canonical MIME for the extension → 415.
  ▼
hash = sha256(bytes)
  │
  ▼
branch on queryId:
  │
  ├── queryId given AND files row exists:
  │     ├── files.apiKey is NULL → 403 "immutable"
  │     ├── files.apiKey ≠ authorized → 403 "does not match"
  │     ├── latest version has same hash → return existing version (DEDUP)
  │     └── else: new version = MAX(version)+1, writeBlob, insertVersion
  │
  ├── queryId given AND no files row → new file with THAT id:
  │     (relevant for re-uploading after DELETE — tombstone still exists,
  │      so this branch is actually unreachable for previously-used ids.
  │      When the files row still exists after DELETE, the branch above
  │      handles the "append under same id" case.)
  │
  └── no queryId → new UUID:
        writeBlob(v=1), insertFile, insertVersion(v=1)
```

### 9.1 Content-Type defense-in-depth

The allowed-types table binds each extension to exactly one canonical
MIME. On upload, both must match: the client's declared `Content-Type`
from the multipart part AND the canonical MIME for the extension
parsed from the filename. If they disagree → 415.

Why read from the raw body? `Bun.request.formData()` **re-sniffs**
`File.type` from the filename extension, which would silently hide a
client declaring `image/svg+xml` with a `.png` suffix. Reading the
`Content-Disposition`/`Content-Type` lines directly preserves what the
client actually declared.

### 9.2 Dedup

Same-content re-upload under the same file id returns the existing
`version` without inserting a new row:

```bash
$ curl -F file=@a.txt -H "X-Api-Key: $K" "$BASE/share?id=$ID"
{ "success": true, "url": "…/share/$ID", "id": "$ID", "version": 3 }

$ curl -F file=@a.txt -H "X-Api-Key: $K" "$BASE/share?id=$ID"
{ "success": true, "url": "…/share/$ID", "id": "$ID", "version": 3 }   # same
```

Deduplication is per-`(fileId, hash)`, using `idx_versions_hash`.

### 9.3 Crash safety

Blob write happens **before** the DB insert. If the DB insert throws,
we `removeBlob(path)` to avoid an orphan on disk. The blob-before-row
order matters: the inverse (row then blob) risks a row pointing at
a missing blob — a permanently-broken serve path.

The accepted failure mode is: crash between `writeBlob` and
`insertVersion`. That leaves an orphan blob on disk which is
harmless (no row ever references it). A daily `find | grep` sweep can
clean these up if it ever becomes a concern. Given typical uptime,
this is not worth a two-phase commit.

---

## 10. Serve pipeline (detailed)

```
GET /share/:id[/:version][?download=1]
  │
  ▼
validate :id          — 400 if not UUID
  │
  ▼
validate :version     — 400 if present and not a positive integer
  │                     (via parseVersionParam in validation.ts)
  ▼
look up files row     — 404 if missing (and also if the OWNER'S key
  │                     is "suspended", the response is deliberately
  │                     404 — suspension hides files)
  ▼
resolve version       — :version requested? use it.
  │                     else: pick MAX(version)
  ▼
look up version row   — 404 with error body quoting latest version
  │                     so clients can rediscover it
  ▼
ETag check            — If-None-Match matches? → 304 empty body
  │
  ▼
stream blob from disk  — Content-Type from the version's canonical MIME
                         Cache-Control = "immutable" (anon) | "no-cache" (owned)
                         Content-Disposition only if ?download=1
```

### 10.1 `Cache-Control` rationale

- **Anonymous files** (`apiKey IS NULL`): `public, max-age=31536000,
immutable`. Safe because there is no way to mutate or remove an
  anonymous file — its content is fixed for the life of the deployment.

- **Owned files**: `public, no-cache`. A `suspended` key can flip a
  200 into a 404 any time; clients must revalidate. The ETag is still
  content-based so revalidation is cheap (304 with empty body).

### 10.2 Version addressing

Two shapes work:

```http
GET /share/c1d2…         # serves MAX(version)
GET /share/c1d2…/3       # serves exactly version 3 (or 404)
```

Holes in the sequence are allowed (see §12.4). Asking for a hole → 404
with a body like:

```json
{
  "success": false,
  "error": "Version 2 of file 'c1d2…' not found. Latest version: 5"
}
```

### 10.3 Anonymous immutability

A file uploaded without an API key (only possible in
`PROTECTED_MODE=false`) writes `files.apiKey = NULL`. The upload path
blocks any subsequent modification:

```
POST /share?id=<anon-id>   ≡   403 "was uploaded without an API key and is immutable"
```

There is no mechanism to turn an anonymous file into an owned file.
This is intentional: the URL is a one-shot, tamper-proof artifact.

---

## 11. Delete pipeline (detailed)

### 11.1 Whole-file delete — `DELETE /share/:id`

```
validate :id, find files row → 404 if missing
  │
  ▼
authorizeOwnerOrAdmin → 401 / 403 / proceed
  │
  ▼
listVersionsForFile(:id)   → [ {version, ext}, … ]
  │
  ▼
for each row: unlinkBlob(filesDir, id, version, ext)
  │  tolerates ENOENT (already gone)
  │  throws otherwise → 500 "Storage error"
  ▼
db.transaction(() => {
  deleteAllVersionsOfFile(:id)
  // files row is KEPT — tombstone for URL reservation
})
  │
  ▼
200 { success: true }
```

**Key design choice — URL reservation.** The `files` row is NOT
deleted. It stays as a tombstone carrying the original `apiKey`. This
prevents the following attack:

> Alice uploads `/share/abc-123`. She deletes it. Bob does
> `POST /share?id=abc-123` and silently takes over the URL.

With the tombstone, Bob's upload hits the "apiKey does not match"
branch in `upload.ts` → 403. Alice can re-upload to `abc-123` by
providing her original key; her next version is `v1` (the `versions`
table is empty after delete, so `MAX(version)+1 = 1`).

For previously-anonymous files, the tombstone has `apiKey IS NULL` →
the "immutable" branch in `upload.ts` blocks _everyone_, which is the
correct outcome since there is no owner to restore.

### 11.2 Version delete — `DELETE /share/:id/:version`

```
validate :id, :version
  │
  ▼
authorizeOwnerOrAdmin
  │
  ▼
deleteOneVersion(:id, :version)  → { ext } or null
  │  404 if null, with "Latest version: <max>" hint
  ▼
unlinkBlob(filesDir, id, version, ext)
  │
  ▼
200 { success: true }
```

The `files` row is **never** touched by per-version delete, even if
the deleted version was the only one left. This keeps the reservation
consistent with whole-file delete: iterating per-version to clear a
file gives the same end state as calling `DELETE /share/:id` once.

### 11.3 Cascade key delete — `DELETE /admin/keys/:keyId?cascade=true`

Without `cascade=true`, the handler returns 409 if the key has any
files (the pre-existing behavior).

With `cascade=true`:

```
listFileIdsByApiKey(:keyId) → [fileId, …]
  │
  ▼
for each fileId:
  listVersionsForFile → [{version, ext}]
  for each version: unlinkBlob (ENOENT-tolerant)
  │
  ▼
db.transaction(() => {
  for each fileId:
    deleteAllVersionsOfFile(fileId)
    deleteFileRow(fileId)          ← hard-delete, no tombstone
  deleteApiKey(:keyId)
})
  │
  ▼
200 { success: true }
```

Cascade **does** delete the `files` rows: a tombstone referencing a
deleted `apiKey` is a zombie pointer, and the URLs are now free for
anyone to claim (which is the right outcome for admin cleanup).

### 11.4 Transactional guarantees

`bun:sqlite`'s `db.transaction(fn)` is synchronous. Unlinks are async.
The handler structure is therefore always:

1. Collect blob coordinates (sync SELECT).
2. `await` every unlink (async FS ops, ENOENT-tolerant).
3. Execute the DB mutations inside a sync transaction.

If any unlink throws (non-ENOENT), step 3 never runs — DB stays intact
and the endpoint returns 500. If the DB step throws after all unlinks
succeeded (rare — these deletes don't violate constraints), a few
blobs are missing while their rows still exist; the upload path's
existing `writeBlob`-paired logic tolerates this (re-upload writes a
fresh blob with the same content hash, ETag unchanged).

---

## 12. Versioning model

### 12.1 Allowed types

Upload, serve, and delete are constrained to seven content types:

| Extension        | MIME               | Charset |
| ---------------- | ------------------ | ------- |
| `.html` (`.htm`) | `text/html`        | utf-8   |
| `.txt`           | `text/plain`       | utf-8   |
| `.md`            | `text/markdown`    | utf-8   |
| `.json`          | `application/json` | utf-8   |
| `.png`           | `image/png`        | —       |
| `.jpg` (`.jpeg`) | `image/jpeg`       | —       |
| `.gif`           | `image/gif`        | —       |

`EXT_ALIASES` normalizes `.htm → .html` and `.jpeg → .jpg` so the blob
extension is always canonical. Anything outside the table → 415 on
upload.

### 12.2 Monotonic version numbers

For a given `fileId`, `version` is strictly increasing across upload
events: `v(next) = MAX(version) + 1` or `1` if the versions table is
empty.

### 12.3 Holes

Because per-version delete leaves the neighbors in place, the sequence
can develop gaps:

```
upload v1  → versions={1}
upload v2  → versions={1,2}
upload v3  → versions={1,2,3}
delete v2  → versions={1,3}        # hole at 2
upload v4  → versions={1,3,4}      # not v2 — MAX+1 advances past the hole
```

Hitting a hole returns 404 with a hint:

```
GET /share/:id/2
404 { "success": false,
      "error": "Version 2 of file '…' not found. Latest version: 4" }
```

### 12.4 Post-mass-delete reset

If every version of a file is deleted (whole-file DELETE or iterative
per-version DELETEs), the versions table for that `fileId` is empty.
A subsequent owner re-upload then produces a fresh `v1` — the counter
resets, not continues from the pre-delete max.

This is acceptable because:

- ETags are content-hash based. An old `/share/:id/1` cached by a
  client and a new `/share/:id/1` with different content have different
  ETags; caches never confuse the two.
- The owner intentionally deleted. If they want monotonic semantics
  for their own bookkeeping, they use per-version delete instead and
  let holes form.

---

## 13. Common use cases (examples)

Assume:

```bash
BASE=https://share.example.com
ADMIN=00000000-0000-0000-0000-000000000001   # ADMIN_KEY
```

### 13.1 One-shot anonymous upload (public instance)

With `PROTECTED_MODE=false`:

```bash
curl -F file=@report.pdf $BASE/share
# → { "success": true, "url": "…/share/<uuid>", "id": "<uuid>", "version": 1 }
```

The returned URL is permanent and immutable.

### 13.2 Protected instance: register a key, upload, update

```bash
# admin registers a key
KEY=$(curl -s -X POST -H "X-Admin-Key: $ADMIN" -H "Content-Type: application/json" \
       -d '{"status":"active"}' $BASE/admin/keys | jq -r .apiKey)

# first upload
UP=$(curl -s -F file=@report.pdf -H "X-Api-Key: $KEY" $BASE/share)
ID=$(echo "$UP" | jq -r .id)

# update the same URL with revised content
curl -F file=@report-revised.pdf -H "X-Api-Key: $KEY" "$BASE/share?id=$ID"
# → version: 2

# serve latest
curl "$BASE/share/$ID" -o report-current.pdf

# serve exact historical revision
curl "$BASE/share/$ID/1" -o report-original.pdf

# force download instead of inline preview
curl "$BASE/share/$ID?download=1" -o named-by-server.pdf
```

### 13.3 Rollback by deleting the bad version

```bash
curl -X DELETE -H "X-Api-Key: $KEY" "$BASE/share/$ID/2"
# GET /share/$ID now serves v1 again
```

### 13.4 Takedown (hide, keep blob)

Use `suspended` when you might need to revert, or when legal hasn't
ruled yet:

```bash
curl -X PATCH -H "X-Admin-Key: $ADMIN" -H "Content-Type: application/json" \
     -d '{"status":"suspended"}' $BASE/admin/keys/$KEY
# all files owned by this key → 404 on GET
# later:
curl -X PATCH -H "X-Admin-Key: $ADMIN" -H "Content-Type: application/json" \
     -d '{"status":"active"}' $BASE/admin/keys/$KEY
# they're back
```

### 13.5 Hard delete with reservation

Alice wants the file gone from the public but keep the URL reserved:

```bash
curl -X DELETE -H "X-Api-Key: $KEY" "$BASE/share/$ID"
# → 200 { "success": true }
# GET /share/$ID → 404
# POST /share?id=$ID (by Alice's key) → 200 with version: 1 (restored)
# POST /share?id=$ID (by anyone else) → 403
```

### 13.6 Nuclear option: delete a key and everything it owns

```bash
curl -X DELETE -H "X-Admin-Key: $ADMIN" "$BASE/admin/keys/$KEY?cascade=true"
# → 200 { "success": true }
# Every file owned by $KEY is gone — rows, versions, blobs.
# Their URLs are now available for anyone to claim.
```

### 13.7 Key rotation (e.g. after a leak)

```bash
ROT=$(curl -s -X POST -H "X-Admin-Key: $ADMIN" \
       "$BASE/admin/keys/$KEY/rotate")
echo "$ROT"
# → { "success": true, "oldKey": "…", "newKey": "…", "filesTransferred": 12 }
# Old key is gone; all 12 files now owned by newKey.
# Owner now uploads with newKey; old key 403s.
```

### 13.8 Content-addressed dedup

If you're piping CI artifacts that often don't change:

```bash
for i in 1 2 3; do
  curl -s -F file=@unchanged.json -H "X-Api-Key: $KEY" "$BASE/share?id=$ID"
done
# All three return version: <same number>. No new blobs, no new rows.
```

---

## 14. Edge cases specifically handled

### 14.1 Silent URL takeover after delete

Problem: naive DELETE removes the `files` row, which lets a stranger
`POST /share?id=<deleted-id>` and claim the URL as their own file.

Solution: tombstone. `DELETE /share/:id` keeps the row, enforcing
ownership on any subsequent upload at that id. See §11.1.

### 14.2 MIME spoofing

Problem: a client declares `Content-Type: image/svg+xml` but sends a
`.png` filename; Bun's re-sniffed `file.type` would hide the
mismatch.

Solution: re-read the multipart body's `Content-Type` line directly
from the raw bytes and compare against the canonical MIME for the
extension. Any mismatch → 415. See §9.1.

### 14.3 Filename attacks

Problem: `..`-traversal, control characters, or extreme length in the
client-provided filename could reach `Content-Disposition` or — if we
ever used the filename as a disk path — the FS.

Solution: `sanitizeFilename` strips `..`, `/`, `\`, and `\x00-\x1f`;
truncates to 255 bytes of UTF-8; falls back to `<uuid>.<ext>` if empty
after sanitization. Disk paths never include the client name — blobs
live at `v<N>.<ext>`, the original name is stored as a DB column and
only re-emitted on `?download=1` via RFC 5987 encoding.

### 14.4 Anonymous ≠ owned

Anonymous files and owned files are handled differently by the upload
path because anonymous files are frozen at creation:

```
POST /share?id=<anon-id>   → 403 "immutable" — no matter what key you present
POST /share?id=<owned-id>  → owner-or-403 check
```

### 14.5 Suspended keys reveal nothing

Problem: listing files by a suspended key, or serving them, could be
used to confirm which URLs are "hidden but present."

Solution: `GET /share/:id` returns the generic
`404 "File '<id>' not found"` when the owner is suspended, identical
to the response for a non-existent id. No information leak.

### 14.6 Admin deletion of a key with attached files

Problem: accidentally nuking a key with important files attached.

Solution: `DELETE /admin/keys/:id` is 409 if files reference the key.
The operator must pass `?cascade=true` to acknowledge they want the
files gone too. This survived from v1 (pre-cascade) and the new
endpoint just makes the override explicit. See §11.3.

### 14.7 Upload race between write and DB

Problem: the server writes a blob, then the DB insert fails; the
orphan blob wastes disk.

Solution: `try/catch` around the transaction; on throw,
`removeBlob(path)`. The opposite order (row first, then blob) would
produce something far worse — a valid row pointing at a missing
blob → permanent 500 on serve. See §9.3.

### 14.8 ENOENT tolerance on delete

Problem: a prior partial failure left a DB row without its blob. On
delete, `unlink` throws ENOENT.

Solution: `unlinkBlob` swallows ENOENT. The point of the delete is to
converge on "gone"; if the blob was already gone, the operation still
succeeded.

### 14.9 Request body larger than configured limit

Problem: a 1 GB upload could run the server out of memory before we
check size.

Solution: Bun's multipart parser streams to temp; we check `file.size`
(reported by the parser) before calling `arrayBuffer()`. A 10 MB
default keeps memory use bounded. For production with larger files,
bump `MAX_FILE_SIZE_MB` — but keep the container's memory limit in
mind (we do `new Uint8Array(await file.arrayBuffer())` for hashing, so
the file lives in memory once during upload).

### 14.10 Trailing slashes in BASE_URL

Problem: `BASE_URL=https://share.example.com/` produces
`https://share.example.com//share/...` on upload responses.

Solution: `config.ts` strips trailing slashes on load.

### 14.11 Unexpected `PROTECTED_MODE` without `ADMIN_KEY`

Problem: a misconfigured container with `PROTECTED_MODE=true` and no
`ADMIN_KEY` would reject every upload and offer no way to register a
key — a silent lockout.

Solution: `loadConfig()` throws a descriptive error on startup, the
container exits, and Railway/Docker surface it.

---

## 15. Configuration

Every variable has a safe default. Nothing is required for local
development; only `ADMIN_KEY` must be provided in production when
`PROTECTED_MODE=true` (the default).

| Variable           | Default                  | Purpose                                                               |
| ------------------ | ------------------------ | --------------------------------------------------------------------- |
| `PORT`             | `3847`                   | HTTP listen port. Bind is always `0.0.0.0`.                           |
| `BASE_URL`         | `http://localhost:$PORT` | Canonical public URL used to construct response `url`.                |
| `MAX_FILE_SIZE_MB` | `10`                     | Upload size limit; excess → 413.                                      |
| `DATA_DIR`         | `./data`                 | Base path; SQLite at `$DATA_DIR/db.sqlite`, blobs under `.../files/`. |
| `PROTECTED_MODE`   | `true`                   | `true` → only registered keys can upload.                             |
| `ADMIN_KEY`        | —                        | UUID. Required in protected mode. Unset → `/admin/*` returns 404.     |

`.env.example` in the repo documents all of these.

---

## 16. Deployment

### 16.1 Docker

The image is single-stage and does not run `bun install`:

```Dockerfile
FROM oven/bun:1-alpine
WORKDIR /app
COPY src ./src
COPY openapi.json package.json ./
RUN mkdir -p /app/data/files && chown -R bun:bun /app
# runs as root so Railway-style volumes mounted as root:root work
ENV PORT=3847 DATA_DIR=/app/data MAX_FILE_SIZE_MB=10 PROTECTED_MODE=true
EXPOSE 3847
HEALTHCHECK CMD wget -qO- http://localhost:3847/health || exit 1
CMD ["bun", "run", "src/server.ts"]
```

No `VOLUME` declaration — platforms like Railway ban it and manage
persistence externally.

### 16.2 Railway

Mount a persistent volume at `/data` and set `DATA_DIR=/data`. Set
`BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}` for stable response
URLs. Set `ADMIN_KEY` to a UUID and keep it secret.

Without the volume, SQLite and all blobs live in the container FS and
vanish on every redeploy.

### 16.3 Local

```bash
ADMIN_KEY=$(uuidgen | tr '[:upper:]' '[:lower:]') bun run src/server.ts
```

Data lives in `./data/` (gitignored). `PROTECTED_MODE=true` is the
default even locally — expected workflow is to create an admin-side
key once on each workstation.

---

## 17. Testing

Two suites run via `bun test`:

- `tests/unit/` — isolated module tests. Each unit test spins up a
  disposable SQLite file in `mkdtemp` and tears it down after.
- `tests/integration/` — each file starts a real `Bun.serve` on port
  `0` (kernel-assigned), performs `fetch` against it, and stops the
  server in `afterAll`. Tests exercise the full wire format including
  the envelope.

All integration tests assert the envelope shape explicitly
(`expect(body.success).toBe(true)` or `false`). There is no
"bare-field" assertion that could silently pass if the envelope were
accidentally dropped.

Coverage targets:

- Every route × every documented error path has an integration test.
- URL reservation and cascade semantics have dedicated tests beyond
  the simple happy-path.
- Every `src/*.ts` helper has a unit test.

---

## 18. What's deliberately out of scope

- **Rate limiting.** Operate behind a reverse proxy if you need it.
- **Streaming uploads.** The whole file is buffered for hashing.
  Practical cap is around 50 MB; above that, hash incrementally or
  delegate.
- **Range requests / video streaming.** Not supported.
- **User-facing key management.** Admin-only. No self-service
  signup.
- **Listing or search.** You need to know the UUID. This is a feature.
- **Soft-delete (trash).** `suspended` covers the hide-but-keep case.
- **Audit log.** Not implemented; add when a real auditing
  requirement arrives.
- **Multi-tenant separation.** API keys are flat; no concept of orgs
  or teams. Use separate deployments if you need isolation.
