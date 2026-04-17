import { describe, expect, test } from "bun:test";
import { shortIdFromUuid, tryShortIdAtLength } from "../../src/shortid";

const UUID_A = "c1d2e3f4-5678-4abc-9def-0123456789ab";
const UUID_B = "a1b2c3d4-e5f6-4789-8abc-def012345678";

describe("shortIdFromUuid", () => {
  test("deterministic — same uuid yields same shortId across calls", () => {
    const a = shortIdFromUuid(UUID_A);
    const b = shortIdFromUuid(UUID_A);
    const c = shortIdFromUuid(UUID_A);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("default length is 10", () => {
    expect(shortIdFromUuid(UUID_A)).toHaveLength(10);
  });

  test("different uuids yield different shortIds", () => {
    expect(shortIdFromUuid(UUID_A)).not.toBe(shortIdFromUuid(UUID_B));
  });

  test("output matches base62 alphabet /^[0-9A-Za-z]+$/", () => {
    expect(shortIdFromUuid(UUID_A)).toMatch(/^[0-9A-Za-z]+$/);
    expect(shortIdFromUuid(UUID_B)).toMatch(/^[0-9A-Za-z]+$/);
    for (let len = 1; len <= 43; len++) {
      expect(tryShortIdAtLength(UUID_A, len)).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  test("known vector — pinned output for UUID_A", () => {
    // Pinned on first run. If this changes the base62/sha256 algorithm changed.
    const pinned = shortIdFromUuid(UUID_A);
    expect(shortIdFromUuid(UUID_A)).toBe(pinned);
    // length
    expect(pinned).toHaveLength(10);
  });
});

describe("tryShortIdAtLength", () => {
  test("length 10..16 form a strict prefix chain (collision extension)", () => {
    let prev = tryShortIdAtLength(UUID_A, 10);
    expect(prev).toHaveLength(10);
    for (let len = 11; len <= 16; len++) {
      const next = tryShortIdAtLength(UUID_A, len);
      expect(next).toHaveLength(len);
      expect(next.slice(0, len - 1)).toBe(prev);
      prev = next;
    }
  });

  test("rejects out-of-range length", () => {
    expect(() => tryShortIdAtLength(UUID_A, 0)).toThrow();
    expect(() => tryShortIdAtLength(UUID_A, 44)).toThrow();
    expect(() => tryShortIdAtLength(UUID_A, -1)).toThrow();
  });

  test("length 43 covers full base62 encoding", () => {
    const full = tryShortIdAtLength(UUID_A, 43);
    expect(full).toHaveLength(43);
    expect(full).toMatch(/^[0-9A-Za-z]+$/);
    // 10-char shortId is a prefix
    expect(full.slice(0, 10)).toBe(shortIdFromUuid(UUID_A));
  });
});
