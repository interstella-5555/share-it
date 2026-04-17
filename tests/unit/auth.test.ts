import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../../src/db";
import {
  authorizeOwnerOrAdmin,
  extractApiKey,
  extractAdminKey,
  keyGate,
} from "../../src/auth";

const K = "11111111-2222-4333-8444-555555555555";
const K2 = "22222222-3333-4444-8555-666666666666";

describe("extractApiKey", () => {
  test("X-API-Key valid", () => {
    const req = new Request("http://x/", { headers: { "X-API-Key": K } });
    expect(extractApiKey(req)).toEqual({ apiKey: K, error: null });
  });
  test("Authorization Bearer valid", () => {
    const req = new Request("http://x/", {
      headers: { Authorization: `Bearer ${K}` },
    });
    expect(extractApiKey(req)).toEqual({ apiKey: K, error: null });
  });
  test("X-API-Key wins over Bearer", () => {
    const req = new Request("http://x/", {
      headers: { "X-API-Key": K, Authorization: `Bearer ${K2}` },
    });
    expect(extractApiKey(req).apiKey).toBe(K);
  });
  test("missing both → null, no error", () => {
    expect(extractApiKey(new Request("http://x/"))).toEqual({
      apiKey: null,
      error: null,
    });
  });
  test("malformed X-API-Key → error", () => {
    const req = new Request("http://x/", { headers: { "X-API-Key": "nope" } });
    const r = extractApiKey(req);
    expect(r.apiKey).toBeNull();
    expect(r.error).toContain("Invalid API key");
  });
  test("malformed Bearer → error", () => {
    const req = new Request("http://x/", {
      headers: { Authorization: "Bearer nope" },
    });
    const r = extractApiKey(req);
    expect(r.apiKey).toBeNull();
    expect(r.error).toContain("Invalid API key");
  });
  test("lowercases incoming UUID", () => {
    const req = new Request("http://x/", {
      headers: { "X-API-Key": K.toUpperCase() },
    });
    expect(extractApiKey(req).apiKey).toBe(K);
  });
});

describe("extractAdminKey", () => {
  test("X-Admin-Key present", () => {
    const req = new Request("http://x/", { headers: { "X-Admin-Key": K } });
    expect(extractAdminKey(req)).toBe(K);
  });
  test("missing → null", () => {
    expect(extractAdminKey(new Request("http://x/"))).toBeNull();
  });
  test("lowercases", () => {
    const req = new Request("http://x/", {
      headers: { "X-Admin-Key": K.toUpperCase() },
    });
    expect(extractAdminKey(req)).toBe(K);
  });
});

describe("keyGate", () => {
  let dir: string;
  let db: Db;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "es-auth-"));
    db = new Db(join(dir, "t.sqlite"));
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  // protected mode
  test("protected: no key → 401", () => {
    const r = keyGate(db, true, null);
    expect(r).toEqual({
      ok: false,
      status: 401,
      error: expect.stringContaining("required"),
    });
  });
  test("protected: unknown key → 403 'Unknown API key'", () => {
    const r = keyGate(db, true, K);
    expect(r.ok).toBe(false);
    expect((r as any).status).toBe(403);
    expect((r as any).error).toContain("Unknown API key");
  });
  test("protected: inactive → 403 inactive", () => {
    db.insertApiKey(K, "inactive");
    expect(keyGate(db, true, K)).toEqual({
      ok: false,
      status: 403,
      error: expect.stringContaining("inactive"),
    });
  });
  test("protected: suspended → 403 suspended", () => {
    db.insertApiKey(K, "suspended");
    expect(keyGate(db, true, K)).toEqual({
      ok: false,
      status: 403,
      error: expect.stringContaining("suspended"),
    });
  });
  test("protected: active → ok", () => {
    db.insertApiKey(K, "active");
    expect(keyGate(db, true, K)).toEqual({ ok: true, apiKey: K });
  });

  // non-protected mode
  test("non-protected: no key → ok null (anonymous)", () => {
    expect(keyGate(db, false, null)).toEqual({ ok: true, apiKey: null });
  });
  test("non-protected: unknown key auto-registers as active, ok", () => {
    const r = keyGate(db, false, K);
    expect(r).toEqual({ ok: true, apiKey: K });
    expect(db.getApiKey(K)?.status).toBe("active");
  });
  test("non-protected: inactive → 403", () => {
    db.insertApiKey(K, "inactive");
    expect(keyGate(db, false, K)).toEqual({
      ok: false,
      status: 403,
      error: expect.stringContaining("inactive"),
    });
  });
  test("non-protected: suspended → 403", () => {
    db.insertApiKey(K, "suspended");
    expect(keyGate(db, false, K)).toEqual({
      ok: false,
      status: 403,
      error: expect.stringContaining("suspended"),
    });
  });
  test("non-protected: active → ok", () => {
    db.insertApiKey(K, "active");
    expect(keyGate(db, false, K)).toEqual({ ok: true, apiKey: K });
  });
});

describe("authorizeOwnerOrAdmin", () => {
  const ADMIN = "99999999-9999-4999-8999-999999999999";
  const cfg = { adminKey: ADMIN } as never;

  let dir: string;
  let db: Db;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "es-authz-"));
    db = new Db(join(dir, "t.sqlite"));
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function req(h: Record<string, string>) {
    return new Request("http://x", { headers: h });
  }

  test("no creds → unauthenticated", () => {
    expect(authorizeOwnerOrAdmin(req({}), db, { apiKey: null }, cfg)).toBe(
      "unauthenticated",
    );
  });

  test("valid admin → admin (even on anonymous file)", () => {
    expect(
      authorizeOwnerOrAdmin(
        req({ "x-admin-key": ADMIN }),
        db,
        { apiKey: null },
        cfg,
      ),
    ).toBe("admin");
  });

  test("wrong admin → unauthenticated", () => {
    expect(
      authorizeOwnerOrAdmin(
        req({ "x-admin-key": "11111111-1111-4111-8111-111111111111" }),
        db,
        { apiKey: null },
        cfg,
      ),
    ).toBe("unauthenticated");
  });

  test("owner with active key matching file → owner", () => {
    const K = "22222222-2222-4222-8222-222222222222";
    db.insertApiKey(K, "active");
    expect(
      authorizeOwnerOrAdmin(req({ "x-api-key": K }), db, { apiKey: K }, cfg),
    ).toBe("owner");
  });

  test("inactive key → forbidden", () => {
    const K = "33333333-3333-4333-8333-333333333333";
    db.insertApiKey(K, "inactive");
    expect(
      authorizeOwnerOrAdmin(req({ "x-api-key": K }), db, { apiKey: K }, cfg),
    ).toBe("forbidden");
  });

  test("suspended key → forbidden", () => {
    const K = "44444444-4444-4444-8444-444444444444";
    db.insertApiKey(K, "suspended");
    expect(
      authorizeOwnerOrAdmin(req({ "x-api-key": K }), db, { apiKey: K }, cfg),
    ).toBe("forbidden");
  });

  test("wrong owner → forbidden", () => {
    const A = "55555555-5555-4555-8555-555555555555";
    const B = "66666666-6666-4666-8666-666666666666";
    db.insertApiKey(A, "active");
    db.insertApiKey(B, "active");
    expect(
      authorizeOwnerOrAdmin(req({ "x-api-key": B }), db, { apiKey: A }, cfg),
    ).toBe("forbidden");
  });

  test("anonymous file with any api key → forbidden", () => {
    const K = "77777777-7777-4777-8777-777777777777";
    db.insertApiKey(K, "active");
    expect(
      authorizeOwnerOrAdmin(req({ "x-api-key": K }), db, { apiKey: null }, cfg),
    ).toBe("forbidden");
  });
});
