import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { pathForBlob } from "../../src/storage";
import { startTestServer, type TestServer } from "./helpers";

const ADMIN = "99999999-9999-4999-8999-999999999999";

let ctx: TestServer;
beforeAll(async () => {
  ctx = await startTestServer({ protectedMode: true, adminKey: ADMIN });
});
afterAll(async () => {
  await ctx.cleanup();
});

async function createKey(): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/admin/keys`, {
    method: "POST",
    headers: {
      "X-Admin-Key": ADMIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "active" }),
  });
  const body = (await res.json()) as { apiKey: string };
  return body.apiKey;
}

async function upload(
  key: string,
  content: string,
): Promise<{ id: string; version: number; url: string }> {
  const form = new FormData();
  form.set("file", new File([content], "file.txt", { type: "text/plain" }));
  const res = await fetch(`${ctx.baseUrl}/share`, {
    method: "POST",
    headers: { "X-API-Key": key },
    body: form,
  });
  const body = (await res.json()) as {
    success: true;
    url: string;
    id: string;
    version: number;
  };
  return { id: body.id, version: body.version, url: body.url };
}

describe("DELETE /share/:id — auth", () => {
  test("no credentials → 401", async () => {
    const k = await createKey();
    const up = await upload(k, "hello");
    const res = await fetch(`${ctx.baseUrl}/share/${up.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
    const b = (await res.json()) as { success: boolean };
    expect(b.success).toBe(false);
  });

  test("wrong owner → 403", async () => {
    const owner = await createKey();
    const other = await createKey();
    const up = await upload(owner, "hello");
    const res = await fetch(`${ctx.baseUrl}/share/${up.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": other },
    });
    expect(res.status).toBe(403);
  });

  test("invalid UUID → 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/share/not-a-uuid`, {
      method: "DELETE",
      headers: { "X-Admin-Key": ADMIN },
    });
    expect(res.status).toBe(400);
  });

  test("missing id → 404", async () => {
    const res = await fetch(
      `${ctx.baseUrl}/share/00000000-0000-4000-8000-000000000000`,
      {
        method: "DELETE",
        headers: { "X-Admin-Key": ADMIN },
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /share/:id — success and URL reservation", () => {
  test("owner deletes own file → 200, GET 404, blob gone", async () => {
    const k = await createKey();
    const up = await upload(k, "hello");
    const blob = pathForBlob(ctx.config.filesDir, up.id, 1, "txt");
    await stat(blob); // exists before delete

    const del = await fetch(`${ctx.baseUrl}/share/${up.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": k },
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true });

    const get = await fetch(`${ctx.baseUrl}/share/${up.id}`, {
      headers: { "X-API-Key": k },
    });
    expect(get.status).toBe(404);

    await expect(stat(blob)).rejects.toThrow();
  });

  test("admin deletes anyone's file → 200", async () => {
    const k = await createKey();
    const up = await upload(k, "hi");
    const del = await fetch(`${ctx.baseUrl}/share/${up.id}`, {
      method: "DELETE",
      headers: { "X-Admin-Key": ADMIN },
    });
    expect(del.status).toBe(200);
  });

  test("URL stays reserved: re-upload by owner restores with v1", async () => {
    const k = await createKey();
    const up = await upload(k, "first");
    const del = await fetch(`${ctx.baseUrl}/share/${up.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": k },
    });
    expect(del.status).toBe(200);

    const form = new FormData();
    form.set("file", new File(["second"], "a.txt", { type: "text/plain" }));
    const res = await fetch(`${ctx.baseUrl}/share?id=${up.id}`, {
      method: "POST",
      headers: { "X-API-Key": k },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      id: string;
      version: number;
    };
    expect(body.success).toBe(true);
    expect(body.id).toBe(up.id);
    expect(body.version).toBe(1);
  });

  test("URL stays reserved: different key cannot claim deleted id", async () => {
    const owner = await createKey();
    const other = await createKey();
    const up = await upload(owner, "first");
    const del = await fetch(`${ctx.baseUrl}/share/${up.id}`, {
      method: "DELETE",
      headers: { "X-API-Key": owner },
    });
    expect(del.status).toBe(200);

    const form = new FormData();
    form.set("file", new File(["intrusion"], "a.txt", { type: "text/plain" }));
    const res = await fetch(`${ctx.baseUrl}/share?id=${up.id}`, {
      method: "POST",
      headers: { "X-API-Key": other },
      body: form,
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /share/:id/:version", () => {
  test("deletes one version, others remain addressable", async () => {
    const k = await createKey();
    const up = await upload(k, "v1");

    // upload a second version under the same id
    const form = new FormData();
    form.set("file", new File(["v2!"], "a.txt", { type: "text/plain" }));
    const v2 = await fetch(`${ctx.baseUrl}/share?id=${up.id}`, {
      method: "POST",
      headers: { "x-api-key": k },
      body: form,
    });
    const v2body = (await v2.json()) as { version: number };
    expect(v2body.version).toBe(2);

    // delete v1 only
    const del = await fetch(`${ctx.baseUrl}/share/${up.id}/1`, {
      method: "DELETE",
      headers: { "x-api-key": k },
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true });

    // v1 gone
    const getV1 = await fetch(`${ctx.baseUrl}/share/${up.id}/1`, {
      headers: { "x-api-key": k },
    });
    expect(getV1.status).toBe(404);

    // v2 still serves (/share/:id also serves latest = v2)
    const getLatest = await fetch(`${ctx.baseUrl}/share/${up.id}`, {
      headers: { "x-api-key": k },
    });
    expect(getLatest.status).toBe(200);
    expect(await getLatest.text()).toBe("v2!");
  });

  test("deleting last remaining version keeps files row (reservation)", async () => {
    const k = await createKey();
    const up = await upload(k, "only");

    const del = await fetch(`${ctx.baseUrl}/share/${up.id}/1`, {
      method: "DELETE",
      headers: { "x-api-key": k },
    });
    expect(del.status).toBe(200);

    // GET serves 404 now
    const get = await fetch(`${ctx.baseUrl}/share/${up.id}`, {
      headers: { "x-api-key": k },
    });
    expect(get.status).toBe(404);

    // owner can still re-upload to this id, becomes v1 again (MAX+1 from empty versions)
    const form = new FormData();
    form.set("file", new File(["again"], "a.txt", { type: "text/plain" }));
    const re = await fetch(`${ctx.baseUrl}/share?id=${up.id}`, {
      method: "POST",
      headers: { "x-api-key": k },
      body: form,
    });
    expect(re.status).toBe(200);
    const reBody = (await re.json()) as { id: string; version: number };
    expect(reBody.id).toBe(up.id);
    expect(reBody.version).toBe(1);
  });

  test("stranger cannot re-claim id after owner deletes last version", async () => {
    const owner = await createKey();
    const other = await createKey();
    const up = await upload(owner, "only");

    await fetch(`${ctx.baseUrl}/share/${up.id}/1`, {
      method: "DELETE",
      headers: { "x-api-key": owner },
    });

    const form = new FormData();
    form.set("file", new File(["takeover"], "a.txt", { type: "text/plain" }));
    const res = await fetch(`${ctx.baseUrl}/share?id=${up.id}`, {
      method: "POST",
      headers: { "x-api-key": other },
      body: form,
    });
    expect(res.status).toBe(403);
  });

  test("version hole preserved on next upload", async () => {
    const k = await createKey();
    const up = await upload(k, "v1");

    const form2 = new FormData();
    form2.set("file", new File(["v2"], "a.txt", { type: "text/plain" }));
    await fetch(`${ctx.baseUrl}/share?id=${up.id}`, {
      method: "POST",
      headers: { "x-api-key": k },
      body: form2,
    });

    const form3 = new FormData();
    form3.set("file", new File(["v3"], "a.txt", { type: "text/plain" }));
    await fetch(`${ctx.baseUrl}/share?id=${up.id}`, {
      method: "POST",
      headers: { "x-api-key": k },
      body: form3,
    });

    // delete middle version v2 (leaves v1, v3 → MAX=3)
    await fetch(`${ctx.baseUrl}/share/${up.id}/2`, {
      method: "DELETE",
      headers: { "x-api-key": k },
    });

    // upload again → should be v4 (MAX(1,3)+1), not v2 reused
    const form4 = new FormData();
    form4.set("file", new File(["v4"], "a.txt", { type: "text/plain" }));
    const r4 = await fetch(`${ctx.baseUrl}/share?id=${up.id}`, {
      method: "POST",
      headers: { "x-api-key": k },
      body: form4,
    });
    const r4body = (await r4.json()) as { version: number };
    expect(r4body.version).toBe(4);

    // and v2 URL stays 404
    const getV2 = await fetch(`${ctx.baseUrl}/share/${up.id}/2`, {
      headers: { "x-api-key": k },
    });
    expect(getV2.status).toBe(404);
  });

  test("invalid version → 400", async () => {
    const k = await createKey();
    const up = await upload(k, "x");
    const res = await fetch(`${ctx.baseUrl}/share/${up.id}/zero`, {
      method: "DELETE",
      headers: { "x-api-key": k },
    });
    expect(res.status).toBe(400);
  });

  test("missing version → 404 with max-version hint", async () => {
    const k = await createKey();
    const up = await upload(k, "x");
    const res = await fetch(`${ctx.baseUrl}/share/${up.id}/99`, {
      method: "DELETE",
      headers: { "x-api-key": k },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Version 99/);
    expect(body.error).toMatch(/Latest version: 1/);
  });

  test("non-owner cannot delete a version", async () => {
    const owner = await createKey();
    const other = await createKey();
    const up = await upload(owner, "x");
    const res = await fetch(`${ctx.baseUrl}/share/${up.id}/1`, {
      method: "DELETE",
      headers: { "x-api-key": other },
    });
    expect(res.status).toBe(403);
  });
});
