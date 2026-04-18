import type { Config } from "../config";
import type { Db } from "../db";
import { authorizeOwnerOrAdmin } from "../auth";
import { err, ok } from "../http";
import { resolveFile } from "./shared";

export async function handleAnalytics(
  req: Request,
  url: URL,
  config: Config,
  db: Db,
): Promise<Response> {
  const parts = url.pathname.split("/").filter((s) => s.length > 0);
  if (parts.length !== 3 || parts[0] !== "files" || parts[2] !== "analytics") {
    return err(404, "Not found");
  }
  const idOrShortId = parts[1]!;

  const resolved = resolveFile(idOrShortId, db);
  if (!resolved.ok && resolved.reason === "invalid") {
    return err(400, "Invalid id in path — expected UUID or base62 shortId");
  }
  if (!resolved.ok) return err(404, `File '${resolved.resolvedId}' not found`);
  const { file } = resolved;

  const outcome = authorizeOwnerOrAdmin(req, db, file, config);
  if (outcome === "unauthenticated") return err(401, "Authentication required");
  if (outcome === "forbidden") return err(403, "Forbidden");

  const a = db.getFileAnalytics(file.id);
  return ok({
    fileId: file.id,
    shortId: file.shortId,
    totals: a.totals,
    perDay: a.perDay,
    perVersion: a.perVersion,
  });
}
