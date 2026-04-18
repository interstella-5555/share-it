import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  hashIpDay,
  utcDay,
  loadOrCreateSalt,
  clientIp,
} from "../../src/analytics";
import { mkdtempSync, statSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("utcDay()", () => {
  test("formats a timestamp as UTC YYYY-MM-DD", () => {
    const ts = Date.UTC(2026, 3, 17, 12, 0, 0);
    expect(utcDay(ts)).toBe("2026-04-17");
  });

  test("is stable across the UTC midnight boundary", () => {
    const before = Date.UTC(2026, 3, 17, 23, 59, 59);
    const after = Date.UTC(2026, 3, 18, 0, 0, 0);
    expect(utcDay(before)).toBe("2026-04-17");
    expect(utcDay(after)).toBe("2026-04-18");
  });

  test("always uses UTC slicing regardless of server local TZ", () => {
    const ts = Date.UTC(2026, 3, 18, 0, 0, 30);
    expect(utcDay(ts)).toBe("2026-04-18");
  });
});

describe("hashIpDay()", () => {
  test("produces 64-char lowercase hex", () => {
    const h = hashIpDay("some-salt", "1.2.3.4", "2026-04-18");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for identical inputs", () => {
    const a = hashIpDay("s", "1.2.3.4", "2026-04-18");
    const b = hashIpDay("s", "1.2.3.4", "2026-04-18");
    expect(a).toBe(b);
  });

  test("differs when the day changes", () => {
    const d1 = hashIpDay("s", "1.2.3.4", "2026-04-17");
    const d2 = hashIpDay("s", "1.2.3.4", "2026-04-18");
    expect(d1).not.toBe(d2);
  });

  test("differs when the IP changes", () => {
    const a = hashIpDay("s", "1.2.3.4", "2026-04-18");
    const b = hashIpDay("s", "1.2.3.5", "2026-04-18");
    expect(a).not.toBe(b);
  });

  test("differs when the salt changes", () => {
    const a = hashIpDay("salt-1", "1.2.3.4", "2026-04-18");
    const b = hashIpDay("salt-2", "1.2.3.4", "2026-04-18");
    expect(a).not.toBe(b);
  });
});

describe("loadOrCreateSalt()", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "es-salt-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates a new salt file with 0600 perms on first call", () => {
    const path = join(dir, "analytics-salt");
    const salt = loadOrCreateSalt(path);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf8")).toBe(salt);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("returns the same salt on subsequent calls", () => {
    const path = join(dir, "analytics-salt");
    const a = loadOrCreateSalt(path);
    const b = loadOrCreateSalt(path);
    expect(a).toBe(b);
  });

  test("creates the parent directory if it does not exist", () => {
    const path = join(dir, "nested", "sub", "analytics-salt");
    const salt = loadOrCreateSalt(path);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
  });
});

function stubServer(ip: string | null) {
  return { requestIP: (_r: Request) => (ip === null ? null : { address: ip }) };
}

describe("clientIp()", () => {
  test("prefers first X-Forwarded-For hop when present", () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientIp(req, stubServer("127.0.0.1"))).toBe("203.0.113.7");
  });

  test("trims whitespace around the first XFF hop", () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": "  198.51.100.42  , 10.0.0.1" },
    });
    expect(clientIp(req, stubServer("127.0.0.1"))).toBe("198.51.100.42");
  });

  test("falls back to server.requestIP when XFF absent", () => {
    const req = new Request("http://x/");
    expect(clientIp(req, stubServer("192.0.2.5"))).toBe("192.0.2.5");
  });

  test("returns 'unknown' when XFF absent and requestIP is null", () => {
    const req = new Request("http://x/");
    expect(clientIp(req, stubServer(null))).toBe("unknown");
  });
});
