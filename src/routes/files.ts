import type { Config } from "../config";
import type { Db } from "../db";
import { extractApiKey } from "../auth";
import { err, ok } from "../http";

// GET /files — list files owned by the caller's API key, sorted by most recent
// upload first. Requires X-Api-Key (or Authorization: Bearer <uuid>) whose key
// is 'active'. Tombstone files (DELETE'd, no versions remaining) are excluded
// because the INNER JOIN drops them.
export async function handleListFiles(
  req: Request,
  _url: URL,
  _config: Config,
  db: Db,
): Promise<Response> {
  const { apiKey, error: keyError } = extractApiKey(req);
  if (keyError) return err(400, keyError);
  if (apiKey === null) return err(401, "API key required");

  const row = db.getApiKey(apiKey);
  if (row === null) return err(403, "Unknown API key");
  if (row.status !== "active") return err(403, `API key is ${row.status}`);

  return ok({ files: db.listFilesForApiKey(apiKey) });
}
