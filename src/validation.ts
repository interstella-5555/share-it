export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_REGEX.test(s);
}

// Base62 shortId in the 10..16 char range produced by src/shortid.ts.
// Case-sensitive: base62 treats A and a as distinct characters.
export const SHORTID_REGEX = /^[0-9A-Za-z]{10,16}$/;

export function isShortId(s: string): boolean {
  return SHORTID_REGEX.test(s);
}

export interface AllowedType {
  ext: string;
  mime: string;
  charset: string | null;
}

export const ALLOWED_TYPES: {
  [K in "html" | "txt" | "md" | "json" | "png" | "jpg" | "gif"]: AllowedType;
} = {
  html: { ext: "html", mime: "text/html", charset: "utf-8" },
  txt: { ext: "txt", mime: "text/plain", charset: "utf-8" },
  md: { ext: "md", mime: "text/markdown", charset: "utf-8" },
  json: { ext: "json", mime: "application/json", charset: "utf-8" },
  png: { ext: "png", mime: "image/png", charset: null },
  jpg: { ext: "jpg", mime: "image/jpeg", charset: null },
  gif: { ext: "gif", mime: "image/gif", charset: null },
};

export const EXT_ALIASES: Record<string, string> = { jpeg: "jpg", htm: "html" };

export function canonicalExt(ext: string): string | null {
  const lower = ext.toLowerCase();
  const c = EXT_ALIASES[lower] ?? lower;
  return Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, c) ? c : null;
}

export function extFromFilename(n: string): string | null {
  const dot = n.lastIndexOf(".");
  if (dot === -1 || dot === n.length - 1) return null;
  return n.slice(dot + 1);
}

export function sanitizeFilename(name: string, fallback: string): string {
  let clean = name
    .replace(/\.\.+/g, "")
    .replace(/[/\\\x00-\x1f]/g, "")
    .trim();
  const enc = new TextEncoder();
  while (enc.encode(clean).length > 255 && clean.length > 0)
    clean = clean.slice(0, -1);
  return clean.length > 0 ? clean : fallback;
}

export function contentTypeHeader(t: AllowedType): string {
  return t.charset ? `${t.mime}; charset=${t.charset}` : t.mime;
}

export function encodeRFC5987(n: string): string {
  return encodeURIComponent(n).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function asciiFallback(n: string): string {
  return n.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
}

export type ParsedVersion =
  | { ok: true; version: number }
  | { ok: false; error: string };

export function parseVersionParam(raw: string): ParsedVersion {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return {
      ok: false,
      error: "Invalid version number — must be a positive integer",
    };
  }
  return { ok: true, version: n };
}
