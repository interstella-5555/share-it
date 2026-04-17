export function sha256Hex(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(data);
  return h.digest("hex");
}
