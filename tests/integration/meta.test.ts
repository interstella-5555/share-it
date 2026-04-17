import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers";

let ctx: TestServer;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /", () => {
  test("returns self-description JSON", async () => {
    const r = await fetch(`${ctx.baseUrl}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = await r.json();
    expect(body).toEqual({
      name: "share-it",
      version: expect.any(String),
      openapi: "/openapi.json",
      docs: "/docs",
    });
  });

  test("includes RFC 8631 Link header", async () => {
    const r = await fetch(`${ctx.baseUrl}/`);
    const link = r.headers.get("link");
    expect(link).toBe(
      '</openapi.json>; rel="service-desc", </docs>; rel="alternate"; type="text/html"',
    );
  });
});

describe("GET /docs", () => {
  test("serves HTML referencing Scalar + /openapi.json", async () => {
    const r = await fetch(`${ctx.baseUrl}/docs`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const body = await r.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('data-url="/openapi.json"');
    expect(body).toContain("@scalar/api-reference");
  });
});

describe("GET /openapi.json", () => {
  test("returns openapi document", async () => {
    const r = await fetch(`${ctx.baseUrl}/openapi.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };
    expect(body.openapi).toMatch(/^3\.1\./);
    expect(body.info.title).toBe("share-it");
    expect(Object.keys(body.paths)).toEqual(
      expect.arrayContaining([
        "/",
        "/openapi.json",
        "/docs",
        "/health",
        "/share",
        "/share/{id}",
        "/share/{id}/{version}",
        "/admin/keys",
        "/admin/keys/{key}",
        "/admin/keys/{oldKey}/rotate",
      ]),
    );
  });

  test("is valid JSON (parseable)", async () => {
    const r = await fetch(`${ctx.baseUrl}/openapi.json`);
    const text = await r.text();
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
