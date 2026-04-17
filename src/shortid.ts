// Deterministic base62-encoded short ids for file UUIDs.
//
// shortId(uuid) = base62(sha256(lowercase(uuid)))[0 .. length]
//
// - sha256 of the canonical UUID string (hyphens included, lowercased).
// - base62 alphabet: 0-9A-Za-z.
// - Default length 10 (~8.4·10^17 combinations → birthday-safe).
// - On UNIQUE-index collision at the DB layer, the caller retries with
//   tryShortIdAtLength(uuid, len+1) up to len=16.
// - The sha256 32-byte buffer base62-encodes to ~43 chars, which bounds
//   the maximum retrievable length.

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = 62n;
const MAX_LENGTH = 43;

function base62EncodeBytes(bytes: Uint8Array): string {
  // interpret the whole buffer as a big-endian unsigned integer
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  if (n === 0n) return "0";
  let out = "";
  while (n > 0n) {
    const rem = n % BASE;
    n = n / BASE;
    out = ALPHABET[Number(rem)] + out;
  }
  return out;
}

function base62OfUuidHash(uuid: string): string {
  const canonical = uuid.toLowerCase();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  const digest = hasher.digest();
  // Bun returns a Buffer (subclass of Uint8Array). Treat as Uint8Array.
  const bytes =
    digest instanceof Uint8Array
      ? digest
      : new Uint8Array(digest as ArrayBuffer);
  return base62EncodeBytes(bytes);
}

export function shortIdFromUuid(uuid: string, length: number = 10): string {
  return tryShortIdAtLength(uuid, length);
}

export function tryShortIdAtLength(uuid: string, length: number): string {
  if (!Number.isInteger(length) || length < 1 || length > MAX_LENGTH) {
    throw new RangeError(
      `shortId length must be an integer in [1, ${MAX_LENGTH}]; got ${length}`,
    );
  }
  const full = base62OfUuidHash(uuid);
  // base62 of 32 bytes is typically 43 chars, but if leading bytes are
  // zero the encoding can be shorter. Pad on the left with '0' so the
  // prefix semantics are stable.
  const padded =
    full.length >= MAX_LENGTH ? full : full.padStart(MAX_LENGTH, "0");
  return padded.slice(0, length);
}
