import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers";

const ADMIN = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const KEY_A = "11111111-2222-4333-8444-555555555555";
const KEY_B = "22222222-3333-4444-8555-666666666666";
const KEY_C = "33333333-4444-4555-8666-777777777777";

function admHeaders(key = ADMIN) {
  return { "X-Admin-Key": key, "Content-Type": "application/json" };
}

describe("admin disabled when ADMIN_KEY unset", () => {
  let ctx: TestServer;
  beforeAll(async () => {
    ctx = await startTestServer();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  test("any /admin/* returns 404", async () => {
    for (const [m, p] of [
      ["POST", "/admin/keys"],
      ["GET", "/admin/keys"],
      ["GET", `/admin/keys/${KEY_A}`],
      ["PATCH", `/admin/keys/${KEY_A}`],
      ["DELETE", `/admin/keys/${KEY_A}`],
      ["POST", `/admin/keys/${KEY_A}/rotate`],
    ] as const) {
      const r = await fetch(`${ctx.baseUrl}${p}`, {
        method: m,
        headers: { "X-Admin-Key": ADMIN },
      });
      expect(r.status).toBe(404);
      expect(((await r.json()) as { success: boolean }).success).toBe(false);
    }
  });
});

describe("admin endpoints (enabled)", () => {
  let ctx: TestServer;
  beforeAll(async () => {
    ctx = await startTestServer({ adminKey: ADMIN });
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  test("401 on missing/wrong X-Admin-Key", async () => {
    const r1 = await fetch(`${ctx.baseUrl}/admin/keys`);
    expect(r1.status).toBe(401);
    expect(((await r1.json()) as { success: boolean }).success).toBe(false);
    const r2 = await fetch(`${ctx.baseUrl}/admin/keys`, {
      headers: { "X-Admin-Key": KEY_A },
    });
    expect(r2.status).toBe(401);
    expect(((await r2.json()) as { success: boolean }).success).toBe(false);
  });

  test("POST /admin/keys without body → generates UUID, active", async () => {
    const r = await fetch(`${ctx.baseUrl}/admin/keys`, {
      method: "POST",
      headers: admHeaders(),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as {
      success: boolean;
      apiKey: string;
      status: string;
      createdAt: number;
    };
    expect(b.success).toBe(true);
    expect(b.apiKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.status).toBe("active");
    expect(b.createdAt).toEqual(expect.any(Number));
  });

  test("POST /admin/keys with apiKey + status", async () => {
    const r = await fetch(`${ctx.baseUrl}/admin/keys`, {
      method: "POST",
      headers: admHeaders(),
      body: JSON.stringify({ apiKey: KEY_A, status: "inactive" }),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as {
      success: boolean;
      apiKey: string;
      status: string;
    };
    expect(b.success).toBe(true);
    expect(b).toMatchObject({ apiKey: KEY_A, status: "inactive" });
  });

  test("POST /admin/keys 400 on bad UUID", async () => {
    const r = await fetch(`${ctx.baseUrl}/admin/keys`, {
      method: "POST",
      headers: admHeaders(),
      body: JSON.stringify({ apiKey: "nope" }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });

  test("POST /admin/keys 400 on bad status", async () => {
    const r = await fetch(`${ctx.baseUrl}/admin/keys`, {
      method: "POST",
      headers: admHeaders(),
      body: JSON.stringify({ status: "banned" }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });

  test("POST /admin/keys 409 on duplicate apiKey", async () => {
    const r = await fetch(`${ctx.baseUrl}/admin/keys`, {
      method: "POST",
      headers: admHeaders(),
      body: JSON.stringify({ apiKey: KEY_A }),
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });

  test("GET /admin/keys lists all with stats", async () => {
    ctx.db.insertApiKey(KEY_B, "active");
    const fd = new FormData();
    fd.append("file", new File(["x"], "a.txt", { type: "text/plain" }));
    const up = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": KEY_B },
      body: fd,
    });
    expect(up.status).toBe(200);
    const r = await fetch(`${ctx.baseUrl}/admin/keys`, {
      headers: admHeaders(),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      success: boolean;
      keys: Array<{
        apiKey: string;
        status: string;
        fileCount: number;
        versionCount: number;
      }>;
    };
    expect(body.success).toBe(true);
    const row = body.keys.find((x) => x.apiKey === KEY_B)!;
    expect(row.status).toBe("active");
    expect(row.fileCount).toBe(1);
    expect(row.versionCount).toBe(1);
  });

  test("GET /admin/keys/:key returns one with stats", async () => {
    const r = await fetch(`${ctx.baseUrl}/admin/keys/${KEY_B}`, {
      headers: admHeaders(),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { success: boolean; apiKey: string };
    expect(b.success).toBe(true);
    expect(b.apiKey).toBe(KEY_B);
  });

  test("GET /admin/keys/:key 404 when missing", async () => {
    const r = await fetch(
      `${ctx.baseUrl}/admin/keys/dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb`,
      { headers: admHeaders() },
    );
    expect(r.status).toBe(404);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });

  test("GET /admin/keys/:key 400 on bad UUID", async () => {
    const r = await fetch(`${ctx.baseUrl}/admin/keys/not-a-uuid`, {
      headers: admHeaders(),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });

  test("PATCH /admin/keys/:key changes status", async () => {
    const r = await fetch(`${ctx.baseUrl}/admin/keys/${KEY_B}`, {
      method: "PATCH",
      headers: admHeaders(),
      body: JSON.stringify({ status: "suspended" }),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { success: boolean; status: string };
    expect(b.success).toBe(true);
    expect(b.status).toBe("suspended");
    expect(ctx.db.getApiKey(KEY_B)?.status).toBe("suspended");
  });

  test("PATCH 400 bad status", async () => {
    const r = await fetch(`${ctx.baseUrl}/admin/keys/${KEY_B}`, {
      method: "PATCH",
      headers: admHeaders(),
      body: JSON.stringify({ status: "deleted" }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });

  test("PATCH 404 on missing key", async () => {
    const r = await fetch(
      `${ctx.baseUrl}/admin/keys/dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb`,
      {
        method: "PATCH",
        headers: admHeaders(),
        body: JSON.stringify({ status: "active" }),
      },
    );
    expect(r.status).toBe(404);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });

  test("DELETE /admin/keys/:key 200 {success:true} when no files", async () => {
    ctx.db.insertApiKey(KEY_C, "active");
    const r = await fetch(`${ctx.baseUrl}/admin/keys/${KEY_C}`, {
      method: "DELETE",
      headers: admHeaders(),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true });
    expect(ctx.db.getApiKey(KEY_C)).toBeNull();
  });

  test("DELETE 409 when files reference key", async () => {
    const r = await fetch(`${ctx.baseUrl}/admin/keys/${KEY_B}`, {
      method: "DELETE",
      headers: admHeaders(),
    });
    expect(r.status).toBe(409);
    const b = (await r.json()) as { success: boolean; error: string };
    expect(b.success).toBe(false);
    expect(b.error).toContain("file");
  });

  test("DELETE 404 on unknown key", async () => {
    const r = await fetch(
      `${ctx.baseUrl}/admin/keys/dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb`,
      {
        method: "DELETE",
        headers: admHeaders(),
      },
    );
    expect(r.status).toBe(404);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });

  test("POST /rotate transfers ownership, invalidates old", async () => {
    const NEW = "55555555-6666-4777-8888-999999999999";
    const r = await fetch(`${ctx.baseUrl}/admin/keys/${KEY_B}/rotate`, {
      method: "POST",
      headers: admHeaders(),
      body: JSON.stringify({ newKey: NEW }),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as {
      success: boolean;
      oldKey: string;
      newKey: string;
      filesTransferred: number;
    };
    expect(b.success).toBe(true);
    expect(b).toMatchObject({ oldKey: KEY_B, newKey: NEW });
    expect(b.filesTransferred).toBe(1);
    expect(ctx.db.getApiKey(KEY_B)).toBeNull();
    expect(ctx.db.getApiKey(NEW)?.status).toBe("active");
  });

  test("POST /rotate 404 when old not found", async () => {
    const r = await fetch(
      `${ctx.baseUrl}/admin/keys/dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb/rotate`,
      {
        method: "POST",
        headers: admHeaders(),
      },
    );
    expect(r.status).toBe(404);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });

  test("POST /rotate 409 when new key exists", async () => {
    const EXISTING = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    ctx.db.insertApiKey(EXISTING, "active");
    ctx.db.insertApiKey("77777777-8888-4999-8aaa-bbbbbbbbbbbb", "active");
    const r = await fetch(
      `${ctx.baseUrl}/admin/keys/77777777-8888-4999-8aaa-bbbbbbbbbbbb/rotate`,
      {
        method: "POST",
        headers: admHeaders(),
        body: JSON.stringify({ newKey: EXISTING }),
      },
    );
    expect(r.status).toBe(409);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });

  test("POST /rotate without newKey → generates one", async () => {
    const OLD = "88888888-9999-4aaa-8bbb-cccccccccccc";
    ctx.db.insertApiKey(OLD, "active");
    const r = await fetch(`${ctx.baseUrl}/admin/keys/${OLD}/rotate`, {
      method: "POST",
      headers: admHeaders(),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { success: boolean; newKey: string };
    expect(b.success).toBe(true);
    expect(b.newKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.newKey).not.toBe(OLD);
  });
});
