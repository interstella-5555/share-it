import type { Config } from "../config";
import type { Db, FileRow } from "../db";
import { extractApiKey, keyGate } from "../auth";
import { err, ok } from "../http";
import { sha256Hex } from "../hash";
import { pathForBlob, removeBlob, writeBlob } from "../storage";
import {
  ALLOWED_TYPES,
  canonicalExt,
  extFromFilename,
  isShortId,
  isUuid,
  sanitizeFilename,
} from "../validation";

const ALLOWED =
  "text/html (.html), text/plain (.txt), text/markdown (.md), application/json (.json), image/png (.png), image/jpeg (.jpg), image/gif (.gif)";

export async function handleUpload(
  req: Request,
  url: URL,
  config: Config,
  db: Db,
): Promise<Response> {
  const { apiKey: requestedKey, error: keyError } = extractApiKey(req);
  if (keyError) return err(400, keyError);

  const gate = keyGate(db, config.protectedMode, requestedKey);
  if (!gate.ok) return err(gate.status, gate.error);

  // ?id=<value> accepts either a UUID (case-insensitive, lowercased) or
  // a base62 shortId (case-sensitive). UUIDs can create new files;
  // shortIds can only address existing ones — callers may not claim a
  // new file via shortId since the shortId is derived from the UUID.
  const queryIdRaw = url.searchParams.get("id");
  let queryId: string | null = null;
  let queryShortId: string | null = null;
  if (queryIdRaw !== null) {
    if (isUuid(queryIdRaw)) {
      queryId = queryIdRaw.toLowerCase();
    } else if (isShortId(queryIdRaw)) {
      queryShortId = queryIdRaw;
    } else {
      return err(
        400,
        "Invalid id in query parameter 'id'. Expected a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) or a base62 shortId (10-16 chars)",
      );
    }
  }

  // Clone the request to read raw body for declared Content-Type extraction.
  // Bun's formData() parser re-sniffs MIME from filename, losing the client-declared type.
  const rawBody = await req
    .clone()
    .text()
    .catch(() => "");

  let form: Awaited<ReturnType<Request["formData"]>>;
  try {
    form = await req.formData();
  } catch {
    return err(400, "Missing 'file' field in multipart/form-data body");
  }
  const file = form.get("file");
  if (!(file instanceof File))
    return err(400, "Missing 'file' field in multipart/form-data body");

  if (file.size > config.maxFileSizeBytes) {
    return err(
      413,
      `File size ${file.size} bytes exceeds limit of ${config.maxFileSizeBytes} bytes`,
    );
  }

  const origExt = extFromFilename(file.name);
  const canonExt = origExt !== null ? canonicalExt(origExt) : null;
  if (canonExt === null) {
    return err(
      415,
      `Unsupported file type '${file.type || "unknown"}' with extension '${origExt !== null ? "." + origExt : "none"}'. Allowed: ${ALLOWED}`,
    );
  }
  const type = ALLOWED_TYPES[canonExt as keyof typeof ALLOWED_TYPES];
  // Extract the declared Content-Type from the raw multipart body (Bun re-sniffs file.type from filename).
  const rawCtMatch = rawBody.match(
    /Content-Disposition:[^\r\n]*name="file"[^\r\n]*\r?\nContent-Type:\s*([^\r\n;]+)/i,
  );
  const declaredMime = rawCtMatch?.[1]?.trim() ?? "";
  if (declaredMime !== "" && declaredMime !== type.mime) {
    return err(
      415,
      `Unsupported file type '${declaredMime}' with extension '.${canonExt}'. Allowed: ${ALLOWED}`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = sha256Hex(bytes);

  // Resolve ?id into an existing file row (if any). A shortId query
  // that doesn't match a file is 404 — new files can only be created
  // with a UUID.
  let existing: FileRow | null = null;
  if (queryShortId !== null) {
    existing = db.getFileByShortId(queryShortId);
    if (existing === null) return err(404, `File '${queryShortId}' not found`);
  } else if (queryId !== null) {
    existing = db.getFile(queryId);
  }

  const id = existing?.id ?? queryId ?? crypto.randomUUID();
  const originalName = sanitizeFilename(file.name, `${id}.${canonExt}`);
  const now = Date.now();

  function buildResponse(
    fileRow: { id: string; shortId: string },
    version: number,
  ): Response {
    return ok({
      id: fileRow.id,
      shortId: fileRow.shortId,
      url: `${config.baseUrl}/share/${fileRow.id}`,
      shortUrl: `${config.baseUrl}/share/${fileRow.shortId}`,
      version,
    });
  }

  if (existing !== null) {
    if (existing.apiKey === null) {
      return err(
        403,
        `File '${existing.id}' was uploaded without an API key and is immutable. Use a different id.`,
      );
    }
    if (existing.apiKey !== gate.apiKey) {
      return err(
        403,
        `API key does not match the one used to create file '${existing.id}'. Provide the original key or use a different id.`,
      );
    }
    const latest = db.getLatestVersion(existing.id);
    if (latest !== null && latest.hash === hash) {
      return buildResponse(existing, latest.version);
    }
    const newVersion = (db.maxVersion(existing.id) ?? 0) + 1;
    const blobPath = pathForBlob(
      config.filesDir,
      existing.id,
      newVersion,
      canonExt,
    );
    try {
      await writeBlob(blobPath, bytes);
      db.transaction(() => {
        db.insertVersion({
          fileId: existing.id,
          version: newVersion,
          hash,
          mime: type.mime,
          ext: canonExt,
          size: bytes.length,
          originalName,
          createdAt: now,
        });
      });
    } catch (e) {
      await removeBlob(blobPath);
      throw e;
    }
    return buildResponse(existing, newVersion);
  }

  // new file
  const blobPath = pathForBlob(config.filesDir, id, 1, canonExt);
  try {
    await writeBlob(blobPath, bytes);
    db.transaction(() => {
      db.insertFile(id, gate.apiKey);
      db.insertVersion({
        fileId: id,
        version: 1,
        hash,
        mime: type.mime,
        ext: canonExt,
        size: bytes.length,
        originalName,
        createdAt: now,
      });
    });
  } catch (e) {
    await removeBlob(blobPath);
    throw e;
  }
  const created = db.getFile(id)!;
  return buildResponse(created, 1);
}
