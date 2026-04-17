// Lock-in: every endpoint that takes a UUID (header, path, query, body) must
// accept any case and behave identically to the lowercase form. Internally,
// UUIDs are always stored and compared as lowercase. Breaking this invariant
// would either create duplicate rows for the "same" id or reject callers
// depending on how their client happened to render a UUID.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers";

const ADMIN = "99999999-9999-4999-8999-999999999999";

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
  const body = (await res.json()) as { apiKey: string };
  return body.apiKey;
}

async function upload(key: string, content: string) {
  const form = new FormData();
  form.set("file", new File([content], "a.txt", { type: "text/plain" }));
  const res = await fetch(`${srv.baseUrl}/share`, {
    method: "POST",
    headers: { "x-api-key": key },
    body: form,
  });
  return (await res.json()) as {
    success: true;
    url: string;
    id: string;
    version: number;
  };
}

describe("UUID case-insensitivity invariant", () => {
  test("X-Api-Key header — uppercase works same as lowercase", async () => {
    const key = await createKey();
    const form = new FormData();
    form.set("file", new File(["x"], "a.txt", { type: "text/plain" }));
    const res = await fetch(`${srv.baseUrl}/share`, {
      method: "POST",
      headers: { "x-api-key": key.toUpperCase() },
      body: form,
    });
    expect(res.status).toBe(200);
  });

  test("Authorization bearer — uppercase works", async () => {
    const key = await createKey();
    const form = new FormData();
    form.set("file", new File(["y"], "a.txt", { type: "text/plain" }));
    const res = await fetch(`${srv.baseUrl}/share`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.toUpperCase()}` },
      body: form,
    });
    expect(res.status).toBe(200);
  });

  test("X-Admin-Key — uppercase works on /admin/keys", async () => {
    const res = await fetch(`${srv.baseUrl}/admin/keys`, {
      headers: { "x-admin-key": ADMIN.toUpperCase() },
    });
    expect(res.status).toBe(200);
  });

  test("GET /share/:id — uppercase id serves the same file as lowercase", async () => {
    const key = await createKey();
    const up = await upload(key, "hello-case");

    const getLower = await fetch(`${srv.baseUrl}/share/${up.id}`);
    const getUpper = await fetch(`${srv.baseUrl}/share/${up.id.toUpperCase()}`);

    expect(getLower.status).toBe(200);
    expect(getUpper.status).toBe(200);
    expect(await getUpper.text()).toBe(await getLower.text());
  });

  test("POST /share?id=<UPPER> updates the same file created with lowercase id", async () => {
    const key = await createKey();
    const up = await upload(key, "v1");

    const form = new FormData();
    form.set("file", new File(["v2"], "a.txt", { type: "text/plain" }));
    const res = await fetch(`${srv.baseUrl}/share?id=${up.id.toUpperCase()}`, {
      method: "POST",
      headers: { "x-api-key": key },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; version: number };
    expect(body.id).toBe(up.id); // stored lowercase, echoed back lowercase
    expect(body.version).toBe(2);
  });

  test("DELETE /share/:id — uppercase id deletes the lowercase-stored file", async () => {
    const key = await createKey();
    const up = await upload(key, "to-delete");

    const del = await fetch(`${srv.baseUrl}/share/${up.id.toUpperCase()}`, {
      method: "DELETE",
      headers: { "x-api-key": key },
    });
    expect(del.status).toBe(200);

    const get = await fetch(`${srv.baseUrl}/share/${up.id}`, {
      headers: { "x-api-key": key },
    });
    expect(get.status).toBe(404);
  });

  test("admin endpoints — uppercase key in path works across GET/PATCH/DELETE", async () => {
    const key = await createKey();
    const upper = key.toUpperCase();

    const get = await fetch(`${srv.baseUrl}/admin/keys/${upper}`, {
      headers: { "x-admin-key": ADMIN },
    });
    expect(get.status).toBe(200);

    const patch = await fetch(`${srv.baseUrl}/admin/keys/${upper}`, {
      method: "PATCH",
      headers: { "x-admin-key": ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ status: "inactive" }),
    });
    expect(patch.status).toBe(200);

    const del = await fetch(`${srv.baseUrl}/admin/keys/${upper}`, {
      method: "DELETE",
      headers: { "x-admin-key": ADMIN },
    });
    expect(del.status).toBe(200);
  });

  test("POST /admin/keys — uppercase apiKey in body is stored lowercase", async () => {
    const uuid = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
    const res = await fetch(`${srv.baseUrl}/admin/keys`, {
      method: "POST",
      headers: { "x-admin-key": ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: uuid.toUpperCase(), status: "active" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apiKey: string };
    expect(body.apiKey).toBe(uuid); // normalized to lowercase
  });

  test("POST /admin/keys/:oldKey/rotate — uppercase old/new keys both accepted", async () => {
    const oldKey = await createKey();
    const newKey = "bbbbcccc-dddd-4eee-8fff-000011112222";

    const res = await fetch(
      `${srv.baseUrl}/admin/keys/${oldKey.toUpperCase()}/rotate`,
      {
        method: "POST",
        headers: { "x-admin-key": ADMIN, "content-type": "application/json" },
        body: JSON.stringify({ newKey: newKey.toUpperCase() }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { oldKey: string; newKey: string };
    expect(body.oldKey).toBe(oldKey); // echoed lowercase
    expect(body.newKey).toBe(newKey); // stored lowercase
  });
});
