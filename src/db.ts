import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tryShortIdAtLength } from "./shortid";

export type KeyStatus = "active" | "inactive" | "suspended";

export interface ApiKeyRow {
  apiKey: string;
  status: KeyStatus;
  createdAt: number;
}

export interface ApiKeyWithStats extends ApiKeyRow {
  fileCount: number;
  versionCount: number;
}

export interface FileRow {
  id: string;
  shortId: string;
  apiKey: string | null;
  createdAt: number;
}

// Range used for the collision-extension retry on shortId insert. The
// first attempt uses 10; on a UNIQUE-constraint failure we grow by one
// char up to 16. At 16 chars collision is impossible in practice.
const SHORTID_MIN_LENGTH = 10;
const SHORTID_MAX_LENGTH = 16;

export interface VersionRow {
  fileId: string;
  version: number;
  hash: string;
  mime: string;
  ext: string;
  size: number;
  originalName: string;
  createdAt: number;
}

export interface FileListRow {
  id: string;
  shortId: string;
  originalName: string;
  latestVersion: number;
  size: number;
  lastUploadAt: number;
}

export interface AnalyticsTotals {
  views: number;
  uniqueDaily: number;
}
export interface AnalyticsPerDay {
  day: string;
  views: number;
  uniqueDaily: number;
}
export interface AnalyticsPerVersion {
  version: number;
  views: number;
  uniqueDaily: number;
}
export interface FileAnalytics {
  totals: AnalyticsTotals;
  perDay: AnalyticsPerDay[];
  perVersion: AnalyticsPerVersion[];
}

export class Db {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.bootstrap();
  }

  bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apiKeys (
        apiKey    TEXT PRIMARY KEY,
        status    TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','inactive','suspended')),
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        id        TEXT PRIMARY KEY,
        apiKey    TEXT,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (apiKey) REFERENCES apiKeys(apiKey)
      );
      CREATE TABLE IF NOT EXISTS versions (
        fileId       TEXT NOT NULL REFERENCES files(id),
        version      INTEGER NOT NULL,
        hash         TEXT NOT NULL,
        mime         TEXT NOT NULL,
        ext          TEXT NOT NULL,
        size         INTEGER NOT NULL,
        originalName TEXT NOT NULL,
        createdAt    INTEGER NOT NULL,
        PRIMARY KEY (fileId, version)
      );
      CREATE INDEX IF NOT EXISTS idx_versions_hash ON versions(fileId, hash);
      CREATE INDEX IF NOT EXISTS idx_files_apiKey  ON files(apiKey);
      CREATE TABLE IF NOT EXISTS viewUniques (
        fileId    TEXT    NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        version   INTEGER NOT NULL,
        day       TEXT    NOT NULL,
        ipHashDay TEXT    NOT NULL,
        PRIMARY KEY (fileId, version, day, ipHashDay)
      );
      CREATE INDEX IF NOT EXISTS idx_viewUniques_file_day
        ON viewUniques(fileId, day);
      CREATE TABLE IF NOT EXISTS viewCounters (
        fileId  TEXT    NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        day     TEXT    NOT NULL,
        views   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (fileId, version, day)
      );
      CREATE INDEX IF NOT EXISTS idx_viewCounters_file
        ON viewCounters(fileId);
    `);

    // Idempotent shortId migration. SQLite's ALTER TABLE has no "IF NOT
    // EXISTS" for columns, so we swallow the duplicate-column error on
    // re-runs. The UNIQUE index + backfill are already idempotent.
    try {
      this.db.run("ALTER TABLE files ADD COLUMN shortId TEXT");
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!msg.includes("duplicate column")) throw e;
    }
    this.db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_files_shortId ON files(shortId)",
    );

    this.backfillShortIds();
  }

  // Post-migration backfill: any files row that arrived before the
  // shortId column existed has a NULL shortId. Compute + set it here.
  // Idempotent — rows whose shortId is already set are skipped.
  backfillShortIds(): void {
    const rows = this.db
      .query<{ id: string }, []>("SELECT id FROM files WHERE shortId IS NULL")
      .all();
    if (rows.length === 0) return;
    this.transaction(() => {
      const update = this.db.query<unknown, [string, string]>(
        "UPDATE files SET shortId = ? WHERE id = ?",
      );
      for (const row of rows) {
        const shortId = this.findFreeShortId(row.id);
        update.run(shortId, row.id);
      }
    });
  }

  // Return a shortId for `uuid` that doesn't collide with an existing
  // row (excluding `uuid` itself, so re-running this for an already-
  // assigned row would still find its own value). Grows from 10 to 16
  // chars on each collision.
  private findFreeShortId(uuid: string): string {
    for (let len = SHORTID_MIN_LENGTH; len <= SHORTID_MAX_LENGTH; len++) {
      const candidate = tryShortIdAtLength(uuid, len);
      const existing = this.db
        .query<
          { id: string },
          [string]
        >("SELECT id FROM files WHERE shortId = ?")
        .get(candidate);
      if (existing === null || existing.id === uuid) return candidate;
    }
    // 16-char base62 space is ~4.8·10^28. Exhausting it means either a
    // catastrophic hash collision (practically impossible) or a bug.
    throw new Error(
      `shortId collision retries exhausted for uuid ${uuid} up to length ${SHORTID_MAX_LENGTH}`,
    );
  }

  insertApiKey(apiKey: string, status: KeyStatus): void {
    this.db
      .query("INSERT INTO apiKeys (apiKey, status, createdAt) VALUES (?, ?, ?)")
      .run(apiKey, status, Date.now());
  }
  getApiKey(apiKey: string): ApiKeyRow | null {
    return (
      this.db
        .query<
          ApiKeyRow,
          [string]
        >("SELECT apiKey, status, createdAt FROM apiKeys WHERE apiKey = ?")
        .get(apiKey) ?? null
    );
  }
  updateApiKeyStatus(apiKey: string, status: KeyStatus): void {
    this.db
      .query("UPDATE apiKeys SET status = ? WHERE apiKey = ?")
      .run(status, apiKey);
  }
  deleteApiKey(apiKey: string): void {
    this.db.query("DELETE FROM apiKeys WHERE apiKey = ?").run(apiKey);
  }
  listApiKeys(): ApiKeyWithStats[] {
    return this.db
      .query<ApiKeyWithStats, []>(
        `
      SELECT
        k.apiKey,
        k.status,
        k.createdAt,
        COUNT(DISTINCT f.id) AS fileCount,
        COUNT(v.version)     AS versionCount
      FROM apiKeys k
      LEFT JOIN files f    ON f.apiKey = k.apiKey
      LEFT JOIN versions v ON v.fileId = f.id
      GROUP BY k.apiKey
      ORDER BY k.createdAt ASC
    `,
      )
      .all();
  }
  getApiKeyWithStats(apiKey: string): ApiKeyWithStats | null {
    return (
      this.db
        .query<ApiKeyWithStats, [string]>(
          `
      SELECT
        k.apiKey,
        k.status,
        k.createdAt,
        COUNT(DISTINCT f.id) AS fileCount,
        COUNT(v.version)     AS versionCount
      FROM apiKeys k
      LEFT JOIN files f    ON f.apiKey = k.apiKey
      LEFT JOIN versions v ON v.fileId = f.id
      WHERE k.apiKey = ?
      GROUP BY k.apiKey
    `,
        )
        .get(apiKey) ?? null
    );
  }
  countFilesByApiKey(apiKey: string): number {
    const r = this.db
      .query<
        { n: number },
        [string]
      >("SELECT COUNT(*) AS n FROM files WHERE apiKey = ?")
      .get(apiKey);
    return r?.n ?? 0;
  }
  rotateApiKey(oldKey: string, newKey: string): number {
    const result = { transferred: 0 };
    this.transaction(() => {
      this.insertApiKey(newKey, "active");
      const upd = this.db
        .query("UPDATE files SET apiKey = ? WHERE apiKey = ?")
        .run(newKey, oldKey);
      result.transferred = Number(upd.changes ?? 0);
      this.deleteApiKey(oldKey);
    });
    return result.transferred;
  }

  insertFile(id: string, apiKey: string | null): void {
    // Compute a collision-free shortId up front. The UNIQUE index on
    // shortId is the authoritative guard: if a concurrent insert wins
    // the race, our INSERT throws and we retry at the next length.
    const insert = this.db.query<
      unknown,
      [string, string, string | null, number]
    >("INSERT INTO files (id, shortId, apiKey, createdAt) VALUES (?, ?, ?, ?)");
    const now = Date.now();
    for (let len = SHORTID_MIN_LENGTH; len <= SHORTID_MAX_LENGTH; len++) {
      const candidate = tryShortIdAtLength(id, len);
      try {
        insert.run(id, candidate, apiKey, now);
        return;
      } catch (e) {
        const msg = (e as Error).message ?? "";
        // UNIQUE constraint on shortId → try the next length. Any other
        // error (e.g. FK failure, UNIQUE on id) propagates.
        if (msg.includes("UNIQUE") && msg.includes("shortId")) continue;
        throw e;
      }
    }
    throw new Error(
      `shortId collision retries exhausted for uuid ${id} up to length ${SHORTID_MAX_LENGTH}`,
    );
  }
  getFile(id: string): FileRow | null {
    return (
      this.db
        .query<
          FileRow,
          [string]
        >("SELECT id, shortId, apiKey, createdAt FROM files WHERE id = ?")
        .get(id) ?? null
    );
  }
  getFileByShortId(shortId: string): FileRow | null {
    return (
      this.db
        .query<
          FileRow,
          [string]
        >("SELECT id, shortId, apiKey, createdAt FROM files WHERE shortId = ?")
        .get(shortId) ?? null
    );
  }

  insertVersion(r: VersionRow): void {
    this.db
      .query(
        `
      INSERT INTO versions (fileId, version, hash, mime, ext, size, originalName, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        r.fileId,
        r.version,
        r.hash,
        r.mime,
        r.ext,
        r.size,
        r.originalName,
        r.createdAt,
      );
  }
  getVersion(fileId: string, version: number): VersionRow | null {
    return (
      this.db
        .query<
          VersionRow,
          [string, number]
        >("SELECT fileId, version, hash, mime, ext, size, originalName, createdAt FROM versions WHERE fileId = ? AND version = ?")
        .get(fileId, version) ?? null
    );
  }
  getLatestVersion(fileId: string): VersionRow | null {
    return (
      this.db
        .query<
          VersionRow,
          [string]
        >("SELECT fileId, version, hash, mime, ext, size, originalName, createdAt FROM versions WHERE fileId = ? ORDER BY version DESC LIMIT 1")
        .get(fileId) ?? null
    );
  }
  maxVersion(fileId: string): number | null {
    const r = this.db
      .query<
        { v: number | null },
        [string]
      >("SELECT MAX(version) as v FROM versions WHERE fileId = ?")
      .get(fileId);
    return r?.v ?? null;
  }

  listFilesForApiKey(apiKey: string): FileListRow[] {
    return this.db
      .query<FileListRow, [string]>(
        `
      SELECT
        f.id                AS id,
        f.shortId           AS shortId,
        v.originalName      AS originalName,
        v.version           AS latestVersion,
        v.size              AS size,
        v.createdAt         AS lastUploadAt
      FROM files f
      INNER JOIN versions v ON v.fileId = f.id
        AND v.version = (SELECT MAX(version) FROM versions WHERE fileId = f.id)
      WHERE f.apiKey = ?
      ORDER BY v.createdAt DESC
    `,
      )
      .all(apiKey);
  }

  listVersionsForFile(fileId: string): { version: number; ext: string }[] {
    return this.db
      .query<
        { version: number; ext: string },
        [string]
      >("SELECT version, ext FROM versions WHERE fileId = ? ORDER BY version")
      .all(fileId);
  }

  deleteAllVersionsOfFile(fileId: string): void {
    this.db
      .query<unknown, [string]>("DELETE FROM versions WHERE fileId = ?")
      .run(fileId);
  }

  deleteOneVersion(fileId: string, version: number): { ext: string } | null {
    const row = this.db
      .query<
        { ext: string },
        [string, number]
      >("SELECT ext FROM versions WHERE fileId = ? AND version = ?")
      .get(fileId, version);
    if (row === null) return null;
    this.db
      .query<
        unknown,
        [string, number]
      >("DELETE FROM versions WHERE fileId = ? AND version = ?")
      .run(fileId, version);
    return { ext: row.ext };
  }

  deleteFileRow(fileId: string): void {
    this.db
      .query<unknown, [string]>("DELETE FROM files WHERE id = ?")
      .run(fileId);
  }

  recordView(
    fileId: string,
    version: number,
    day: string,
    ipHashDay: string,
  ): void {
    this.transaction(() => {
      this.db
        .query(
          `INSERT OR IGNORE INTO viewUniques (fileId, version, day, ipHashDay)
           VALUES (?, ?, ?, ?)`,
        )
        .run(fileId, version, day, ipHashDay);

      this.db
        .query(
          `INSERT INTO viewCounters (fileId, version, day, views)
           VALUES (?, ?, ?, 1)
           ON CONFLICT (fileId, version, day)
           DO UPDATE SET views = views + 1`,
        )
        .run(fileId, version, day);
    });
  }

  getFileAnalytics(fileId: string): FileAnalytics {
    const totals = this.db
      .query<AnalyticsTotals, [string, string]>(
        `SELECT
           COALESCE((SELECT SUM(views) FROM viewCounters WHERE fileId = ?), 0) AS views,
           (SELECT COUNT(DISTINCT day || '|' || ipHashDay)
              FROM viewUniques WHERE fileId = ?) AS uniqueDaily`,
      )
      .get(fileId, fileId)!;

    const perDay = this.db
      .query<AnalyticsPerDay, [string, string]>(
        `SELECT
           c.day                                                    AS day,
           SUM(c.views)                                             AS views,
           (SELECT COUNT(DISTINCT ipHashDay) FROM viewUniques u
            WHERE u.fileId = ? AND u.day = c.day)                   AS uniqueDaily
         FROM viewCounters c
         WHERE c.fileId = ?
         GROUP BY c.day
         ORDER BY c.day ASC`,
      )
      .all(fileId, fileId);

    const perVersion = this.db
      .query<AnalyticsPerVersion, [string, string]>(
        `SELECT
           c.version                                                AS version,
           SUM(c.views)                                             AS views,
           (SELECT COUNT(*) FROM viewUniques u
            WHERE u.fileId = ? AND u.version = c.version)           AS uniqueDaily
         FROM viewCounters c
         WHERE c.fileId = ?
         GROUP BY c.version
         ORDER BY c.version ASC`,
      )
      .all(fileId, fileId);

    return { totals, perDay, perVersion };
  }

  deleteAnalyticsForFile(fileId: string): void {
    this.transaction(() => {
      this.db.query("DELETE FROM viewCounters WHERE fileId = ?").run(fileId);
      this.db.query("DELETE FROM viewUniques  WHERE fileId = ?").run(fileId);
    });
  }

  deleteAnalyticsForVersion(fileId: string, version: number): void {
    this.transaction(() => {
      this.db
        .query("DELETE FROM viewCounters WHERE fileId = ? AND version = ?")
        .run(fileId, version);
      this.db
        .query("DELETE FROM viewUniques  WHERE fileId = ? AND version = ?")
        .run(fileId, version);
    });
  }

  listFileIdsByApiKey(apiKey: string): string[] {
    return this.db
      .query<{ id: string }, [string]>("SELECT id FROM files WHERE apiKey = ?")
      .all(apiKey)
      .map((r) => r.id);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  close(): void {
    this.db.close();
  }
}
