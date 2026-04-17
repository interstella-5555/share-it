import { join } from "node:path";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface Config {
  port: number;
  baseUrl: string;
  maxFileSizeBytes: number;
  dataDir: string;
  dbPath: string;
  filesDir: string;
  protectedMode: boolean;
  adminKey: string | null;
}

export function loadConfig(): Config {
  const portRaw = process.env.PORT ?? "3847";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: '${portRaw}' (expected integer 1-65535)`);
  }

  const baseUrlRaw = process.env.BASE_URL ?? `http://localhost:${port}`;
  const baseUrl = baseUrlRaw.replace(/\/+$/, "");

  const mbRaw = process.env.MAX_FILE_SIZE_MB ?? "10";
  const mb = Number(mbRaw);
  if (!Number.isFinite(mb) || mb <= 0) {
    throw new Error(
      `Invalid MAX_FILE_SIZE_MB: '${mbRaw}' (expected positive number)`,
    );
  }

  const protRaw = (process.env.PROTECTED_MODE ?? "true").toLowerCase();
  let protectedMode: boolean;
  if (protRaw === "true") protectedMode = true;
  else if (protRaw === "false") protectedMode = false;
  else
    throw new Error(
      `Invalid PROTECTED_MODE: '${process.env.PROTECTED_MODE}' (expected 'true' or 'false')`,
    );

  const adminRaw = process.env.ADMIN_KEY;
  let adminKey: string | null = null;
  if (adminRaw !== undefined && adminRaw !== "") {
    if (!UUID_REGEX.test(adminRaw)) {
      throw new Error(`Invalid ADMIN_KEY: must be a UUID`);
    }
    adminKey = adminRaw.toLowerCase();
  }

  if (protectedMode && adminKey === null) {
    throw new Error(
      "PROTECTED_MODE=true requires ADMIN_KEY to be set. Without an admin key no one can register API keys, so uploads are impossible. Set ADMIN_KEY=<uuid> or disable protected mode with PROTECTED_MODE=false.",
    );
  }

  const dataDir = process.env.DATA_DIR ?? "./data";

  return {
    port,
    baseUrl,
    maxFileSizeBytes: Math.floor(mb * 1024 * 1024),
    dataDir,
    dbPath: join(dataDir, "db.sqlite"),
    filesDir: join(dataDir, "files"),
    protectedMode,
    adminKey,
  };
}
