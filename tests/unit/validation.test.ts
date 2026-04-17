import { describe, expect, test } from "bun:test";
import {
  ALLOWED_TYPES,
  EXT_ALIASES,
  asciiFallback,
  canonicalExt,
  contentTypeHeader,
  encodeRFC5987,
  extFromFilename,
  isShortId,
  isUuid,
  parseVersionParam,
  sanitizeFilename,
} from "../../src/validation";

describe("isUuid", () => {
  test.each([
    "a1b2c3d4-5678-4abc-9def-000000000000",
    "A1B2C3D4-5678-4ABC-9DEF-000000000000",
    "00000000-0000-4000-8000-000000000000",
  ])("accepts %s", (s) => expect(isUuid(s)).toBe(true));

  test.each([
    "",
    "not-a-uuid",
    "a1b2c3d4-5678-4abc-9def-00000000000",
    "a1b2c3d4-5678-6abc-9def-000000000000",
    "zzzzzzzz-5678-4abc-9def-000000000000",
  ])("rejects %s", (s) => expect(isUuid(s)).toBe(false));
});

describe("isShortId", () => {
  test.each([
    "Ab3xKp9qZ2",
    "0123456789",
    "ABCDEFGHIJ",
    "abcdefghij",
    "Ab3xKp9qZ2A", // 11
    "Ab3xKp9qZ2ABCDEF", // 16
  ])("accepts %s", (s) => expect(isShortId(s)).toBe(true));

  test.each([
    "",
    "Ab3xKp9qZ", // 9 chars
    "Ab3xKp9qZ2ABCDEFG", // 17 chars
    "Ab3xKp-qZ2", // hyphen
    "Ab3xKp_qZ2", // underscore
    "Ab3xKp qZ2", // space
    "a1b2c3d4-5678-4abc-9def-000000000000", // a UUID
  ])("rejects %s", (s) => expect(isShortId(s)).toBe(false));
});

describe("extFromFilename", () => {
  test("extracts", () => {
    expect(extFromFilename("foo.html")).toBe("html");
    expect(extFromFilename("a.tar.gz")).toBe("gz");
  });
  test("null when missing", () => {
    expect(extFromFilename("README")).toBeNull();
    expect(extFromFilename("foo.")).toBeNull();
    expect(extFromFilename("")).toBeNull();
  });
});

describe("canonicalExt", () => {
  test("direct + case", () => {
    expect(canonicalExt("html")).toBe("html");
    expect(canonicalExt("JpEg")).toBe("jpg");
  });
  test("aliases", () => {
    expect(canonicalExt("jpeg")).toBe("jpg");
    expect(canonicalExt("htm")).toBe("html");
  });
  test("rejects", () => {
    expect(canonicalExt("exe")).toBeNull();
    expect(canonicalExt("svg")).toBeNull();
  });
});

describe("ALLOWED_TYPES", () => {
  test("covers all 7 types", () => {
    expect(Object.keys(ALLOWED_TYPES).sort()).toEqual([
      "gif",
      "html",
      "jpg",
      "json",
      "md",
      "png",
      "txt",
    ]);
  });
  test("image charset null", () => {
    for (const k of ["png", "jpg", "gif"] as const)
      expect(ALLOWED_TYPES[k].charset).toBeNull();
  });
  test("text charset utf-8", () => {
    for (const k of ["html", "txt", "md", "json"] as const)
      expect(ALLOWED_TYPES[k].charset).toBe("utf-8");
  });
});

describe("EXT_ALIASES", () => {
  test("jpeg→jpg, htm→html", () => {
    expect(EXT_ALIASES.jpeg).toBe("jpg");
    expect(EXT_ALIASES.htm).toBe("html");
  });
});

describe("sanitizeFilename", () => {
  test("strips separators", () => {
    expect(sanitizeFilename("../etc/passwd", "fb")).toBe("etcpasswd");
    expect(sanitizeFilename("a\\b\\c.txt", "fb")).toBe("abc.txt");
  });
  test("strips control chars", () => {
    expect(sanitizeFilename("foo\x00bar\x1f.txt", "fb")).toBe("foobar.txt");
  });
  test("trims whitespace", () => {
    expect(sanitizeFilename("  hi.md  ", "fb")).toBe("hi.md");
  });
  test("unicode preserved", () => {
    expect(sanitizeFilename("żółć.md", "fb")).toBe("żółć.md");
    expect(sanitizeFilename("🔥r.txt", "fb")).toBe("🔥r.txt");
  });
  test("truncates to 255 UTF-8 bytes", () => {
    const long = "a".repeat(300) + ".txt";
    const r = sanitizeFilename(long, "fb");
    expect(new TextEncoder().encode(r).length).toBeLessThanOrEqual(255);
  });
  test("fallback when empty after sanitize", () => {
    expect(sanitizeFilename("", "fallback.txt")).toBe("fallback.txt");
    expect(sanitizeFilename("///", "fallback.txt")).toBe("fallback.txt");
    expect(sanitizeFilename("   ", "fallback.txt")).toBe("fallback.txt");
  });
});

describe("encodeRFC5987", () => {
  test("percent-encodes unicode", () => {
    expect(encodeRFC5987("żółć.txt")).toBe("%C5%BC%C3%B3%C5%82%C4%87.txt");
  });
  test("encodes reserved", () => {
    expect(encodeRFC5987("a'b(c).txt")).toBe("a%27b%28c%29.txt");
  });
});

describe("asciiFallback", () => {
  test("non-ASCII→underscore", () => {
    expect(asciiFallback("żółć.txt")).toBe("____.txt");
  });
  test("strips double-quotes", () => {
    expect(asciiFallback('he said "hi".txt')).toBe("he said hi.txt");
  });
  test("ASCII intact", () => {
    expect(asciiFallback("n-f_1.md")).toBe("n-f_1.md");
  });
});

describe("contentTypeHeader", () => {
  test("text → with charset", () => {
    expect(contentTypeHeader(ALLOWED_TYPES.html)).toBe(
      "text/html; charset=utf-8",
    );
  });
  test("binary → no charset", () => {
    expect(contentTypeHeader(ALLOWED_TYPES.png)).toBe("image/png");
  });
});

describe("parseVersionParam", () => {
  test("positive integers return {ok:true, version}", () => {
    expect(parseVersionParam("1")).toEqual({ ok: true, version: 1 });
    expect(parseVersionParam("42")).toEqual({ ok: true, version: 42 });
  });
  test("zero rejected", () => {
    expect(parseVersionParam("0")).toEqual({
      ok: false,
      error: "Invalid version number — must be a positive integer",
    });
  });
  test("negative rejected", () => {
    expect(parseVersionParam("-1").ok).toBe(false);
  });
  test("non-integer rejected", () => {
    expect(parseVersionParam("1.5").ok).toBe(false);
    expect(parseVersionParam("abc").ok).toBe(false);
    expect(parseVersionParam("").ok).toBe(false);
  });
});
