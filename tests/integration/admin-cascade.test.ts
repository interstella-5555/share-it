import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers";

const ADMIN = "88888888-8888-4888-8888-888888888888";

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer({ protectedMode: true, adminKey: ADMIN });
});
afterAll(async () => await srv.cleanup());

async function createKey(): Promise<string> {
  const res = await fetch(`${srv.baseUrl}/admin/keys`, {
    method: "POST",
    headers: { "x-admin-key": ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ status: "active" }),
  });
  return ((await res.json()) as { apiKey: string }).apiKey;
}

async function upload(key: string, content: string) {
  const form = new FormData();
  form.set("file", new File([content], "a.txt", { type: "text/plain" }));
  const res = await fetch(`${srv.baseUrl}/share`, {
    method: "POST",
    headers: { "x-api-key": key },
    body: form,
  });
  return (await res.json()) as { id: string; version: number; url: string };
}

describe("DELETE /admin/keys/:id?cascade=true", () => {
  test("non-cascade: key with files → 409 (unchanged behavior)", async () => {
    const k = await createKey();
    await upload(k, "x");
    const res = await fetch(`${srv.baseUrl}/admin/keys/${k}`, {
      method: "DELETE",
      headers: { "x-admin-key": ADMIN },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  test("cascade=true removes key + files + blobs and frees URLs", async () => {
    const k = await createKey();
    const up1 = await upload(k, "one");
    const up2 = await upload(k, "two");

    const res = await fetch(`${srv.baseUrl}/admin/keys/${k}?cascade=true`, {
      method: "DELETE",
      headers: { "x-admin-key": ADMIN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // key gone
    const list = await fetch(`${srv.baseUrl}/admin/keys`, {
      headers: { "x-admin-key": ADMIN },
    });
    const lb = (await list.json()) as {
      keys: { apiKey: string }[];
    };
    expect(lb.keys.find((r) => r.apiKey === k)).toBeUndefined();

    // URLs released — a different key can now claim them
    for (const up of [up1, up2]) {
      const other = await createKey();
      const form = new FormData();
      form.set("file", new File(["claim"], "a.txt", { type: "text/plain" }));
      const claim = await fetch(`${srv.baseUrl}/share?id=${up.id}`, {
        method: "POST",
        headers: { "x-api-key": other },
        body: form,
      });
      expect(claim.status).toBe(200);
    }
  });

  test("cascade=false / empty / True (case) / 1 → all treated as non-cascade", async () => {
    for (const v of ["false", "", "True", "1"]) {
      const k = await createKey();
      await upload(k, "x");
      const query =
        v === "" ? `?cascade=` : `?cascade=${encodeURIComponent(v)}`;
      const res = await fetch(`${srv.baseUrl}/admin/keys/${k}${query}`, {
        method: "DELETE",
        headers: { "x-admin-key": ADMIN },
      });
      expect(res.status).toBe(409);
    }
  });

  test("cascade=true on a key with no files → 200 (same as plain delete)", async () => {
    const k = await createKey();
    const res = await fetch(`${srv.baseUrl}/admin/keys/${k}?cascade=true`, {
      method: "DELETE",
      headers: { "x-admin-key": ADMIN },
    });
    expect(res.status).toBe(200);
  });

  test("cascade without admin credentials → 401", async () => {
    const k = await createKey();
    await upload(k, "x");
    const res = await fetch(`${srv.baseUrl}/admin/keys/${k}?cascade=true`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  test("cascade on missing key → 404", async () => {
    const res = await fetch(
      `${srv.baseUrl}/admin/keys/00000000-0000-4000-8000-000000000000?cascade=true`,
      { method: "DELETE", headers: { "x-admin-key": ADMIN } },
    );
    expect(res.status).toBe(404);
  });

  test("cascade deletes blobs from disk, not just DB rows", async () => {
    // Verify via pathForBlob that the blob file is physically gone.
    const { pathForBlob } = await import("../../src/storage");
    const { stat } = await import("node:fs/promises");
    const k = await createKey();
    const up = await upload(k, "content");
    const blob = pathForBlob(srv.config.filesDir, up.id, 1, "txt");
    await stat(blob); // exists

    await fetch(`${srv.baseUrl}/admin/keys/${k}?cascade=true`, {
      method: "DELETE",
      headers: { "x-admin-key": ADMIN },
    });
    await expect(stat(blob)).rejects.toThrow();
  });
});
