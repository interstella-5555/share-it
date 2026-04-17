import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function pathForBlob(
  filesDir: string,
  id: string,
  version: number,
  ext: string,
): string {
  return join(
    filesDir,
    id.slice(0, 2),
    id.slice(2, 4),
    id,
    `v${version}.${ext}`,
  );
}

export async function writeBlob(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

export async function removeBlob(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function blobExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function unlinkBlob(
  filesDir: string,
  fileId: string,
  version: number,
  ext: string,
): Promise<void> {
  const path = pathForBlob(filesDir, fileId, version, ext);
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
