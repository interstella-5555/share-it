import type { Db, FileRow } from "../db";
import { isShortId, isUuid } from "../validation";

// Resolve a URL-path id that may be either a canonical UUID (case-
// insensitive, lowercased at the boundary) or a base62 shortId (case-
// sensitive). Returns:
//   { ok: true, file } on hit
//   { ok: false, reason: "invalid" } if the string is neither shape
//   { ok: false, reason: "not-found" } if the shape was valid but no row matches
export type ResolveResult =
  | { ok: true; file: FileRow; resolvedId: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "not-found"; resolvedId: string };

export function resolveFile(idOrShort: string, db: Db): ResolveResult {
  if (isUuid(idOrShort)) {
    const id = idOrShort.toLowerCase();
    const file = db.getFile(id);
    if (file === null)
      return { ok: false, reason: "not-found", resolvedId: id };
    return { ok: true, file, resolvedId: id };
  }
  if (isShortId(idOrShort)) {
    const file = db.getFileByShortId(idOrShort);
    if (file === null)
      return { ok: false, reason: "not-found", resolvedId: idOrShort };
    return { ok: true, file, resolvedId: idOrShort };
  }
  return { ok: false, reason: "invalid" };
}
