import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { shortIdFromUuid } from "../../src/shortid";
import { startTestServer, type TestServer } from "./helpers";

const KEY = "11111111-2222-4333-8444-555555555555";
const OTHER_KEY = "22222222-3333-4444-8555-666666666666";

interface UploadOk {
  success: boolean;
  id: string;
  shortId: string;
  url: string;
  shortUrl: string;
  version: number;
}
interface ErrorBody {
  success: boolean;
  error: string;
}
interface ListRow {
  id: string;
  shortId: string;
  originalName: string;
  latestVersion: number;
  size: number;
  lastUploadAt: number;
}
interface ListResponse {
  success: boolean;
  files: ListRow[];
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
): Promise<{ status: number; body: UploadOk | ErrorBody }> {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type: mime }));
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers["X-API-Key"] = opts.apiKey;
  const url = opts.id
    ? `${ctx.baseUrl}/share?id=${opts.id}`
    : `${ctx.baseUrl}/share`;
  const r = await fetch(url, { method: "POST", headers, body: fd });
  const body = (await r.json()) as UploadOk | ErrorBody;
  return { status: r.status, body };
}

function asOk(b: UploadOk | ErrorBody): UploadOk {
  if (!("shortId" in b))
    throw new Error(`expected UploadOk, got ${JSON.stringify(b)}`);
  return b;
}

describe("upload response carries shortId + shortUrl", () => {
  test("anonymous upload includes shortId derived from id", async () => {
    const { status, body } = await upload("hi", "a.txt", "text/plain");
    expect(status).toBe(200);
    const b = asOk(body);
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.shortId).toBe(shortIdFromUuid(b.id));
    expect(b.url).toBe(`${ctx.baseUrl}/share/${b.id}`);
    expect(b.shortUrl).toBe(`${ctx.baseUrl}/share/${b.shortId}`);
    expect(b.version).toBe(1);
  });

  test("owned new-version upload includes shortId (stable across versions)", async () => {
    const first = asOk(
      (await upload("v1", "b.txt", "text/plain", { apiKey: KEY })).body,
    );
    const second = asOk(
      (await upload("v2", "b.txt", "text/plain", { apiKey: KEY, id: first.id }))
        .body,
    );
    expect(second.id).toBe(first.id);
    expect(second.shortId).toBe(first.shortId);
    expect(second.version).toBe(2);
  });

  test("dedup no-op returns shortId too", async () => {
    const first = asOk(
      (await upload("same", "d.txt", "text/plain", { apiKey: KEY })).body,
    );
    const dedup = asOk(
      (
        await upload("same", "d.txt", "text/plain", {
          apiKey: KEY,
          id: first.id,
        })
      ).body,
    );
    expect(dedup.version).toBe(1);
    expect(dedup.shortId).toBe(first.shortId);
    expect(dedup.shortUrl).toBe(`${ctx.baseUrl}/share/${first.shortId}`);
  });
});

describe("GET /share/:shortId", () => {
  test("shortId URL serves the same bytes as the UUID URL", async () => {
    const up = asOk((await upload("payload-xyz", "e.txt", "text/plain")).body);
    const byShort = await fetch(`${ctx.baseUrl}/share/${up.shortId}`);
    const byUuid = await fetch(`${ctx.baseUrl}/share/${up.id}`);
    expect(byShort.status).toBe(200);
    expect(byUuid.status).toBe(200);
    expect(await byShort.text()).toBe("payload-xyz");
    expect(await byUuid.text()).toBe("payload-xyz");
  });

  test("shortId at /:version serves that version", async () => {
    const first = asOk(
      (await upload("v1", "f.txt", "text/plain", { apiKey: KEY })).body,
    );
    await upload("v2", "f.txt", "text/plain", { apiKey: KEY, id: first.id });
    const byShort = await fetch(`${ctx.baseUrl}/share/${first.shortId}/2`);
    expect(byShort.status).toBe(200);
    expect(await byShort.text()).toBe("v2");
    const byUuid = await fetch(`${ctx.baseUrl}/share/${first.id}/2`);
    expect(await byUuid.text()).toBe("v2");
  });

  test("shortId lookup is case-sensitive (mangled casing → 404)", async () => {
    const up = asOk((await upload("xx", "g.txt", "text/plain")).body);
    // Flip case on the shortId. The hash output contains a mix of
    // upper+lower — flipping produces a different base62 string that
    // shouldn't hit any row.
    const flipped = up.shortId
      .split("")
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join("");
    if (flipped === up.shortId) {
      // Astronomically unlikely: shortId has no alpha chars. Skip.
      return;
    }
    const r = await fetch(`${ctx.baseUrl}/share/${flipped}`);
    expect(r.status).toBe(404);
  });

  test("unknown shortId of valid shape → 404", async () => {
    const r = await fetch(`${ctx.baseUrl}/share/zzzzzzzzzz`);
    expect(r.status).toBe(404);
    const b = (await r.json()) as ErrorBody;
    expect(b.error).toContain("not found");
  });

  test("malformed id (neither UUID nor shortId) → 400", async () => {
    const r = await fetch(`${ctx.baseUrl}/share/nope!`);
    expect(r.status).toBe(400);
  });
});

describe("DELETE /share/:shortId", () => {
  test("delete by shortId removes the file (UUID URL → 404)", async () => {
    const up = asOk(
      (await upload("to-delete", "h.txt", "text/plain", { apiKey: KEY })).body,
    );
    const del = await fetch(`${ctx.baseUrl}/share/${up.shortId}`, {
      method: "DELETE",
      headers: { "X-Api-Key": KEY },
    });
    expect(del.status).toBe(200);
    const getByUuid = await fetch(`${ctx.baseUrl}/share/${up.id}`);
    expect(getByUuid.status).toBe(404);
  });
});

describe("POST /share?id=<shortId>", () => {
  test("update an existing file using its shortId", async () => {
    const first = asOk(
      (await upload("v1", "u.txt", "text/plain", { apiKey: KEY })).body,
    );
    const updated = asOk(
      (
        await upload("v2", "u.txt", "text/plain", {
          apiKey: KEY,
          id: first.shortId,
        })
      ).body,
    );
    expect(updated.id).toBe(first.id);
    expect(updated.shortId).toBe(first.shortId);
    expect(updated.version).toBe(2);
  });

  test("nonexistent shortId → 404 (cannot claim new file via shortId)", async () => {
    const r = await upload("new", "n.txt", "text/plain", {
      apiKey: KEY,
      id: "0000000000", // valid shape, never assigned
    });
    expect(r.status).toBe(404);
    expect((r.body as ErrorBody).error).toContain("not found");
  });

  test("shortId of file owned by another key → 403", async () => {
    const first = asOk(
      (await upload("mine", "p.txt", "text/plain", { apiKey: KEY })).body,
    );
    const r = await upload("stolen", "p.txt", "text/plain", {
      apiKey: OTHER_KEY,
      id: first.shortId,
    });
    expect(r.status).toBe(403);
  });
});

describe("GET /files rows include shortId", () => {
  test("every row has shortId matching hash(id)", async () => {
    const key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await upload("one", "list1.txt", "text/plain", { apiKey: key });
    await upload("two", "list2.txt", "text/plain", { apiKey: key });
    const r = await fetch(`${ctx.baseUrl}/files`, {
      headers: { "X-Api-Key": key },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as ListResponse;
    expect(body.files.length).toBe(2);
    for (const row of body.files) {
      expect(row.shortId).toBe(shortIdFromUuid(row.id));
    }
  });
});

describe("Existing UUID URLs still work", () => {
  test("full UUID round-trip: upload → GET → version → DELETE", async () => {
    const up = asOk(
      (await upload("legacy", "leg.txt", "text/plain", { apiKey: KEY })).body,
    );
    const g1 = await fetch(`${ctx.baseUrl}/share/${up.id}`);
    expect(g1.status).toBe(200);
    expect(await g1.text()).toBe("legacy");
    const v2 = asOk(
      (
        await upload("legacy2", "leg.txt", "text/plain", {
          apiKey: KEY,
          id: up.id,
        })
      ).body,
    );
    expect(v2.version).toBe(2);
    const gv1 = await fetch(`${ctx.baseUrl}/share/${up.id}/1`);
    expect(await gv1.text()).toBe("legacy");
    const del = await fetch(`${ctx.baseUrl}/share/${up.id}`, {
      method: "DELETE",
      headers: { "X-Api-Key": KEY },
    });
    expect(del.status).toBe(200);
  });
});
