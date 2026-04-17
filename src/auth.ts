import type { Config } from "./config";
import type { Db } from "./db";
import { isUuid } from "./validation";

export interface ApiKeyResult {
  apiKey: string | null;
  error: string | null;
}

export function extractApiKey(req: Request): ApiKeyResult {
  const x = req.headers.get("x-api-key");
  if (x !== null) {
    if (!isUuid(x))
      return {
        apiKey: null,
        error:
          "Invalid API key format. Expected UUID in 'X-API-Key' or 'Authorization: Bearer <uuid>'",
      };
    return { apiKey: x.toLowerCase(), error: null };
  }
  const auth = req.headers.get("authorization");
  if (auth !== null) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && isUuid(m[1]!)) return { apiKey: m[1]!.toLowerCase(), error: null };
    if (m)
      return {
        apiKey: null,
        error:
          "Invalid API key format. Expected UUID in 'X-API-Key' or 'Authorization: Bearer <uuid>'",
      };
  }
  return { apiKey: null, error: null };
}

export function extractAdminKey(req: Request): string | null {
  const x = req.headers.get("x-admin-key");
  return x !== null ? x.toLowerCase() : null;
}

export type GateResult =
  | { ok: true; apiKey: string | null }
  | { ok: false; status: number; error: string };

export function keyGate(
  db: Db,
  protectedMode: boolean,
  apiKey: string | null,
): GateResult {
  if (protectedMode) {
    if (apiKey === null) {
      return {
        ok: false,
        status: 401,
        error: "API key required in protected mode",
      };
    }
    const row = db.getApiKey(apiKey);
    if (row === null) {
      return {
        ok: false,
        status: 403,
        error: "Unknown API key. Contact admin.",
      };
    }
    if (row.status === "inactive")
      return { ok: false, status: 403, error: "API key is inactive" };
    if (row.status === "suspended")
      return { ok: false, status: 403, error: "API key is suspended" };
    return { ok: true, apiKey };
  }
  // non-protected
  if (apiKey === null) return { ok: true, apiKey: null };
  const row = db.getApiKey(apiKey);
  if (row === null) {
    db.insertApiKey(apiKey, "active");
    return { ok: true, apiKey };
  }
  if (row.status === "inactive")
    return { ok: false, status: 403, error: "API key is inactive" };
  if (row.status === "suspended")
    return { ok: false, status: 403, error: "API key is suspended" };
  return { ok: true, apiKey };
}

export type AuthOutcome = "admin" | "owner" | "forbidden" | "unauthenticated";

export function authorizeOwnerOrAdmin(
  req: Request,
  db: Db,
  file: { apiKey: string | null },
  config: Pick<Config, "adminKey">,
): AuthOutcome {
  const adminHdrRaw = req.headers.get("x-admin-key");
  const apiHdrRaw = req.headers.get("x-api-key");

  if (adminHdrRaw !== null) {
    const adminHdr = adminHdrRaw.toLowerCase();
    if (config.adminKey !== null && adminHdr === config.adminKey)
      return "admin";
    return "unauthenticated";
  }

  if (apiHdrRaw === null) return "unauthenticated";
  const apiHdr = apiHdrRaw.toLowerCase();
  if (file.apiKey === null) return "forbidden";
  const key = db.getApiKey(apiHdr);
  if (key === null) return "forbidden";
  if (key.status !== "active") return "forbidden";
  if (file.apiKey !== apiHdr) return "forbidden";
  return "owner";
}
