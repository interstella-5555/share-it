import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config";
import { Db } from "../../src/db";
import { createServer } from "../../src/server";

export interface TestServer {
  server: ReturnType<typeof Bun.serve>;
  db: Db;
  config: Config;
  tmpDir: string;
  baseUrl: string;
  cleanup(): Promise<void>;
}

export async function startTestServer(
  overrides: Partial<Config> = {},
): Promise<TestServer> {
  const tmpDir = await mkdtemp(join(tmpdir(), "es-it-"));
  const dataDir = tmpDir;
  const dbPath = join(dataDir, "db.sqlite");
  const filesDir = join(dataDir, "files");

  const config: Config = {
    port: 0,
    baseUrl: "http://localhost:0",
    maxFileSizeBytes: 10 * 1024 * 1024,
    dataDir,
    dbPath,
    filesDir,
    protectedMode: false, // default OFF in tests for convenience
    adminKey: null,
    ...overrides,
  };

  const db = new Db(dbPath);
  const server = createServer(config, db);
  config.baseUrl = `http://localhost:${server.port}`;

  return {
    server,
    db,
    config,
    tmpDir,
    baseUrl: config.baseUrl,
    async cleanup() {
      server.stop(true);
      db.close();
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}
