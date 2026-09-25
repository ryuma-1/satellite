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
        },
      },
      { FLAG: "on", CREDS_PATH: "/secure/creds.json" },
    );

    expect(config.mcpServers.calendar).toEqual({
      command: "bunx",
      args: ["pkg", "--flag=on"],
      env: { CREDS: "/secure/creds.json", TOKEN: join(homedir(), ".config/satellite/t.json") },
      accounts: [],
    });
    expect(config.mcpServers.bare).toEqual({ command: "echo", args: [], env: {}, accounts: [] });
    expect(config.mcpServers.multi?.accounts).toEqual(["personal", "school"]);
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
      "accounts must be an array of names",
    );
    expect(() => parseMcpConfig({ mcpServers: { a: { command: "x", accounts: ["a", "a"] } } }, {})).toThrow(
      "accounts must not contain duplicates",
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
