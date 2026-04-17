import type { Config } from "../config";
import type { Db, KeyStatus } from "../db";
import { extractAdminKey } from "../auth";
import { err, ok } from "../http";
import { unlinkBlob } from "../storage";
import { isUuid } from "../validation";

const STATUSES: KeyStatus[] = ["active", "inactive", "suspended"];

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function handleAdmin(
  req: Request,
  url: URL,
  config: Config,
  db: Db,
  adminKey: string,
): Promise<Response> {
  const presented = extractAdminKey(req);
  if (presented !== adminKey) return err(401, "Admin access required");

  const parts = url.pathname.split("/").filter((s) => s.length > 0);
  if (parts[0] !== "admin" || parts[1] !== "keys") return err(404, "Not found");

  if (parts.length === 2) {
    if (req.method === "POST") return createKey(req, db);
    if (req.method === "GET") return ok({ keys: db.listApiKeys() });
    return err(404, "Not found");
  }

  if (parts.length >= 3) {
    const key = parts[2]!.toLowerCase();
    if (!isUuid(key)) return err(400, "Invalid UUID in path");

    if (parts.length === 4 && parts[3] === "rotate") {
      if (req.method === "POST") return rotateKey(req, db, key);
      return err(404, "Not found");
    }

    if (parts.length === 3) {
      if (req.method === "GET") return getKey(db, key);
      if (req.method === "PATCH") return patchKey(req, db, key);
      if (req.method === "DELETE") return deleteKey(url, config, db, key);
      return err(404, "Not found");
    }
  }

  return err(404, "Not found");
}

async function createKey(req: Request, db: Db): Promise<Response> {
  const body = await readJson(req);
  if (body === null) return err(400, "Invalid JSON body");
  const { apiKey: requestedKey, status: requestedStatus } = body as {
    apiKey?: unknown;
    status?: unknown;
  };

  let apiKey: string;
  if (requestedKey === undefined || requestedKey === null) {
    apiKey = crypto.randomUUID();
  } else if (typeof requestedKey === "string" && isUuid(requestedKey)) {
    apiKey = requestedKey.toLowerCase();
  } else {
    return err(400, "Invalid UUID in 'apiKey'");
  }

  let status: KeyStatus = "active";
  if (requestedStatus !== undefined) {
    if (
      typeof requestedStatus !== "string" ||
      !STATUSES.includes(requestedStatus as KeyStatus)
    ) {
      return err(
        400,
        "Invalid status — must be one of: active, inactive, suspended",
      );
    }
    status = requestedStatus as KeyStatus;
  }

  if (db.getApiKey(apiKey) !== null) return err(409, "API key already exists");

  db.insertApiKey(apiKey, status);
  return ok({ ...db.getApiKey(apiKey)! });
}

function getKey(db: Db, key: string): Response {
  const row = db.getApiKeyWithStats(key);
  if (row === null) return err(404, `API key '${key}' not found`);
  return ok({ ...row });
}

async function patchKey(req: Request, db: Db, key: string): Promise<Response> {
  const body = await readJson(req);
  if (body === null) return err(400, "Invalid JSON body");
  const { status } = body as { status?: unknown };
  if (typeof status !== "string" || !STATUSES.includes(status as KeyStatus)) {
    return err(
      400,
      "Invalid status — must be one of: active, inactive, suspended",
    );
  }
  if (db.getApiKey(key) === null) return err(404, `API key '${key}' not found`);
  db.updateApiKeyStatus(key, status as KeyStatus);
  return ok({ ...db.getApiKeyWithStats(key)! });
}

async function deleteKey(
  url: URL,
  config: Config,
  db: Db,
  key: string,
): Promise<Response> {
  if (db.getApiKey(key) === null) return err(404, `API key '${key}' not found`);

  const cascade = url.searchParams.get("cascade") === "true";
  const fileIds = db.listFileIdsByApiKey(key);

  if (!cascade && fileIds.length > 0) {
    return err(
      409,
      `Cannot delete key — ${fileIds.length} file(s) still reference it. Delete files or rotate first.`,
    );
  }

  // Cascade path (or non-cascade with zero files) — gather blob coords
  // outside the transaction so we can unlink on disk first.
  type BlobCoord = { fileId: string; version: number; ext: string };
  const toUnlink: BlobCoord[] = [];
  for (const fid of fileIds) {
    for (const v of db.listVersionsForFile(fid)) {
      toUnlink.push({ fileId: fid, version: v.version, ext: v.ext });
    }
  }

  try {
    for (const u of toUnlink) {
      await unlinkBlob(config.filesDir, u.fileId, u.version, u.ext);
    }
  } catch (e) {
    console.error("unlink failed during cascade delete:", e);
    return err(500, "Storage error");
  }

  db.transaction(() => {
    for (const fid of fileIds) {
      db.deleteAllVersionsOfFile(fid);
      // Cascade releases the URL fully — no tombstone, because a
      // tombstone pointing at a deleted owner is a zombie reservation.
      db.deleteFileRow(fid);
    }
    db.deleteApiKey(key);
  });

  return ok();
}

async function rotateKey(
  req: Request,
  db: Db,
  oldKey: string,
): Promise<Response> {
  const body = await readJson(req);
  if (body === null) return err(400, "Invalid JSON body");
  const { newKey: requestedNew } = body as { newKey?: unknown };

  if (db.getApiKey(oldKey) === null)
    return err(404, `API key '${oldKey}' not found`);

  let newKey: string;
  if (requestedNew === undefined || requestedNew === null) {
    newKey = crypto.randomUUID();
  } else if (typeof requestedNew === "string" && isUuid(requestedNew)) {
    newKey = requestedNew.toLowerCase();
    if (db.getApiKey(newKey) !== null) return err(409, "newKey already exists");
    if (newKey === oldKey) return err(409, "newKey equals oldKey");
  } else {
    return err(400, "Invalid UUID in 'newKey'");
  }

  const transferred = db.rotateApiKey(oldKey, newKey);
  return ok({ oldKey, newKey, filesTransferred: transferred });
}
