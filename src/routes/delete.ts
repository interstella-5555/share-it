import type { Config } from "../config";
import type { Db } from "../db";
import { authorizeOwnerOrAdmin } from "../auth";
import { err, ok } from "../http";
import { unlinkBlob } from "../storage";
import { parseVersionParam } from "../validation";
import { resolveFile } from "./shared";

export async function handleDelete(
  req: Request,
  url: URL,
  config: Config,
  db: Db,
): Promise<Response> {
  const parts = url.pathname.split("/").filter((s) => s.length > 0);
  if (parts[0] !== "share" || parts.length < 2 || parts.length > 3) {
    return err(404, "Not found");
  }

  const resolved = resolveFile(parts[1]!, db);
  if (!resolved.ok && resolved.reason === "invalid") {
    return err(400, "Invalid id in path — expected UUID or base62 shortId");
  }
  if (!resolved.ok) return err(404, `File '${resolved.resolvedId}' not found`);
  const { file, resolvedId: id } = resolved;

  const outcome = authorizeOwnerOrAdmin(req, db, file, config);
  if (outcome === "unauthenticated") return err(401, "Authentication required");
  if (outcome === "forbidden") return err(403, "Forbidden");

  if (parts.length === 2) {
    // DELETE /share/:id — whole file.
    // Remove every version row and every blob on disk, but keep the
    // files row as a tombstone so the URL stays reserved to the
    // original owner. See upload.ts:~92 — the ownership check on
    // existing files blocks strangers from re-claiming the id.
    const rows = db.listVersionsForFile(file.id);
    try {
      for (const r of rows) {
        await unlinkBlob(config.filesDir, file.id, r.version, r.ext);
      }
    } catch (e) {
      console.error("unlink failed during delete:", e);
      return err(500, "Storage error");
    }
    db.transaction(() => {
      db.deleteAllVersionsOfFile(file.id);
      db.deleteAnalyticsForFile(file.id);
    });
    return ok();
  }

  // DELETE /share/:id/:version
  const parsed = parseVersionParam(parts[2]!);
  if (!parsed.ok) return err(400, parsed.error);
  const version = parsed.version;

  const maxBefore = db.maxVersion(file.id);
  const row = db.deleteOneVersion(file.id, version);
  if (row === null) {
    return err(
      404,
      `Version ${version} of file '${id}' not found. Latest version: ${maxBefore ?? 0}`,
    );
  }

  try {
    await unlinkBlob(config.filesDir, file.id, version, row.ext);
  } catch (e) {
    console.error("unlink failed during version delete:", e);
    return err(500, "Storage error");
  }
  db.deleteAnalyticsForVersion(file.id, version);
  return ok();
}
