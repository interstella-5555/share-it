import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers";

const KEY = "11111111-2222-4333-8444-555555555555";

interface UploadOk {
  success: boolean;
  id: string;
  url: string;
  version: number;
}

interface ErrorBody {
  success: boolean;
  error: string;
}

let ctx: TestServer;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  await ctx.cleanup();
});

async function upload(
  content: string | Uint8Array,
  name: string,
  mime: string,
  opts: { apiKey?: string; id?: string } = {},
): Promise<UploadOk> {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type: mime }));
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers["X-API-Key"] = opts.apiKey;
  const url = opts.id
    ? `${ctx.baseUrl}/share?id=${opts.id}`
    : `${ctx.baseUrl}/share`;
  const r = await fetch(url, { method: "POST", headers, body: fd });
  if (r.status !== 200)
    throw new Error(`upload ${r.status}: ${await r.text()}`);
  return r.json() as Promise<UploadOk>;
}

describe("GET /share/:id (latest)", () => {
  test("anonymous: served + content-type + etag", async () => {
    const { id } = await upload("<h1>hi</h1>", "p.html", "text/html");
    const r = await fetch(`${ctx.baseUrl}/share/${id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("etag")).toMatch(/^".{64}"$/);
    expect(await r.text()).toBe("<h1>hi</h1>");
  });

  test("owned: latest updated", async () => {
    const { id } = await upload("v1", "a.txt", "text/plain", { apiKey: KEY });
    await upload("v2", "a.txt", "text/plain", { apiKey: KEY, id });
    const r = await fetch(`${ctx.baseUrl}/share/${id}`);
    expect(await r.text()).toBe("v2");
  });

  test("404 when unknown id", async () => {
    const r = await fetch(
      `${ctx.baseUrl}/share/deadbeef-0000-4000-8000-000000000000`,
    );
    expect(r.status).toBe(404);
    const b = (await r.json()) as ErrorBody;
    expect(b.success).toBe(false);
    expect(b.error).toContain("not found");
  });

  test("400 on invalid UUID", async () => {
    const r = await fetch(`${ctx.baseUrl}/share/nope`);
    expect(r.status).toBe(400);
    expect(((await r.json()) as ErrorBody).success).toBe(false);
  });
});

describe("GET /share/:id/:version", () => {
  test("serves specific version", async () => {
    const { id } = await upload("v1", "a.txt", "text/plain", { apiKey: KEY });
    await upload("v2", "a.txt", "text/plain", { apiKey: KEY, id });
    const r = await fetch(`${ctx.baseUrl}/share/${id}/1`);
    expect(await r.text()).toBe("v1");
  });
  test("404 with 'Latest version' hint", async () => {
    const { id } = await upload("v1", "a.txt", "text/plain", { apiKey: KEY });
    await upload("v2", "a.txt", "text/plain", { apiKey: KEY, id });
    const r = await fetch(`${ctx.baseUrl}/share/${id}/99`);
    expect(r.status).toBe(404);
    const b = (await r.json()) as ErrorBody;
    expect(b.success).toBe(false);
    expect(b.error).toContain("Version 99");
    expect(b.error).toContain("Latest version: 2");
  });
  test("400 non-integer version", async () => {
    const { id } = await upload("x", "a.txt", "text/plain");
    const r = await fetch(`${ctx.baseUrl}/share/${id}/abc`);
    expect(r.status).toBe(400);
    expect(((await r.json()) as ErrorBody).success).toBe(false);
  });
});

describe("Cache-Control matrix", () => {
  test("anon latest → immutable", async () => {
    const { id } = await upload("x", "a.txt", "text/plain");
    const r = await fetch(`${ctx.baseUrl}/share/${id}`);
    expect(r.headers.get("cache-control")).toContain("immutable");
  });
  test("anon versioned → immutable", async () => {
    const { id, version } = await upload("x", "a.txt", "text/plain");
    const r = await fetch(`${ctx.baseUrl}/share/${id}/${version}`);
    expect(r.headers.get("cache-control")).toContain("immutable");
  });
  test("owned latest → no-cache", async () => {
    const { id } = await upload("x", "a.txt", "text/plain", { apiKey: KEY });
    const r = await fetch(`${ctx.baseUrl}/share/${id}`);
    expect(r.headers.get("cache-control")).toBe("public, no-cache");
  });
  test("owned versioned → no-cache (suspension can flip 200→404)", async () => {
    const { id, version } = await upload("x", "a.txt", "text/plain", {
      apiKey: KEY,
    });
    const r = await fetch(`${ctx.baseUrl}/share/${id}/${version}`);
    expect(r.headers.get("cache-control")).toBe("public, no-cache");
  });
});

describe("Conditional GET", () => {
  test("304 when ETag matches", async () => {
    const { id } = await upload("x", "a.txt", "text/plain");
    const first = await fetch(`${ctx.baseUrl}/share/${id}`);
    const etag = first.headers.get("etag")!;
    const r = await fetch(`${ctx.baseUrl}/share/${id}`, {
      headers: { "If-None-Match": etag },
    });
    expect(r.status).toBe(304);
  });
  test("200 when ETag differs", async () => {
    const { id } = await upload("x", "a.txt", "text/plain");
    const r = await fetch(`${ctx.baseUrl}/share/${id}`, {
      headers: { "If-None-Match": '"zzz"' },
    });
    expect(r.status).toBe(200);
  });
});

describe("?download", () => {
  test("no query → inline (no CD)", async () => {
    const { id } = await upload("x", "n.md", "text/markdown");
    const r = await fetch(`${ctx.baseUrl}/share/${id}`);
    expect(r.headers.get("content-disposition")).toBeNull();
  });
  test("empty ?download → attachment", async () => {
    const { id } = await upload("x", "my.md", "text/markdown");
    const r = await fetch(`${ctx.baseUrl}/share/${id}?download`);
    const cd = r.headers.get("content-disposition")!;
    expect(cd).toContain("attachment");
    expect(cd).toContain('filename="my.md"');
    expect(cd).toContain("filename*=UTF-8''my.md");
  });
  test("?download=anything still triggers", async () => {
    const { id } = await upload("x", "r.txt", "text/plain");
    const r = await fetch(`${ctx.baseUrl}/share/${id}?download=true`);
    expect(r.headers.get("content-disposition")).toContain("attachment");
  });
  test("non-ASCII → RFC 5987", async () => {
    const { id } = await upload("x", "żółć.md", "text/markdown");
    const r = await fetch(`${ctx.baseUrl}/share/${id}?download`);
    const cd = r.headers.get("content-disposition")!;
    expect(cd).toMatch(/filename="____\.md"/);
    expect(cd).toContain("filename*=UTF-8''%C5%BC%C3%B3%C5%82%C4%87.md");
  });
});

describe("suspended key hides files", () => {
  test("suspend owner → GET returns 404", async () => {
    const { id } = await upload("x", "a.txt", "text/plain", { apiKey: KEY });
    ctx.db.updateApiKeyStatus(KEY, "suspended");
    const r = await fetch(`${ctx.baseUrl}/share/${id}`);
    expect(r.status).toBe(404);
    const b = (await r.json()) as ErrorBody;
    expect(b.success).toBe(false);
    expect(b.error).toContain("not found");
  });
  test("inactive owner → GET still works", async () => {
    const SECOND = "22222222-3333-4444-8555-666666666666";
    const { id } = await upload("y", "a.txt", "text/plain", { apiKey: SECOND });
    ctx.db.updateApiKeyStatus(SECOND, "inactive");
    const r = await fetch(`${ctx.baseUrl}/share/${id}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("y");
  });
});
