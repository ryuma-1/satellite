import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountConfigDir,
  DEFAULT_GWS_COMMAND,
  loadGoogleConfig,
  loadOAuthClient,
  parseGoogleConfig,
} from "./google_config";

describe("parseGoogleConfig", () => {
  test("expands ${VAR} and leading ~, and fills defaults", () => {
    const config = parseGoogleConfig(
      {
        oauthClientFile: "${CREDS_PATH}",
        accounts: ["normal"],
      },
      { CREDS_PATH: "/secure/creds.json" },
    );

    expect(config.oauthClientFile).toBe("/secure/creds.json");
    expect(config.gwsCommand).toEqual(DEFAULT_GWS_COMMAND);
    expect(config.accounts).toEqual([{ name: "normal", calendarIds: [], taskListIds: [] }]);
  });

  test("expands a leading ~ in oauthClientFile", () => {
    const config = parseGoogleConfig({ oauthClientFile: "~/creds.json", accounts: ["normal"] }, {});
    expect(config.oauthClientFile).toBe(join(homedir(), "creds.json"));
  });

  test("accepts an object account with its own calendarIds/taskListIds, alongside string shorthand accounts", () => {
    const config = parseGoogleConfig(
      {
        oauthClientFile: "/x.json",
        accounts: [
          "normal",
          { name: "school", calendarIds: ["shared@group.calendar.google.com"], taskListIds: ["work-list"] },
        ],
      },
      {},
    );

    expect(config.accounts).toEqual([
      { name: "normal", calendarIds: [], taskListIds: [] },
      { name: "school", calendarIds: ["shared@group.calendar.google.com"], taskListIds: ["work-list"] },
    ]);
  });

  test("accepts a custom gwsCommand, expanding each element", () => {
    const config = parseGoogleConfig(
      { oauthClientFile: "/x.json", gwsCommand: ["${GWS_BIN}"], accounts: ["normal"] },
      { GWS_BIN: "/usr/local/bin/gws" },
    );
    expect(config.gwsCommand).toEqual(["/usr/local/bin/gws"]);
  });

  test("throws on undefined variables instead of substituting empty string", () => {
    expect(() => parseGoogleConfig({ oauthClientFile: "${MISSING}", accounts: ["normal"] }, {})).toThrow(
      "environment variable MISSING is not set",
    );
  });

  test("validates structure", () => {
    expect(() => parseGoogleConfig({}, {})).toThrow('"oauthClientFile" must be a string');
    expect(() => parseGoogleConfig({ oauthClientFile: "/x.json" }, {})).toThrow("accounts must be a non-empty array");
    expect(() => parseGoogleConfig({ oauthClientFile: "/x.json", accounts: [] }, {})).toThrow(
      "accounts must be a non-empty array",
    );
    expect(() => parseGoogleConfig({ oauthClientFile: "/x.json", gwsCommand: [], accounts: ["a"] }, {})).toThrow(
      "gwsCommand must be a non-empty array of strings",
    );
    expect(() => parseGoogleConfig({ oauthClientFile: "/x.json", gwsCommand: [1], accounts: ["a"] }, {})).toThrow(
      "gwsCommand must be a non-empty array of strings",
    );
    expect(() => parseGoogleConfig({ oauthClientFile: "/x.json", accounts: ["School"] }, {})).toThrow(
      "accounts[0] must be a name matching",
    );
    expect(() => parseGoogleConfig({ oauthClientFile: "/x.json", accounts: [{ calendarIds: [] }] }, {})).toThrow(
      'must be a string or an object with a "name" string',
    );
    expect(() => parseGoogleConfig({ oauthClientFile: "/x.json", accounts: ["a", "a"] }, {})).toThrow(
      "accounts must not contain duplicate names",
    );
    expect(() => parseGoogleConfig({ oauthClientFile: "/x.json", accounts: ["a", { name: "a" }] }, {})).toThrow(
      "accounts must not contain duplicate names",
    );
    expect(() =>
      parseGoogleConfig({ oauthClientFile: "/x.json", accounts: [{ name: "a", calendarIds: [1] }] }, {}),
    ).toThrow("calendarIds must be an array of non-empty strings");
    expect(() =>
      parseGoogleConfig({ oauthClientFile: "/x.json", accounts: [{ name: "a", calendarIds: [""] }] }, {}),
    ).toThrow("calendarIds must be an array of non-empty strings");
    expect(() =>
      parseGoogleConfig({ oauthClientFile: "/x.json", accounts: [{ name: "a", calendarIds: ["c", "c"] }] }, {}),
    ).toThrow("calendarIds must not contain duplicates");
    expect(() =>
      parseGoogleConfig({ oauthClientFile: "/x.json", accounts: [{ name: "a", calendarIds: ["primary"] }] }, {}),
    ).toThrow('calendarIds must not include "primary"');
    expect(() =>
      parseGoogleConfig({ oauthClientFile: "/x.json", accounts: [{ name: "a", taskListIds: [1] }] }, {}),
    ).toThrow("taskListIds must be an array of non-empty strings");
    expect(() =>
      parseGoogleConfig({ oauthClientFile: "/x.json", accounts: [{ name: "a", taskListIds: ["t", "t"] }] }, {}),
    ).toThrow("taskListIds must not contain duplicates");
    expect(() =>
      parseGoogleConfig({ oauthClientFile: "/x.json", accounts: [{ name: "a", taskListIds: ["@default"] }] }, {}),
    ).toThrow('taskListIds must not include "@default"');
  });
});

describe("loadGoogleConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "satellite-google-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads a config file", async () => {
    const path = join(dir, "google_config.json");
    await Bun.write(path, JSON.stringify({ oauthClientFile: "/x.json", accounts: ["normal"] }));
    const config = await loadGoogleConfig(path, {});
    expect(config.accounts.map((a) => a.name)).toEqual(["normal"]);
  });

  test("reports missing file with its path", async () => {
    const path = join(dir, "absent.json");
    await expect(loadGoogleConfig(path, {})).rejects.toThrow(`Google config not found: ${path}`);
  });

  test("reports invalid JSON", async () => {
    const path = join(dir, "broken.json");
    await Bun.write(path, "{ not json");
    await expect(loadGoogleConfig(path, {})).rejects.toThrow("Failed to parse Google config");
  });
});

describe("loadOAuthClient", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "satellite-oauth-client-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads client_id/client_secret from an installed-app credentials file", async () => {
    const path = join(dir, "creds.json");
    await Bun.write(path, JSON.stringify({ installed: { client_id: "id-1", client_secret: "secret-1" } }));
    expect(await loadOAuthClient(path)).toEqual({ clientId: "id-1", clientSecret: "secret-1" });
  });

  test("falls back to a web-app credentials file", async () => {
    const path = join(dir, "creds.json");
    await Bun.write(path, JSON.stringify({ web: { client_id: "id-2", client_secret: "secret-2" } }));
    expect(await loadOAuthClient(path)).toEqual({ clientId: "id-2", clientSecret: "secret-2" });
  });

  test("reports a missing file with its path", async () => {
    const path = join(dir, "absent.json");
    await expect(loadOAuthClient(path)).rejects.toThrow(`OAuth client file not found: ${path}`);
  });

  test("reports invalid JSON", async () => {
    const path = join(dir, "broken.json");
    await Bun.write(path, "{ not json");
    await expect(loadOAuthClient(path)).rejects.toThrow("Failed to parse OAuth client file");
  });

  test("rejects a file without an installed/web section", async () => {
    const path = join(dir, "creds.json");
    await Bun.write(path, JSON.stringify({}));
    await expect(loadOAuthClient(path)).rejects.toThrow('expected an "installed" or "web" object');
  });

  test("rejects non-string client_id/client_secret", async () => {
    const path = join(dir, "creds.json");
    await Bun.write(path, JSON.stringify({ installed: { client_id: 1, client_secret: "s" } }));
    await expect(loadOAuthClient(path)).rejects.toThrow('"client_id"/"client_secret" must be strings');
  });
});

describe("accountConfigDir", () => {
  let dir: string;
  const originalConfigDir = process.env.SATELLITE_CONFIG_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "satellite-account-dir-"));
    process.env.SATELLITE_CONFIG_DIR = dir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.SATELLITE_CONFIG_DIR;
    else process.env.SATELLITE_CONFIG_DIR = originalConfigDir;
    await rm(dir, { recursive: true, force: true });
  });

  test("creates <configDir>/gws/<account> with 0700 permissions", async () => {
    const accountDir = await accountConfigDir("normal");
    expect(accountDir).toBe(join(dir, "gws", "normal"));
    const info = await stat(accountDir);
    expect(info.mode & 0o777).toBe(0o700);
  });

  test("is idempotent when the directory already exists", async () => {
    await accountConfigDir("normal");
    const accountDir = await accountConfigDir("normal");
    expect(accountDir).toBe(join(dir, "gws", "normal"));
  });
});
