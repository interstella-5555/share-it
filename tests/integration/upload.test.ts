import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers";

const KEY_A = "11111111-2222-4333-8444-555555555555";
const KEY_B = "22222222-3333-4444-8555-666666666666";
const ADMIN = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const VALID_ID = "a1b2c3d4-5678-4abc-9def-000000000000";

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

function formFile(content: string | Uint8Array, name: string, mime: string) {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type: mime }));
  return fd;
}

describe("non-protected mode (default in tests)", () => {
  let ctx: TestServer;
  beforeAll(async () => {
    ctx = await startTestServer();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  test("anonymous upload → 200, version 1", async () => {
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      body: formFile("<h1>hi</h1>", "p.html", "text/html"),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as UploadOk;
    expect(b.success).toBe(true);
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.url).toBe(`${ctx.baseUrl}/share/${b.id}`);
    expect(b.version).toBe(1);
    expect(ctx.db.getFile(b.id)?.apiKey).toBeNull();
  });

  test("upload with unknown key auto-registers it as active", async () => {
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": KEY_A },
      body: formFile("hi", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as UploadOk).success).toBe(true);
    expect(ctx.db.getApiKey(KEY_A)?.status).toBe("active");
  });

  test("multiple file types accepted + jpeg→jpg normalization", async () => {
    const cases: [string, string, string | Uint8Array][] = [
      ["a.md", "text/markdown", "# h"],
      ["a.json", "application/json", '{"x":1}'],
      ["a.jpeg", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff])],
    ];
    for (const [n, m, c] of cases) {
      const r = await fetch(`${ctx.baseUrl}/share`, {
        method: "POST",
        body: formFile(c, n, m),
      });
      expect(r.status).toBe(200);
    }
    const keys = Object.values(ctx.db.listApiKeys());
    const lastAnon = ctx.db.getFile(
      (
        (await (
          await fetch(`${ctx.baseUrl}/share`, {
            method: "POST",
            body: formFile(
              new Uint8Array([0xff, 0xd8, 0xff]),
              "p.jpeg",
              "image/jpeg",
            ),
          })
        ).json()) as UploadOk
      ).id,
    )!;
    expect(ctx.db.getLatestVersion(lastAnon.id)?.ext).toBe("jpg");
  });

  test("?id=<uuid> with caller-chosen id", async () => {
    const r = await fetch(`${ctx.baseUrl}/share?id=${VALID_ID}`, {
      method: "POST",
      body: formFile("hi", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(200);
    const b = (await r.json()) as UploadOk;
    expect(b.success).toBe(true);
    expect(b.id).toBe(VALID_ID);
  });

  test("400 on invalid UUID in ?id", async () => {
    const r = await fetch(`${ctx.baseUrl}/share?id=nope`, {
      method: "POST",
      body: formFile("x", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as ErrorBody).success).toBe(false);
  });

  test("X-API-Key wins over Bearer", async () => {
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": KEY_B, Authorization: `Bearer ${KEY_A}` },
      body: formFile("x", "a.txt", "text/plain"),
    });
    const b = (await r.json()) as UploadOk;
    expect(b.success).toBe(true);
    expect(ctx.db.getFile(b.id)?.apiKey).toBe(KEY_B);
  });

  test("400 on malformed API key", async () => {
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": "bogus" },
      body: formFile("x", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as ErrorBody).success).toBe(false);
  });

  test("update existing (with api key) → v2", async () => {
    const first = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": KEY_A },
      body: formFile("v1", "a.txt", "text/plain"),
    });
    const { id } = (await first.json()) as UploadOk;
    const second = await fetch(`${ctx.baseUrl}/share?id=${id}`, {
      method: "POST",
      headers: { "X-API-Key": KEY_A },
      body: formFile("v2 content", "a.txt", "text/plain"),
    });
    expect(second.status).toBe(200);
    const b = (await second.json()) as UploadOk;
    expect(b.success).toBe(true);
    expect(b.version).toBe(2);
  });

  test("dedup: same bytes → same version, no new row", async () => {
    const first = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": KEY_A },
      body: formFile("identical", "a.txt", "text/plain"),
    });
    const fb = (await first.json()) as UploadOk;
    const second = await fetch(`${ctx.baseUrl}/share?id=${fb.id}`, {
      method: "POST",
      headers: { "X-API-Key": KEY_A },
      body: formFile("identical", "a.txt", "text/plain"),
    });
    const sb = (await second.json()) as UploadOk;
    expect(sb.success).toBe(true);
    expect(sb.version).toBe(fb.version);
    expect(ctx.db.maxVersion(fb.id)).toBe(fb.version);
  });

  test("403 when anonymous file update attempted", async () => {
    const first = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      body: formFile("v1", "a.txt", "text/plain"),
    });
    const { id } = (await first.json()) as UploadOk;
    const r = await fetch(`${ctx.baseUrl}/share?id=${id}`, {
      method: "POST",
      headers: { "X-API-Key": KEY_A },
      body: formFile("v2", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(403);
    const b = (await r.json()) as ErrorBody;
    expect(b.success).toBe(false);
    expect(b.error).toContain("immutable");
  });

  test("403 when key mismatch", async () => {
    const first = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": KEY_A },
      body: formFile("v1", "a.txt", "text/plain"),
    });
    const { id } = (await first.json()) as UploadOk;
    const r = await fetch(`${ctx.baseUrl}/share?id=${id}`, {
      method: "POST",
      headers: { "X-API-Key": KEY_B },
      body: formFile("v2", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as ErrorBody).success).toBe(false);
  });

  test("400 missing file field", async () => {
    const fd = new FormData();
    fd.append("other", "x");
    const r = await fetch(`${ctx.baseUrl}/share`, { method: "POST", body: fd });
    expect(r.status).toBe(400);
    const b = (await r.json()) as ErrorBody;
    expect(b.success).toBe(false);
    expect(b.error).toContain("Missing 'file'");
  });

  test("415 unsupported ext", async () => {
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      body: formFile("x", "b.exe", "application/octet-stream"),
    });
    expect(r.status).toBe(415);
    expect(((await r.json()) as ErrorBody).success).toBe(false);
  });

  test("415 MIME vs ext mismatch", async () => {
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      body: formFile("<h1>x</h1>", "p.html", "image/png"),
    });
    expect(r.status).toBe(415);
    expect(((await r.json()) as ErrorBody).success).toBe(false);
  });

  test("413 oversize", async () => {
    const small = await startTestServer({ maxFileSizeBytes: 5 });
    try {
      const r = await fetch(`${small.baseUrl}/share`, {
        method: "POST",
        body: formFile("012345", "a.txt", "text/plain"),
      });
      expect(r.status).toBe(413);
      expect(((await r.json()) as ErrorBody).success).toBe(false);
    } finally {
      await small.cleanup();
    }
  });

  test("inactive key → 403 (even in non-protected mode)", async () => {
    ctx.db.insertApiKey("33333333-4444-4555-8666-777777777777", "inactive");
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": "33333333-4444-4555-8666-777777777777" },
      body: formFile("x", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(403);
    const b = (await r.json()) as ErrorBody;
    expect(b.success).toBe(false);
    expect(b.error).toContain("inactive");
  });
});

describe("protected mode", () => {
  let ctx: TestServer;
  beforeAll(async () => {
    ctx = await startTestServer({ protectedMode: true, adminKey: ADMIN });
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  test("401 when no api key", async () => {
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      body: formFile("x", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(401);
    const b = (await r.json()) as ErrorBody;
    expect(b.success).toBe(false);
    expect(b.error).toContain("required");
  });

  test("403 unknown key", async () => {
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": KEY_A },
      body: formFile("x", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(403);
    const b = (await r.json()) as ErrorBody;
    expect(b.success).toBe(false);
    expect(b.error).toContain("Unknown API key");
  });

  test("active registered key → 200", async () => {
    ctx.db.insertApiKey(KEY_B, "active");
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": KEY_B },
      body: formFile("x", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as UploadOk).success).toBe(true);
  });

  test("suspended key → 403", async () => {
    const K = "44444444-5555-4666-8777-888888888888";
    ctx.db.insertApiKey(K, "suspended");
    const r = await fetch(`${ctx.baseUrl}/share`, {
      method: "POST",
      headers: { "X-API-Key": K },
      body: formFile("x", "a.txt", "text/plain"),
    });
    expect(r.status).toBe(403);
    const b = (await r.json()) as ErrorBody;
    expect(b.success).toBe(false);
    expect(b.error).toContain("suspended");
  });
});
