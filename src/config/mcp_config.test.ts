import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, parseMcpConfig } from "./mcp_config";

describe("parseMcpConfig", () => {
  test("expands ${VAR} and leading ~, and fills defaults", () => {
    const config = parseMcpConfig(
      {
        mcpServers: {
          calendar: {
            command: "bunx",
            args: ["pkg", "--flag=${FLAG}"],
            env: { CREDS: "${CREDS_PATH}", TOKEN: "~/.config/satellite/t.json" },
          },
          bare: { command: "echo" },
          multi: { command: "bunx", accounts: ["personal", "school"] },
          calendars: { command: "bunx", calendarIds: ["work@example.com", "family@group.calendar.google.com"] },
          tasks: { command: "bunx", taskListIds: ["work-list-id"] },
        },
      },
      { FLAG: "on", CREDS_PATH: "/secure/creds.json" },
    );

    expect(config.mcpServers.calendar).toEqual({
      command: "bunx",
      args: ["pkg", "--flag=on"],
      env: { CREDS: "/secure/creds.json", TOKEN: join(homedir(), ".config/satellite/t.json") },
      accounts: [],
      calendarIds: [],
      taskListIds: [],
    });
    expect(config.mcpServers.bare).toEqual({
      command: "echo",
      args: [],
      env: {},
      accounts: [],
      calendarIds: [],
      taskListIds: [],
    });
    expect(config.mcpServers.multi?.accounts).toEqual([
      { name: "personal", calendarIds: [] },
      { name: "school", calendarIds: [] },
    ]);
    expect(config.mcpServers.calendars?.calendarIds).toEqual(["work@example.com", "family@group.calendar.google.com"]);
    expect(config.mcpServers.tasks?.taskListIds).toEqual(["work-list-id"]);
  });

  test("accepts an object account with its own calendarIds, alongside string shorthand accounts", () => {
    const config = parseMcpConfig(
      {
        mcpServers: {
          calendar: {
            command: "bunx",
            accounts: ["normal", { name: "school", calendarIds: ["nomura.laboratory@gmail.com"] }],
          },
        },
      },
      {},
    );

    expect(config.mcpServers.calendar?.accounts).toEqual([
      { name: "normal", calendarIds: [] },
      { name: "school", calendarIds: ["nomura.laboratory@gmail.com"] },
    ]);
    expect(config.mcpServers.calendar?.calendarIds).toEqual([]);
  });

  test("throws on undefined variables instead of substituting empty string", () => {
    const raw = { mcpServers: { calendar: { command: "x", env: { A: "${MISSING}" } } } };
    expect(() => parseMcpConfig(raw, {})).toThrow("environment variable MISSING is not set");
  });

  test("validates structure", () => {
    expect(() => parseMcpConfig({}, {})).toThrow('"mcpServers" must be an object');
    expect(() => parseMcpConfig({ mcpServers: { a: {} } }, {})).toThrow("command must be a string");
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", args: [1] } } }, {})).toThrow(
      "args must be an array of strings",
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", env: { K: 1 } } } }, {})).toThrow(
      "env must be an object of strings",
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", accounts: ["School"] } } }, {})).toThrow(
      "accounts[0] must be a name matching",
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", accounts: [{ calendarIds: [] }] } } }, {})).toThrow(
      'must be a string or an object with a "name" string',
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", accounts: ["a", "a"] } } }, {})).toThrow(
      "accounts must not contain duplicate names",
    );
    expect(() =>
      parseMcpConfig({ mcpServers: { a: { command: "x", accounts: ["a", { name: "a" }] } } }, {}),
    ).toThrow("accounts must not contain duplicate names");
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", calendarIds: [1] } } }, {})).toThrow(
      "calendarIds must be an array of non-empty strings",
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", calendarIds: [""] } } }, {})).toThrow(
      "calendarIds must be an array of non-empty strings",
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", calendarIds: ["c", "c"] } } }, {})).toThrow(
      "calendarIds must not contain duplicates",
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", calendarIds: ["primary"] } } }, {})).toThrow(
      'calendarIds must not include "primary"',
    );
    expect(() =>
      parseMcpConfig(
        { mcpServers: { a: { command: "x", accounts: [{ name: "school", calendarIds: ["primary"] }] } } },
        {},
      ),
    ).toThrow('accounts[0].calendarIds must not include "primary"');
    expect(() =>
      parseMcpConfig(
        {
          mcpServers: {
            a: {
              command: "x",
              accounts: ["personal", "school"],
              calendarIds: ["shared@example.com"],
            },
          },
        },
        {},
      ),
    ).toThrow("calendarIds must be empty once accounts are named");
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", taskListIds: [1] } } }, {})).toThrow(
      "taskListIds must be an array of non-empty strings",
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", taskListIds: [""] } } }, {})).toThrow(
      "taskListIds must be an array of non-empty strings",
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", taskListIds: ["t", "t"] } } }, {})).toThrow(
      "taskListIds must not contain duplicates",
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", taskListIds: ["@default"] } } }, {})).toThrow(
      'taskListIds must not include "@default"',
    );
  });
});

describe("loadMcpConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "satellite-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads a config file", async () => {
    const path = join(dir, "mcp_config.json");
    await Bun.write(path, JSON.stringify({ mcpServers: { calendar: { command: "bunx" } } }));
    const config = await loadMcpConfig(path, {});
    expect(config.mcpServers.calendar?.command).toBe("bunx");
  });

  test("reports missing file with its path", async () => {
    const path = join(dir, "absent.json");
    await expect(loadMcpConfig(path, {})).rejects.toThrow(`MCP config not found: ${path}`);
  });

  test("reports invalid JSON", async () => {
    const path = join(dir, "broken.json");
    await Bun.write(path, "{ not json");
    await expect(loadMcpConfig(path, {})).rejects.toThrow("Failed to parse MCP config");
  });
});
