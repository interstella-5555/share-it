# share-it — development notes for Claude

## OpenAPI specification — keep in sync

This project ships a hand-written, static `openapi.json` at the repo root.
It is the canonical machine-readable API description, served verbatim at
`GET /openapi.json` and pointed at from `GET /` (body + RFC 8631 `Link`
header).

**Sync rule — non-negotiable:** when you change any HTTP endpoint (add /
remove / rename / change parameters, headers, request body, response
shape, status codes, error messages, schemas), you MUST update
`openapi.json` in the same commit. The design spec in
`docs/superpowers/specs/` should also reflect the change.

Concretely, when you touch:

- A route → update `paths[path][method]` (summary, parameters,
  requestBody, responses, security)
- An error → add/update the response's `content.application/json.schema`
  and an `example` with the exact error string
- A request/response shape → update `components.schemas[Name]`
- A new header → `components.parameters` (or inline in the operation)
- A new endpoint → a new `paths` entry plus any new schemas

Keep `openapi.json` OpenAPI 3.1 valid. Sanity checks:

- `bunx --bun @apidevtools/swagger-cli validate openapi.json` (install
  when needed, don't add as a permanent dep)
- Or paste into `https://editor.swagger.io`

No auto-generation — we don't use Zod / TypeBox / a decorator framework,
so there's no source from which to derive the spec. The file is the
source of truth for external consumers; the code is the source of truth
for behaviour. Both must be kept aligned by hand.

## Design doc

Full design lives at
`docs/superpowers/specs/2026-04-16-share-it-api-design.md`. Any
behaviour change should land in the spec, `openapi.json`, and the code
together.

## Project invariants

- Zero non-dev runtime deps (Bun stdlib + `bun:sqlite` only).
- No HTTP framework — bare `Bun.serve` with a small manual router in
  `src/server.ts`.
- No Zod / validators library — hand-rolled checks in `src/validation.ts`.
- camelCase everywhere, including SQLite column names.
- `apiKeys.status` is one of exactly `active` | `inactive` | `suspended`
  (CHECK constraint in the schema). Do not introduce new statuses
  casually — it propagates through `keyGate`, admin PATCH validation,
  and both integration test suites.
- Owned files are never served with `Cache-Control: immutable` (a
  `suspended` owner can flip 200 → 404 any time). Only anonymous files
  (apiKey IS NULL, only created in non-protected mode) get immutable
  caching.
