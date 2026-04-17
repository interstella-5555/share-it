import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blobExists,
  pathForBlob,
  removeBlob,
  unlinkBlob,
  writeBlob,
} from "../../src/storage";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "es-storage-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ID = "a1b2c3d4-5678-4abc-9def-000000000000";

describe("pathForBlob", () => {
  test("two-level fanout", () => {
    expect(pathForBlob("/r", ID, 2, "html")).toBe(`/r/a1/b2/${ID}/v2.html`);
  });
});

describe("writeBlob", () => {
  test("creates parents and writes", async () => {
    const p = pathForBlob(dir, ID, 1, "txt");
    await writeBlob(p, new TextEncoder().encode("hello"));
    expect((await stat(p)).size).toBe(5);
  });
  test("overwrites", async () => {
    const p = pathForBlob(dir, ID, 1, "txt");
    await writeBlob(p, new TextEncoder().encode("hi"));
    await writeBlob(p, new TextEncoder().encode("hello"));
    expect((await stat(p)).size).toBe(5);
  });
});

describe("removeBlob", () => {
  test("removes existing", async () => {
    const p = pathForBlob(dir, ID, 1, "txt");
    await writeBlob(p, new Uint8Array([1]));
    await removeBlob(p);
    expect(await blobExists(p)).toBe(false);
  });
  test("no-op on missing", async () => {
    await removeBlob(join(dir, "nope.txt"));
  });
});

describe("blobExists", () => {
  test("true when present", async () => {
    const p = pathForBlob(dir, ID, 1, "txt");
    await writeBlob(p, new Uint8Array([1]));
    expect(await blobExists(p)).toBe(true);
  });
  test("false when missing", async () => {
    expect(await blobExists(join(dir, "x.txt"))).toBe(false);
  });
});

describe("unlinkBlob", () => {
  test("removes an existing blob", async () => {
    const p = pathForBlob(
      dir,
      "11111111-1111-1111-1111-111111111111",
      1,
      "txt",
    );
    await writeBlob(p, new Uint8Array([1, 2, 3]));
    await unlinkBlob(dir, "11111111-1111-1111-1111-111111111111", 1, "txt");
    await expect(stat(p)).rejects.toThrow();
  });
  test("tolerates missing blob (ENOENT)", async () => {
    await expect(
      unlinkBlob(dir, "22222222-2222-2222-2222-222222222222", 9, "txt"),
    ).resolves.toBeUndefined();
  });
});
