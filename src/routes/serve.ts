import type { Config } from "../config";
import type { Db } from "../db";
import { clientIp, hashIpDay, utcDay } from "../analytics";
import { err } from "../http";
import { pathForBlob } from "../storage";
import { resolveFile } from "./shared";
import {
  ALLOWED_TYPES,
  asciiFallback,
  contentTypeHeader,
  encodeRFC5987,
  parseVersionParam,
} from "../validation";

export async function handleServe(
  req: Request,
  url: URL,
  config: Config,
  db: Db,
  server: import("bun").Server<unknown>,
  salt: string,
): Promise<Response> {
  const parts = url.pathname.split("/").filter((s) => s.length > 0);
  // path is /share/:id[/:version]
  if (parts[0] !== "share" || parts.length < 2 || parts.length > 3) {
    return err(404, "Not found");
  }

  const resolved = resolveFile(parts[1]!, db);
  if (!resolved.ok && resolved.reason === "invalid") {
    return err(400, "Invalid id in path — expected UUID or base62 shortId");
  }

  let requestedVersion: number | null = null;
  if (parts.length === 3) {
    const parsed = parseVersionParam(parts[2]!);
    if (!parsed.ok) return err(400, parsed.error);
    requestedVersion = parsed.version;
  }

  if (!resolved.ok) return err(404, `File '${resolved.resolvedId}' not found`);
  const { file, resolvedId: id } = resolved;

  // suspension hides files
  if (file.apiKey !== null) {
    const key = db.getApiKey(file.apiKey);
    if (key?.status === "suspended") return err(404, `File '${id}' not found`);
  }

  const max = db.maxVersion(file.id);
  if (max === null) return err(404, `File '${id}' not found`);

  const targetVersion = requestedVersion ?? max;
  const row = db.getVersion(file.id, targetVersion);
  if (row === null) {
    return err(
      404,
      `Version ${targetVersion} of file '${id}' not found. Latest version: ${max}`,
    );
  }

  const etag = `"${row.hash}"`;
  if (req.headers.get("if-none-match") === etag) {
    const day304 = utcDay(Date.now());
    const ip304 = clientIp(req, server);
    queueMicrotask(() => {
      try {
        db.recordView(
          file.id,
          targetVersion,
          day304,
          hashIpDay(salt, ip304, day304),
        );
      } catch (e) {
        console.error("analytics recordView failed:", e);
      }
    });
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const cacheControl =
    file.apiKey === null
      ? "public, max-age=31536000, immutable"
      : "public, no-cache";

  const allowed = ALLOWED_TYPES[row.ext as keyof typeof ALLOWED_TYPES];
  if (!allowed) return err(500, "Unknown stored content type");

  const headers: Record<string, string> = {
    "Content-Type": contentTypeHeader(allowed),
    "Content-Length": String(row.size),
    ETag: etag,
    "Cache-Control": cacheControl,
  };

  if (url.searchParams.has("download")) {
    const ascii = asciiFallback(row.originalName);
    const encoded = encodeRFC5987(row.originalName);
    headers["Content-Disposition"] =
      `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
  }

  const path = pathForBlob(config.filesDir, file.id, targetVersion, row.ext);
  const stream = Bun.file(path).stream();

  const day = utcDay(Date.now());
  const ip = clientIp(req, server);
  queueMicrotask(() => {
    try {
      db.recordView(file.id, targetVersion, day, hashIpDay(salt, ip, day));
    } catch (e) {
      console.error("analytics recordView failed:", e);
    }
  });

  return new Response(stream, { status: 200, headers });
}
