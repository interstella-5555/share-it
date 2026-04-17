# share-it

Small file hosting HTTP API on Bun. Upload a file, get a URL. Update files with an API key. Supports HTML, plain text, Markdown, JSON, PNG, JPEG, GIF. Public endpoint, spam-resistant via a default **protected mode** that requires admin-registered API keys.

## Using with Claude Code

This repo ships a Claude Code [plugin marketplace](https://docs.claude.com/en/docs/claude-code/plugins) with one plugin (`share-it`) containing one skill. After installing, you can ask Claude to "share this file" or "upload this to share-it" and the skill handles the rest — including first-run setup.

### Install

```bash
claude plugins marketplace add interstella-5555/share-it
claude plugins install share-it@share-it
```

Restart Claude Code so the skill loads.

See [`plugins/share-it/skills/share-it/SKILL.md`](plugins/share-it/skills/share-it/SKILL.md) for the full skill spec.

## Run locally

```bash
bun install

# Dev: non-protected mode, no env vars needed
PROTECTED_MODE=false bun run dev

# Dev: protected mode (just add an admin key)
ADMIN_KEY=$(uuidgen | tr '[:upper:]' '[:lower:]') bun run dev
```

Environment variables:

| Name               | Default                    | Notes                                                               |
| ------------------ | -------------------------- | ------------------------------------------------------------------- |
| `PORT`             | `3847`                     | HTTP listen port                                                    |
| `BASE_URL`         | `http://localhost:${PORT}` | Set in production to your public URL (used in response bodies)      |
| `MAX_FILE_SIZE_MB` | `10`                       | 413 if exceeded                                                     |
| `DATA_DIR`         | `./data`                   | SQLite at `${DATA_DIR}/db.sqlite`, blobs under `${DATA_DIR}/files`. |
| `PROTECTED_MODE`   | `true`                     | `true` / `false`. Controls whether unknown keys can upload.         |
| `ADMIN_KEY`        | —                          | UUID. Required when `PROTECTED_MODE=true`. Enables `/admin/*`.      |

## Docker

```bash
docker build -t share-it .
docker run -d --name share-it \
  -p 3847:3847 \
  -e BASE_URL=https://share.example.com \
  -e ADMIN_KEY=<uuid> \
  -v share-it-data:/app/data \
  share-it
```

## API reference

Every running instance serves live docs at **`GET /docs`** (Scalar-rendered OpenAPI). For example, locally: `http://localhost:3847/docs`.

The canonical machine-readable spec lives at [`openapi.json`](openapi.json) and is also served at `GET /openapi.json`. `GET /` returns discovery JSON + RFC 8631 `Link` header pointing to both.

## Adding a new file type

Edit `src/validation.ts` and add one entry to `ALLOWED_TYPES`:

```ts
svg: { ext: "svg", mime: "image/svg+xml", charset: "utf-8" },
```

Optionally add an alias in `EXT_ALIASES`. That's it — storage, hashing, caching, routing are content-agnostic.

**When you change an endpoint**, also update `openapi.json` in the same commit — it's the canonical machine-readable spec. See `CLAUDE.md` for the sync checklist.

## Tests

The suite runs on `bun test` (Bun's built-in runner, no framework). Unit tests exercise single modules in isolation (each test spins up a fresh `mkdtemp` scratch dir + fresh SQLite file); integration tests start a real `Bun.serve` on an ephemeral port and hit it via `fetch`.

```bash
bun test                       # full suite: unit + integration
bun run test:unit              # only tests under tests/unit/
bun run test:integration       # only tests under tests/integration/
```

What's covered:

- **Unit** — `http` envelope helpers, `shortid` hashing, `storage` blob IO, `validation` (UUID / shortId / MIME / filename sanitization), `db` (schema bootstrap, migrations, CRUD, delete helpers), `auth` (header extraction, keyGate, owner-or-admin).
- **Integration** — every route end-to-end: upload with dedup / versioning / 413 / 415, serve (UUID + shortId, ETag, Cache-Control, suspended hiding), delete (owner + admin, per-version, URL reservation via tombstone), admin CRUD + status transitions + rotate + cascade, `/files` listing, `/docs` HTML, discovery + openapi, UUID case-insensitivity invariant.

Tests pass in a single `bun test` run with no external dependencies (no network, no Docker).
