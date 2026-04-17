import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers";

let ctx: TestServer;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /health", () => {
  test("200 ok", async () => {
    const r = await fetch(`${ctx.baseUrl}/health`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });
});

describe("unknown routes", () => {
  test("GET /nope → 404 JSON", async () => {
    const r = await fetch(`${ctx.baseUrl}/nope`);
    expect(r.status).toBe(404);
    const b = (await r.json()) as { success: boolean; error: string };
    expect(b.success).toBe(false);
    expect(b.error).toContain("Not found");
  });
});
