import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../../src/db";
import { shortIdFromUuid } from "../../src/shortid";

const ID_A = "a1b2c3d4-5678-4abc-9def-000000000000";
const ID_B = "b2c3d4e5-6789-4abc-9def-111111111111";
const KEY_1 = "11111111-2222-4333-8444-555555555555";
const KEY_2 = "22222222-3333-4444-8555-666666666666";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "es-db-"));
  db = new Db(join(dir, "t.sqlite"));
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function v(overrides: any = {}) {
  return {
    fileId: ID_A,
    version: 1,
    hash: "a".repeat(64),
    mime: "text/plain",
    ext: "txt",
    size: 5,
    originalName: "hi.txt",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("apiKeys", () => {
  test("insert + get", () => {
    db.insertApiKey(KEY_1, "active");
    expect(db.getApiKey(KEY_1)).toEqual({
      apiKey: KEY_1,
      status: "active",
      createdAt: expect.any(Number),
    });
  });
  test("getApiKey null when missing", () =>
    expect(db.getApiKey(KEY_1)).toBeNull());
  test("unique (PK) prevents dup insert", () => {
    db.insertApiKey(KEY_1, "active");
    expect(() => db.insertApiKey(KEY_1, "active")).toThrow();
  });
  test("status CHECK rejects invalid", () => {
    expect(() => db.insertApiKey(KEY_1, "banned" as any)).toThrow();
  });
  test("updateApiKeyStatus", () => {
    db.insertApiKey(KEY_1, "active");
    db.updateApiKeyStatus(KEY_1, "inactive");
    expect(db.getApiKey(KEY_1)?.status).toBe("inactive");
  });
  test("listApiKeys returns all with stats", () => {
    db.insertApiKey(KEY_1, "active");
    db.insertApiKey(KEY_2, "suspended");
    const rows = db.listApiKeys();
    expect(rows).toHaveLength(2);
    const r1 = rows.find((r) => r.apiKey === KEY_1)!;
    expect(r1.status).toBe("active");
    expect(r1.fileCount).toBe(0);
    expect(r1.versionCount).toBe(0);
  });
  test("deleteApiKey removes row", () => {
    db.insertApiKey(KEY_1, "active");
    db.deleteApiKey(KEY_1);
    expect(db.getApiKey(KEY_1)).toBeNull();
  });
  test("FK: cannot insert files.apiKey for unknown key", () => {
    expect(() => db.insertFile(ID_A, KEY_1)).toThrow();
  });
});

describe("files + versions", () => {
  test("insertFile + getFile (null apiKey)", () => {
    db.insertFile(ID_A, null);
    expect(db.getFile(ID_A)?.apiKey).toBeNull();
  });
  test("insertFile with known apiKey", () => {
    db.insertApiKey(KEY_1, "active");
    db.insertFile(ID_A, KEY_1);
    expect(db.getFile(ID_A)?.apiKey).toBe(KEY_1);
  });
  test("insertVersion + getVersion", () => {
    db.insertFile(ID_A, null);
    db.insertVersion(v());
    expect(db.getVersion(ID_A, 1)).toMatchObject({
      fileId: ID_A,
      version: 1,
      hash: "a".repeat(64),
    });
  });
  test("getLatestVersion", () => {
    db.insertApiKey(KEY_1, "active");
    db.insertFile(ID_A, KEY_1);
    db.insertVersion(v({ version: 1 }));
    db.insertVersion(v({ version: 3, hash: "b".repeat(64) }));
    db.insertVersion(v({ version: 2, hash: "c".repeat(64) }));
    expect(db.getLatestVersion(ID_A)?.version).toBe(3);
  });
  test("maxVersion", () => {
    db.insertFile(ID_A, null);
    expect(db.maxVersion(ID_A)).toBeNull();
    db.insertVersion(v({ version: 5 }));
    expect(db.maxVersion(ID_A)).toBe(5);
  });
});

describe("stats", () => {
  test("fileCount + versionCount aggregate correctly", () => {
    db.insertApiKey(KEY_1, "active");
    db.insertFile(ID_A, KEY_1);
    db.insertFile(ID_B, KEY_1);
    db.insertVersion(v({ fileId: ID_A, version: 1 }));
    db.insertVersion(v({ fileId: ID_A, version: 2 }));
    db.insertVersion(v({ fileId: ID_B, version: 1 }));
    const row = db.listApiKeys().find((r) => r.apiKey === KEY_1)!;
    expect(row.fileCount).toBe(2);
    expect(row.versionCount).toBe(3);
  });
});

describe("transaction", () => {
  test("commits both inserts", () => {
    db.insertApiKey(KEY_1, "active");
    db.transaction(() => {
      db.insertFile(ID_A, KEY_1);
      db.insertVersion(v());
    });
    expect(db.getFile(ID_A)).not.toBeNull();
  });
  test("rolls back on throw", () => {
    db.insertApiKey(KEY_1, "active");
    expect(() =>
      db.transaction(() => {
        db.insertFile(ID_A, KEY_1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.getFile(ID_A)).toBeNull();
  });
});

describe("rotate", () => {
  test("transfers ownership and deletes old key", () => {
    db.insertApiKey(KEY_1, "active");
    db.insertFile(ID_A, KEY_1);
    db.insertVersion(v({ fileId: ID_A }));
    const n = db.rotateApiKey(KEY_1, KEY_2);
    expect(n).toBe(1);
    expect(db.getApiKey(KEY_1)).toBeNull();
    expect(db.getApiKey(KEY_2)?.status).toBe("active");
    expect(db.getFile(ID_A)?.apiKey).toBe(KEY_2);
  });
  test("0 files transferred when none", () => {
    db.insertApiKey(KEY_1, "active");
    expect(db.rotateApiKey(KEY_1, KEY_2)).toBe(0);
    expect(db.getApiKey(KEY_2)?.status).toBe("active");
  });
});

describe("shortId", () => {
  test("insertFile assigns a non-null shortId deterministic from uuid", () => {
    db.insertFile(ID_A, null);
    const row = db.getFile(ID_A);
    expect(row?.shortId).toBe(shortIdFromUuid(ID_A));
  });

  test("getFileByShortId returns the row; null for unknown shortId", () => {
    db.insertFile(ID_A, null);
    const shortId = db.getFile(ID_A)!.shortId;
    expect(db.getFileByShortId(shortId)?.id).toBe(ID_A);
    expect(db.getFileByShortId("zzzzzzzzzz")).toBeNull();
  });

  test("listFilesForApiKey rows carry shortId", () => {
    db.insertApiKey(KEY_1, "active");
    db.insertFile(ID_A, KEY_1);
    db.insertVersion(v({ fileId: ID_A }));
    const rows = db.listFilesForApiKey(KEY_1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shortId).toBe(shortIdFromUuid(ID_A));
  });

  test("backfill sets shortId for rows inserted with NULL shortId", async () => {
    // Re-open the same underlying DB file with raw SQLite to insert a
    // row whose shortId is NULL — simulating a pre-migration record.
    const dbPath = join(dir, "t.sqlite");
    db.close();
    const raw = new Database(dbPath);
    raw.run("PRAGMA foreign_keys = OFF");
    raw.run(
      "INSERT INTO files (id, shortId, apiKey, createdAt) VALUES (?, NULL, NULL, ?)",
      [ID_B, Date.now()],
    );
    raw.close();

    // Re-open through Db → constructor runs bootstrap → backfill runs.
    db = new Db(dbPath);
    const row = db.getFile(ID_B);
    expect(row?.shortId).toBe(shortIdFromUuid(ID_B));

    // Idempotency: running backfill a second time is a no-op.
    db.backfillShortIds();
    expect(db.getFile(ID_B)?.shortId).toBe(shortIdFromUuid(ID_B));
  });
});

describe("Db bootstrap — analytics tables", () => {
  let analyticsDir: string;
  let analyticsDbPath: string;
  beforeEach(async () => {
    analyticsDir = await mkdtemp(join(tmpdir(), "es-db-"));
    analyticsDbPath = join(analyticsDir, "db.sqlite");
  });
  afterEach(async () => {
    await rm(analyticsDir, { recursive: true, force: true });
  });

  test("creates viewUniques and viewCounters", () => {
    const analyticsDb = new Db(analyticsDbPath);
    const raw = (
      analyticsDb as unknown as {
        db: { query: <T>(sql: string) => { all: () => T[] } };
      }
    ).db;
    const tables = raw
      .query<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain("viewUniques");
    expect(tables).toContain("viewCounters");
    analyticsDb.close();
  });
});

describe("Db.recordView()", () => {
  let vdir: string;
  let vdb: Db;
  const FID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const DAY = "2026-04-18";
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);

  beforeEach(async () => {
    vdir = await mkdtemp(join(tmpdir(), "es-db-"));
    vdb = new Db(join(vdir, "db.sqlite"));
    vdb.insertFile(FID, null);
  });
  afterEach(async () => {
    vdb.close();
    await rm(vdir, { recursive: true, force: true });
  });

  function rawCounts() {
    const raw = (
      vdb as unknown as {
        db: {
          query: <T>(s: string) => { get: () => T | null };
        };
      }
    ).db;
    const u =
      raw.query<{ c: number }>("SELECT COUNT(*) AS c FROM viewUniques").get()
        ?.c ?? 0;
    const v =
      raw
        .query<{
          v: number;
        }>("SELECT COALESCE(SUM(views),0) AS v FROM viewCounters")
        .get()?.v ?? 0;
    return { u, v };
  }

  test("first call inserts unique row + counter=1", () => {
    vdb.recordView(FID, 1, DAY, HASH_A);
    expect(rawCounts()).toEqual({ u: 1, v: 1 });
  });

  test("same (file, version, day, ip) hit twice: unique stays 1, counter=2", () => {
    vdb.recordView(FID, 1, DAY, HASH_A);
    vdb.recordView(FID, 1, DAY, HASH_A);
    expect(rawCounts()).toEqual({ u: 1, v: 2 });
  });

  test("different ip same (file,version,day): unique=2, counter=2", () => {
    vdb.recordView(FID, 1, DAY, HASH_A);
    vdb.recordView(FID, 1, DAY, HASH_B);
    expect(rawCounts()).toEqual({ u: 2, v: 2 });
  });
});

describe("countFilesByApiKey", () => {
  test("returns 0 when no files, N otherwise", () => {
    db.insertApiKey(KEY_1, "active");
    expect(db.countFilesByApiKey(KEY_1)).toBe(0);
    db.insertFile(ID_A, KEY_1);
    expect(db.countFilesByApiKey(KEY_1)).toBe(1);
  });
});

describe("delete helpers", () => {
  const F1 = "11111111-1111-4111-8111-111111111111";
  const F2 = "22222222-2222-4222-8222-222222222222";
  const K1 = "33333333-3333-4333-8333-333333333333";

  test("listVersionsForFile returns ext+version per row", () => {
    db.insertFile(F1, null);
    db.insertVersion({
      fileId: F1,
      version: 1,
      hash: "h1",
      mime: "text/plain",
      ext: "txt",
      size: 3,
      originalName: "a.txt",
      createdAt: 1,
    });
    db.insertVersion({
      fileId: F1,
      version: 2,
      hash: "h2",
      mime: "text/plain",
      ext: "txt",
      size: 3,
      originalName: "a.txt",
      createdAt: 2,
    });
    expect(db.listVersionsForFile(F1)).toEqual([
      { version: 1, ext: "txt" },
      { version: 2, ext: "txt" },
    ]);
  });

  test("deleteAllVersionsOfFile removes all, keeps file row", () => {
    db.insertFile(F2, null);
    db.insertVersion({
      fileId: F2,
      version: 1,
      hash: "h",
      mime: "text/plain",
      ext: "txt",
      size: 1,
      originalName: "b.txt",
      createdAt: 1,
    });
    db.deleteAllVersionsOfFile(F2);
    expect(db.listVersionsForFile(F2)).toEqual([]);
    expect(db.getFile(F2)).not.toBeNull();
  });

  test("deleteOneVersion returns ext on delete, null if missing", () => {
    const F3 = "44444444-4444-4444-8444-444444444444";
    db.insertFile(F3, null);
    db.insertVersion({
      fileId: F3,
      version: 1,
      hash: "h",
      mime: "text/plain",
      ext: "txt",
      size: 1,
      originalName: "c.txt",
      createdAt: 1,
    });
    expect(db.deleteOneVersion(F3, 1)).toEqual({ ext: "txt" });
    expect(db.deleteOneVersion(F3, 1)).toBeNull();
  });

  test("deleteFileRow hard-deletes the files row", () => {
    const F4 = "55555555-5555-4555-8555-555555555555";
    db.insertFile(F4, null);
    db.deleteFileRow(F4);
    expect(db.getFile(F4)).toBeNull();
  });

  test("listFileIdsByApiKey returns matching ids only", () => {
    db.insertApiKey(K1, "active");
    const F5 = "66666666-6666-4666-8666-666666666666";
    const F6 = "77777777-7777-4777-8777-777777777777";
    const F7 = "88888888-8888-4888-8888-888888888888";
    db.insertFile(F5, K1);
    db.insertFile(F6, K1);
    db.insertFile(F7, null);
    expect(db.listFileIdsByApiKey(K1).sort()).toEqual([F5, F6].sort());
  });
});

describe("Db analytics cleanup", () => {
  let vdir: string;
  let vdb: Db;
  const FID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const HASH = "a".repeat(64);

  beforeEach(() => {
    vdir = mkdtempSync(join(tmpdir(), "es-db-"));
    vdb = new Db(join(vdir, "db.sqlite"));
    vdb.insertFile(FID, null);
    vdb.recordView(FID, 1, "2026-04-18", HASH);
    vdb.recordView(FID, 2, "2026-04-18", HASH);
  });
  afterEach(() => {
    vdb.close();
    rmSync(vdir, { recursive: true, force: true });
  });

  test("deleteAnalyticsForVersion removes only that version's rows", () => {
    vdb.deleteAnalyticsForVersion(FID, 1);
    const a = vdb.getFileAnalytics(FID);
    expect(a.perVersion.map((v) => v.version)).toEqual([2]);
    expect(a.totals.views).toBe(1);
  });

  test("deleteAnalyticsForFile clears both tables for that fileId", () => {
    vdb.deleteAnalyticsForFile(FID);
    const a = vdb.getFileAnalytics(FID);
    expect(a).toEqual({
      totals: { views: 0, uniqueDaily: 0 },
      perDay: [],
      perVersion: [],
    });
  });
});

describe("Db.getFileAnalytics()", () => {
  let vdir: string;
  let vdb: Db;
  const FID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);

  beforeEach(() => {
    vdir = mkdtempSync(join(tmpdir(), "es-db-"));
    vdb = new Db(join(vdir, "db.sqlite"));
    vdb.insertFile(FID, null);
  });
  afterEach(() => {
    vdb.close();
    rmSync(vdir, { recursive: true, force: true });
  });

  test("empty file → zeros and empty arrays", () => {
    const a = vdb.getFileAnalytics(FID);
    expect(a).toEqual({
      totals: { views: 0, uniqueDaily: 0 },
      perDay: [],
      perVersion: [],
    });
  });

  test("same user, one version, one day, 3 hits: views=3, uniqueDaily=1", () => {
    vdb.recordView(FID, 1, "2026-04-18", HASH_A);
    vdb.recordView(FID, 1, "2026-04-18", HASH_A);
    vdb.recordView(FID, 1, "2026-04-18", HASH_A);
    const a = vdb.getFileAnalytics(FID);
    expect(a.totals).toEqual({ views: 3, uniqueDaily: 1 });
    expect(a.perDay).toEqual([{ day: "2026-04-18", views: 3, uniqueDaily: 1 }]);
    expect(a.perVersion).toEqual([{ version: 1, views: 3, uniqueDaily: 1 }]);
  });

  test("option (ii): same user, v1 and v2 same day → totals.uniqueDaily=1", () => {
    vdb.recordView(FID, 1, "2026-04-18", HASH_A);
    vdb.recordView(FID, 2, "2026-04-18", HASH_A);
    const a = vdb.getFileAnalytics(FID);
    expect(a.totals).toEqual({ views: 2, uniqueDaily: 1 });
    expect(a.perDay).toEqual([{ day: "2026-04-18", views: 2, uniqueDaily: 1 }]);
    expect(a.perVersion).toEqual([
      { version: 1, views: 1, uniqueDaily: 1 },
      { version: 2, views: 1, uniqueDaily: 1 },
    ]);
  });

  test("different days → perDay has multiple entries", () => {
    vdb.recordView(FID, 1, "2026-04-17", HASH_A);
    vdb.recordView(FID, 1, "2026-04-18", HASH_A);
    const a = vdb.getFileAnalytics(FID);
    expect(a.totals).toEqual({ views: 2, uniqueDaily: 2 });
    expect(a.perDay).toEqual([
      { day: "2026-04-17", views: 1, uniqueDaily: 1 },
      { day: "2026-04-18", views: 1, uniqueDaily: 1 },
    ]);
  });

  test("two different users same day → uniqueDaily=2", () => {
    vdb.recordView(FID, 1, "2026-04-18", HASH_A);
    vdb.recordView(FID, 1, "2026-04-18", HASH_B);
    const a = vdb.getFileAnalytics(FID);
    expect(a.totals).toEqual({ views: 2, uniqueDaily: 2 });
  });
});
