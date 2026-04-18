import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers";

interface UploadOk {
  success: boolean;
  id: string;
  url: string;
  version: number;
}

let ctx: TestServer;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  await ctx.cleanup();
});

async function upload(
  content: string,
  name: string,
  mime: string,
): Promise<UploadOk> {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type: mime }));
  const r = await fetch(`${ctx.baseUrl}/share`, { method: "POST", body: fd });
  if (r.status !== 200)
    throw new Error(`upload ${r.status}: ${await r.text()}`);
  return r.json() as Promise<UploadOk>;
}

// Flush microtask queue so our queueMicrotask side effects complete
// before we assert.
async function flush(): Promise<void> {
  await new Promise((r) => queueMicrotask(() => r(null)));
}

describe("GET /share records a view (200)", () => {
  test("single fetch increments viewCounters", async () => {
    const { id } = await upload("hello", "a.txt", "text/plain");
    const r = await fetch(`${ctx.baseUrl}/share/${id}`, {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(r.status).toBe(200);
    await r.text();
    await flush();

    const a = ctx.db.getFileAnalytics(id);
    expect(a.totals.views).toBe(1);
    expect(a.totals.uniqueDaily).toBe(1);
  });
});

describe("GET /share records a view (304)", () => {
  test("If-None-Match match returns 304 and still increments view count", async () => {
    const { id } = await upload("hi", "b.txt", "text/plain");

    const r1 = await fetch(`${ctx.baseUrl}/share/${id}`, {
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    expect(r1.status).toBe(200);
    const etag = r1.headers.get("etag");
    if (etag === null) throw new Error("missing ETag");
    await r1.text();
    await flush();
    const before = ctx.db.getFileAnalytics(id).totals.views;

    const r2 = await fetch(`${ctx.baseUrl}/share/${id}`, {
      headers: {
        "x-forwarded-for": "198.51.100.2",
        "if-none-match": etag,
      },
    });
    expect(r2.status).toBe(304);
    await flush();

    const after = ctx.db.getFileAnalytics(id);
    expect(after.totals.views).toBe(before + 1);
    expect(after.totals.uniqueDaily).toBe(2);
  });
});

describe("GET /share does NOT record failed responses", () => {
  test("404 on non-existent version leaves counters untouched", async () => {
    const { id } = await upload("x", "c.txt", "text/plain");
    const r1 = await fetch(`${ctx.baseUrl}/share/${id}`, {
      headers: { "x-forwarded-for": "203.0.113.77" },
    });
    await r1.text();
    await flush();
    const before = ctx.db.getFileAnalytics(id);

    const r404 = await fetch(`${ctx.baseUrl}/share/${id}/99`, {
      headers: { "x-forwarded-for": "203.0.113.77" },
    });
    expect(r404.status).toBe(404);
    await flush();

    const after = ctx.db.getFileAnalytics(id);
    expect(after.totals.views).toBe(before.totals.views);
    expect(after.totals.uniqueDaily).toBe(before.totals.uniqueDaily);
  });
});

describe("DELETE /share cleans up analytics", () => {
  test("deleting a single version wipes that version's analytics", async () => {
    const key = crypto.randomUUID();
    const fd1 = new FormData();
    fd1.append("file", new File(["v1"], "d.txt", { type: "text/plain" }));
    const up1 = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "x-api-key": key },
      body: fd1,
    });
    expect(up1.status).toBe(200);
    const { id } = (await up1.json()) as { id: string };

    await (
      await fetch(`${ctx.baseUrl}/share/${id}`, {
        headers: { "x-forwarded-for": "203.0.113.50" },
      })
    ).text();

    const fd2 = new FormData();
    fd2.append("file", new File(["v2"], "d.txt", { type: "text/plain" }));
    const up2 = await fetch(`${ctx.baseUrl}/share?id=${id}`, {
      method: "POST",
      headers: { "x-api-key": key },
      body: fd2,
    });
    expect(up2.status).toBe(200);
    await (
      await fetch(`${ctx.baseUrl}/share/${id}`, {
        headers: { "x-forwarded-for": "203.0.113.51" },
      })
    ).text();
    await flush();

    const pre = ctx.db.getFileAnalytics(id);
    expect(pre.perVersion.map((v) => v.version).sort()).toEqual([1, 2]);

    const del = await fetch(`${ctx.baseUrl}/share/${id}/1`, {
      method: "DELETE",
      headers: { "x-api-key": key },
    });
    expect(del.status).toBe(200);

    const post = ctx.db.getFileAnalytics(id);
    expect(post.perVersion.map((v) => v.version)).toEqual([2]);
  });

  test("deleting whole file wipes all analytics for that fileId", async () => {
    const key = crypto.randomUUID();
    const fd = new FormData();
    fd.append("file", new File(["x"], "e.txt", { type: "text/plain" }));
    const up = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "x-api-key": key },
      body: fd,
    });
    expect(up.status).toBe(200);
    const { id } = (await up.json()) as { id: string };

    await (
      await fetch(`${ctx.baseUrl}/share/${id}`, {
        headers: { "x-forwarded-for": "203.0.113.90" },
      })
    ).text();
    await flush();
    expect(ctx.db.getFileAnalytics(id).totals.views).toBe(1);

    const del = await fetch(`${ctx.baseUrl}/share/${id}`, {
      method: "DELETE",
      headers: { "x-api-key": key },
    });
    expect(del.status).toBe(200);

    const post = ctx.db.getFileAnalytics(id);
    expect(post).toEqual({
      totals: { views: 0, uniqueDaily: 0 },
      perDay: [],
      perVersion: [],
    });
  });
});

interface AnalyticsOk {
  success: boolean;
  fileId: string;
  shortId: string;
  totals: { views: number; uniqueDaily: number };
  perDay: { day: string; views: number; uniqueDaily: number }[];
  perVersion: { version: number; views: number; uniqueDaily: number }[];
}

describe("GET /files/:id/analytics — auth gate skeleton", () => {
  test("without any auth header returns 401", async () => {
    const { id } = await upload("f", "g.txt", "text/plain");
    const r = await fetch(`${ctx.baseUrl}/files/${id}/analytics`);
    expect(r.status).toBe(401);
    const body = (await r.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });
});

describe("GET /files/:id/analytics — auth matrix", () => {
  const ADMIN = "aaaa1111-2222-4333-8444-555555555555";
  const KEY_A = "bbbb1111-2222-4333-8444-555555555555";
  const KEY_B = "cccc1111-2222-4333-8444-555555555555";

  let ctx2: TestServer;
  beforeAll(async () => {
    ctx2 = await startTestServer({ protectedMode: true, adminKey: ADMIN });
    ctx2.db.insertApiKey(KEY_A, "active");
    ctx2.db.insertApiKey(KEY_B, "active");
  });
  afterAll(async () => {
    await ctx2.cleanup();
  });

  async function uploadAs(apiKey: string): Promise<string> {
    const fd = new FormData();
    fd.append("file", new File(["payload"], "a.txt", { type: "text/plain" }));
    const r = await fetch(`${ctx2.baseUrl}/share`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
      body: fd,
    });
    if (r.status !== 200)
      throw new Error(`upload ${r.status}: ${await r.text()}`);
    const body = (await r.json()) as { id: string };
    return body.id;
  }

  test("no auth header → 401", async () => {
    const id = await uploadAs(KEY_A);
    const r = await fetch(`${ctx2.baseUrl}/files/${id}/analytics`);
    expect(r.status).toBe(401);
  });

  test("stranger's key → 403", async () => {
    const id = await uploadAs(KEY_A);
    const r = await fetch(`${ctx2.baseUrl}/files/${id}/analytics`, {
      headers: { "x-api-key": KEY_B },
    });
    expect(r.status).toBe(403);
  });

  test("owner's key → 200 with correct shape", async () => {
    const id = await uploadAs(KEY_A);
    const r = await fetch(`${ctx2.baseUrl}/files/${id}/analytics`, {
      headers: { "x-api-key": KEY_A },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as AnalyticsOk;
    expect(body.success).toBe(true);
    expect(body.fileId).toBe(id);
    expect(body.totals).toEqual({ views: 0, uniqueDaily: 0 });
    expect(body.perDay).toEqual([]);
    expect(body.perVersion).toEqual([]);
  });

  test("admin key on someone else's file → 200", async () => {
    const id = await uploadAs(KEY_A);
    const r = await fetch(`${ctx2.baseUrl}/files/${id}/analytics`, {
      headers: { "x-admin-key": ADMIN },
    });
    expect(r.status).toBe(200);
  });

  test("admin key sees anonymous file's analytics (non-protected server)", async () => {
    const ctxA = await startTestServer({
      protectedMode: false,
      adminKey: ADMIN,
    });
    const fd = new FormData();
    fd.append("file", new File(["z"], "z.txt", { type: "text/plain" }));
    const up = await fetch(`${ctxA.baseUrl}/share`, {
      method: "POST",
      body: fd,
    });
    const { id } = (await up.json()) as { id: string };

    const r = await fetch(`${ctxA.baseUrl}/files/${id}/analytics`, {
      headers: { "x-admin-key": ADMIN },
    });
    expect(r.status).toBe(200);

    await ctxA.cleanup();
  });

  test("suspended owner key → 403", async () => {
    const id = await uploadAs(KEY_A);
    ctx2.db.updateApiKeyStatus(KEY_A, "suspended");
    const r = await fetch(`${ctx2.baseUrl}/files/${id}/analytics`, {
      headers: { "x-api-key": KEY_A },
    });
    expect(r.status).toBe(403);
    ctx2.db.updateApiKeyStatus(KEY_A, "active");
  });

  test("invalid id → 400", async () => {
    const r = await fetch(`${ctx2.baseUrl}/files/!!!/analytics`, {
      headers: { "x-api-key": KEY_A },
    });
    expect(r.status).toBe(400);
  });

  test("unknown id (correctly formatted) → 404", async () => {
    const unknown = "deadbeef-dead-4bad-8bad-deadbeefdead";
    const r = await fetch(`${ctx2.baseUrl}/files/${unknown}/analytics`, {
      headers: { "x-api-key": KEY_A },
    });
    expect(r.status).toBe(404);
  });
});

describe("GET /files/:id/analytics — aggregate shape", () => {
  const ADMIN = "dddd1111-2222-4333-8444-555555555555";
  const KEY = "eeee1111-2222-4333-8444-555555555555";
  let ctx3: TestServer;
  beforeAll(async () => {
    ctx3 = await startTestServer({ protectedMode: true, adminKey: ADMIN });
    ctx3.db.insertApiKey(KEY, "active");
  });
  afterAll(async () => {
    await ctx3.cleanup();
  });

  test("3 unique IPs on v1 + v2 returns correct breakdown", async () => {
    const fd1 = new FormData();
    fd1.append("file", new File(["v1"], "m.txt", { type: "text/plain" }));
    const up1 = await fetch(`${ctx3.baseUrl}/share`, {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: fd1,
    });
    const { id } = (await up1.json()) as { id: string };

    const fd2 = new FormData();
    fd2.append("file", new File(["v2"], "m.txt", { type: "text/plain" }));
    const up2 = await fetch(`${ctx3.baseUrl}/share?id=${id}`, {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: fd2,
    });
    expect(up2.status).toBe(200);

    await (
      await fetch(`${ctx3.baseUrl}/share/${id}/1`, {
        headers: { "x-forwarded-for": "10.0.0.1" },
      })
    ).text();
    await (
      await fetch(`${ctx3.baseUrl}/share/${id}/1`, {
        headers: { "x-forwarded-for": "10.0.0.2" },
      })
    ).text();
    await (
      await fetch(`${ctx3.baseUrl}/share/${id}/2`, {
        headers: { "x-forwarded-for": "10.0.0.1" },
      })
    ).text();
    await (
      await fetch(`${ctx3.baseUrl}/share/${id}/2`, {
        headers: { "x-forwarded-for": "10.0.0.3" },
      })
    ).text();
    await (
      await fetch(`${ctx3.baseUrl}/share/${id}/2`, {
        headers: { "x-forwarded-for": "10.0.0.3" },
      })
    ).text();
    await flush();

    const r = await fetch(`${ctx3.baseUrl}/files/${id}/analytics`, {
      headers: { "x-api-key": KEY },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as AnalyticsOk;

    expect(body.totals.views).toBe(5);
    expect(body.totals.uniqueDaily).toBe(3);

    const v1 = body.perVersion.find((v) => v.version === 1)!;
    const v2 = body.perVersion.find((v) => v.version === 2)!;
    expect(v1.views).toBe(2);
    expect(v1.uniqueDaily).toBe(2);
    expect(v2.views).toBe(3);
    expect(v2.uniqueDaily).toBe(2);

    expect(body.perDay.length).toBe(1);
    expect(body.perDay[0]!.views).toBe(5);
    expect(body.perDay[0]!.uniqueDaily).toBe(3);
  });
});

describe("analytics salt persistence", () => {
  test("salt file survives server restart; same IP + day → same hash", async () => {
    const ctxS1 = await startTestServer();
    const fd = new FormData();
    fd.append("file", new File(["hi"], "s.txt", { type: "text/plain" }));
    const up = await fetch(`${ctxS1.baseUrl}/share`, {
      method: "POST",
      body: fd,
    });
    const { id } = (await up.json()) as { id: string };
    await (
      await fetch(`${ctxS1.baseUrl}/share/${id}`, {
        headers: { "x-forwarded-for": "192.0.2.77" },
      })
    ).text();
    await flush();

    const preViews = ctxS1.db.getFileAnalytics(id).totals.views;
    expect(preViews).toBe(1);

    ctxS1.server.stop(true);
    ctxS1.db.close();

    const { Db } = await import("../../src/db");
    const { createServer } = await import("../../src/server");
    const db2 = new Db(ctxS1.config.dbPath);
    const server2 = createServer(ctxS1.config, db2);
    const baseUrl2 = `http://localhost:${server2.port}`;

    await (
      await fetch(`${baseUrl2}/share/${id}`, {
        headers: { "x-forwarded-for": "192.0.2.77" },
      })
    ).text();
    await new Promise((r) => queueMicrotask(() => r(null)));

    const a = db2.getFileAnalytics(id);
    expect(a.totals.views).toBe(2);
    expect(a.totals.uniqueDaily).toBe(1);

    server2.stop(true);
    db2.close();
    const { rm } = await import("node:fs/promises");
    await rm(ctxS1.tmpDir, { recursive: true, force: true });
  });
});
