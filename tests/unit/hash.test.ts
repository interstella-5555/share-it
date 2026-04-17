import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../../src/hash";

describe("sha256Hex", () => {
  test("empty input → known vector", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  test("'abc' → known vector", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  test("deterministic", () => {
    const b = new TextEncoder().encode("x");
    expect(sha256Hex(b)).toBe(sha256Hex(b));
  });
  test("different inputs differ", () => {
    expect(sha256Hex(new TextEncoder().encode("a"))).not.toBe(
      sha256Hex(new TextEncoder().encode("b")),
    );
  });
});
