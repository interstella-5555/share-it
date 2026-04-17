import { describe, test, expect } from "bun:test";
import { ok, err } from "../../src/http";

describe("ok()", () => {
  test("empty body → {success:true}", async () => {
    const res = ok();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ success: true });
  });

  test("spreads extra fields", async () => {
    const res = ok({ url: "http://x", id: "abc", version: 1 });
    expect(await res.json()).toEqual({
      success: true,
      url: "http://x",
      id: "abc",
      version: 1,
    });
  });

  test("does not allow callers to override success=true", async () => {
    const res = ok({ success: false as unknown as true, x: 1 });
    expect(await res.json()).toEqual({ success: true, x: 1 });
  });
});

describe("err()", () => {
  test("produces {success:false, error}", async () => {
    const res = err(404, "not here");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ success: false, error: "not here" });
  });
});
