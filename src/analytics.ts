export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function hashIpDay(salt: string, ip: string, day: string): string {
  return createHash("sha256")
    .update(salt + ip + day)
    .digest("hex");
}

export function loadOrCreateSalt(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(dirname(path), { recursive: true });
  const salt = randomBytes(32).toString("hex");
  writeFileSync(path, salt, { mode: 0o600 });
  return salt;
}

interface IpProvider {
  requestIP(r: Request): { address: string } | null;
}

export function clientIp(req: Request, server: IpProvider): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff !== null) return xff.split(",")[0]!.trim();
  return server.requestIP(req)?.address ?? "unknown";
}
