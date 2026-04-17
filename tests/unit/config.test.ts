import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../../src/config";

const ORIGINAL_ENV = { ...process.env };
const ADMIN = "11111111-2222-4333-8444-555555555555";

function reset() {
  for (const k of [
    "PORT",
    "BASE_URL",
    "MAX_FILE_SIZE_MB",
    "DATA_DIR",
    "PROTECTED_MODE",
    "ADMIN_KEY",
  ]) {
    delete process.env[k];
  }
  process.env.BASE_URL = "https://example.com";
  process.env.ADMIN_KEY = ADMIN;
}

describe("loadConfig", () => {
  beforeEach(() => reset());
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("defaults PORT=3847", () => expect(loadConfig().port).toBe(3847));
  test("parses PORT", () => {
    process.env.PORT = "5000";
    expect(loadConfig().port).toBe(5000);
  });
  test("throws on bad PORT", () => {
    process.env.PORT = "x";
    expect(() => loadConfig()).toThrow(/PORT/);
  });

  test("defaults BASE_URL to http://localhost:PORT when unset", () => {
    delete process.env.BASE_URL;
    expect(loadConfig().baseUrl).toBe("http://localhost:3847");
  });
  test("default BASE_URL reflects custom PORT", () => {
    delete process.env.BASE_URL;
    process.env.PORT = "5000";
    expect(loadConfig().baseUrl).toBe("http://localhost:5000");
  });
  test("strips trailing slashes", () => {
    process.env.BASE_URL = "https://x.com///";
    expect(loadConfig().baseUrl).toBe("https://x.com");
  });

  test("defaults MAX_FILE_SIZE_MB=10 → 10MiB", () =>
    expect(loadConfig().maxFileSizeBytes).toBe(10 * 1024 * 1024));
  test("throws on bad MAX_FILE_SIZE_MB", () => {
    process.env.MAX_FILE_SIZE_MB = "-1";
    expect(() => loadConfig()).toThrow(/MAX_FILE_SIZE_MB/);
  });

  test("defaults DATA_DIR → ./data with derived db + files paths", () => {
    const c = loadConfig();
    expect(c.dataDir).toBe("./data");
    expect(c.dbPath).toBe("data/db.sqlite");
    expect(c.filesDir).toBe("data/files");
  });
  test("DATA_DIR override propagates to db + files paths", () => {
    process.env.DATA_DIR = "/var/share-it";
    const c = loadConfig();
    expect(c.dataDir).toBe("/var/share-it");
    expect(c.dbPath).toBe("/var/share-it/db.sqlite");
    expect(c.filesDir).toBe("/var/share-it/files");
  });

  test("defaults PROTECTED_MODE=true", () =>
    expect(loadConfig().protectedMode).toBe(true));
  test("parses PROTECTED_MODE=false", () => {
    process.env.PROTECTED_MODE = "false";
    expect(loadConfig().protectedMode).toBe(false);
  });
  test("parses PROTECTED_MODE=true", () => {
    process.env.PROTECTED_MODE = "true";
    expect(loadConfig().protectedMode).toBe(true);
  });
  test("throws on invalid PROTECTED_MODE", () => {
    process.env.PROTECTED_MODE = "maybe";
    expect(() => loadConfig()).toThrow(/PROTECTED_MODE/);
  });

  test("adminKey parsed", () => expect(loadConfig().adminKey).toBe(ADMIN));
  test("adminKey null when unset", () => {
    delete process.env.ADMIN_KEY;
    process.env.PROTECTED_MODE = "false";
    expect(loadConfig().adminKey).toBeNull();
  });
  test("throws on malformed ADMIN_KEY", () => {
    process.env.ADMIN_KEY = "nope";
    expect(() => loadConfig()).toThrow(/ADMIN_KEY/);
  });

  test("throws when PROTECTED_MODE=true and ADMIN_KEY missing", () => {
    delete process.env.ADMIN_KEY;
    expect(() => loadConfig()).toThrow(/PROTECTED_MODE/);
  });

  test("ok when PROTECTED_MODE=false and ADMIN_KEY missing", () => {
    delete process.env.ADMIN_KEY;
    process.env.PROTECTED_MODE = "false";
    const c = loadConfig();
    expect(c.protectedMode).toBe(false);
    expect(c.adminKey).toBeNull();
  });
});
