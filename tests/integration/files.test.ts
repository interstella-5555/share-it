import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer({ protectedMode: true, adminKey: ADMIN });
});
afterAll(async () => await srv.cleanup());

async function createKey(
  status: "active" | "inactive" | "suspended" = "active",
) {
  const res = await fetch(`${srv.baseUrl}/admin/keys`, {
    method: "POST",
    headers: { "x-admin-key": ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  return ((await res.json()) as { apiKey: string }).apiKey;
}

async function upload(key: string, name: string, content: string) {
  const form = new FormData();
  form.set("file", new File([content], name, { type: "text/plain" }));
  const res = await fetch(`${srv.baseUrl}/share`, {
    method: "POST",
    headers: { "x-api-key": key },
    body: form,
  });
  return (await res.json()) as { id: string; version: number };
}

async function uploadVersion(
  key: string,
  id: string,
  name: string,
  content: string,
) {
  const form = new FormData();
  form.set("file", new File([content], name, { type: "text/plain" }));
  const res = await fetch(`${srv.baseUrl}/share?id=${id}`, {
    method: "POST",
    headers: { "x-api-key": key },
    body: form,
  });
  return (await res.json()) as { id: string; version: number };
}

describe("GET /files", () => {
  test("401 without API key", async () => {
    const res = await fetch(`${srv.baseUrl}/files`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  test("400 for malformed API key", async () => {
    const res = await fetch(`${srv.baseUrl}/files`, {
      headers: { "x-api-key": "not-a-uuid" },
    });
    expect(res.status).toBe(400);
  });

  test("403 for unknown / inactive / suspended keys", async () => {
    const unknown = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const res1 = await fetch(`${srv.baseUrl}/files`, {
      headers: { "x-api-key": unknown },
    });
    expect(res1.status).toBe(403);

    const inactive = await createKey("inactive");
    const res2 = await fetch(`${srv.baseUrl}/files`, {
      headers: { "x-api-key": inactive },
    });
    expect(res2.status).toBe(403);

    const suspended = await createKey("suspended");
    const res3 = await fetch(`${srv.baseUrl}/files`, {
      headers: { "x-api-key": suspended },
    });
    expect(res3.status).toBe(403);
  });

  test("returns empty array for a key with no files", async () => {
    const k = await createKey();
    const res = await fetch(`${srv.baseUrl}/files`, {
      headers: { "x-api-key": k },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      files: unknown[];
    };
    expect(body.success).toBe(true);
    expect(body.files).toEqual([]);
  });

  test("returns owned files only, sorted by lastUploadAt desc", async () => {
    const mine = await createKey();
    const other = await createKey();

    const a = await upload(mine, "a.txt", "a1");
    await new Promise((r) => setTimeout(r, 5));
    const b = await upload(mine, "b.txt", "b1");
    await new Promise((r) => setTimeout(r, 5));
    await upload(other, "foreign.txt", "other"); // must NOT appear

    const res = await fetch(`${srv.baseUrl}/files`, {
      headers: { "x-api-key": mine },
    });
    const body = (await res.json()) as {
      files: { id: string; originalName: string; latestVersion: number }[];
    };
    expect(body.files).toHaveLength(2);
    // newest first
    expect(body.files[0]!.id).toBe(b.id);
    expect(body.files[0]!.originalName).toBe("b.txt");
    expect(body.files[0]!.latestVersion).toBe(1);
    expect(body.files[1]!.id).toBe(a.id);
    expect(body.files[1]!.originalName).toBe("a.txt");
  });

  test("originalName + latestVersion reflect the most recent version", async () => {
    const k = await createKey();
    const up = await upload(k, "doc.txt", "v1");
    await new Promise((r) => setTimeout(r, 5));
    const v2 = await uploadVersion(k, up.id, "doc-renamed.txt", "v2 content");

    const res = await fetch(`${srv.baseUrl}/files`, {
      headers: { "x-api-key": k },
    });
    const body = (await res.json()) as {
      files: {
        id: string;
        originalName: string;
        latestVersion: number;
        size: number;
      }[];
    };
    const row = body.files.find((f) => f.id === up.id);
    expect(row).toBeDefined();
    expect(row!.originalName).toBe("doc-renamed.txt");
    expect(row!.latestVersion).toBe(v2.version);
    expect(row!.size).toBe("v2 content".length);
  });

  test("tombstoned files (all versions deleted) are excluded", async () => {
    const k = await createKey();
    const up = await upload(k, "ghost.txt", "boo");

    // whole-file delete → files row stays (tombstone), versions go away
    await fetch(`${srv.baseUrl}/share/${up.id}`, {
      method: "DELETE",
      headers: { "x-api-key": k },
    });

    const res = await fetch(`${srv.baseUrl}/files`, {
      headers: { "x-api-key": k },
    });
    const body = (await res.json()) as {
      files: { id: string }[];
    };
    expect(body.files.find((f) => f.id === up.id)).toBeUndefined();
  });

  test("accepts Authorization: Bearer <uuid> in addition to X-Api-Key", async () => {
    const k = await createKey();
    await upload(k, "bear.txt", "x");
    const res = await fetch(`${srv.baseUrl}/files`, {
      headers: { authorization: `Bearer ${k}` },
    });
    expect(res.status).toBe(200);
  });

  test("uppercase X-Api-Key works (case-insensitive invariant)", async () => {
    const k = await createKey();
    await upload(k, "up.txt", "x");
    const res = await fetch(`${srv.baseUrl}/files`, {
      headers: { "x-api-key": k.toUpperCase() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: { originalName: string }[];
    };
    expect(body.files).toHaveLength(1);
  });
});
