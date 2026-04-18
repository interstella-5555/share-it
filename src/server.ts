import { loadConfig, type Config } from "./config";
import { Db } from "./db";
import { err } from "./http";
import { loadOrCreateSalt } from "./analytics";
import { join } from "node:path";
import { handleHealth } from "./routes/health";
import { handleAdmin } from "./routes/admin";
import { handleDelete } from "./routes/delete";
import { handleDocs } from "./routes/docs";
import { handleListFiles } from "./routes/files";
import { handleOpenapi, handleRoot } from "./routes/meta";
import { handleAnalytics } from "./routes/analytics";
import { handleServe } from "./routes/serve";
import { handleUpload } from "./routes/upload";

function notFound(): Response {
  return err(404, "Not found");
}

function internalError(e: unknown): Response {
  console.error("Unhandled error:", e);
  return err(500, "Internal server error");
}

export function createServer(
  config: Config,
  db: Db,
): ReturnType<typeof Bun.serve> {
  const salt = loadOrCreateSalt(join(config.dataDir, "analytics-salt"));
  return Bun.serve({
    port: config.port,
    async fetch(req, server) {
      try {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/health")
          return handleHealth();
        if (req.method === "GET" && url.pathname === "/") return handleRoot();
        if (req.method === "GET" && url.pathname === "/openapi.json")
          return handleOpenapi();
        if (req.method === "GET" && url.pathname === "/docs")
          return handleDocs();
        if (req.method === "POST" && url.pathname === "/share")
          return await handleUpload(req, url, config, db);
        if (req.method === "GET" && url.pathname === "/files")
          return await handleListFiles(req, url, config, db);
        if (
          req.method === "GET" &&
          /^\/files\/[^/]+\/analytics$/.test(url.pathname)
        )
          return await handleAnalytics(req, url, config, db);
        if (req.method === "GET" && url.pathname.startsWith("/share/"))
          return await handleServe(req, url, config, db, server, salt);
        if (req.method === "DELETE" && url.pathname.startsWith("/share/"))
          return await handleDelete(req, url, config, db);
        if (url.pathname.startsWith("/admin/")) {
          if (config.adminKey === null) return notFound();
          return await handleAdmin(req, url, config, db, config.adminKey);
        }
        return notFound();
      } catch (e) {
        return internalError(e);
      }
    },
  });
}

if (import.meta.main) {
  const config = loadConfig();
  const db = new Db(config.dbPath);
  const server = createServer(config, db);
  console.log(
    `share-it listening on http://localhost:${server.port} (protectedMode=${config.protectedMode}, adminEnabled=${config.adminKey !== null})`,
  );
}
