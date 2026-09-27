import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGwsArgs,
  GwsError,
  GwsProcessRunner,
  gwsEnv,
  parseGwsOutput,
  toGwsError,
} from "./runner";

const FAKE_GWS = join(import.meta.dir, "fixtures", "fake-gws.ts");

describe("buildGwsArgs", () => {
  test("includes the path segments only when params/body are absent", () => {
    expect(buildGwsArgs({ path: ["calendar", "events", "list"] })).toEqual(["calendar", "events", "list"]);
  });

  test("adds --params and --json as JSON strings", () => {
    const args = buildGwsArgs({
      path: ["calendar", "events", "insert"],
      params: { calendarId: "primary", sendUpdates: "none" },
      body: { summary: "x" },
    });
    expect(args).toEqual([
      "calendar",
      "events",
      "insert",
      "--params",
      JSON.stringify({ calendarId: "primary", sendUpdates: "none" }),
      "--json",
      JSON.stringify({ summary: "x" }),
    ]);
  });

  test("adds --page-all and --page-limit when pageAll is set", () => {
    const args = buildGwsArgs({ path: ["tasks", "tasks", "list"] }, { pageAll: true });
    expect(args).toEqual(["tasks", "tasks", "list", "--page-all", "--page-limit", "50"]);
  });
});

describe("gwsEnv", () => {
  test("always sets the file keyring backend, never an OS keyring", () => {
    expect(gwsEnv({ configDir: "/dir", clientId: "id", clientSecret: "secret" })).toEqual({
      GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/dir",
      GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file",
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: "id",
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "secret",
    });
  });
});

describe("parseGwsOutput", () => {
  test("parses a single JSON value", () => {
    expect(parseGwsOutput('{"ok":true}\n')).toEqual([{ ok: true }]);
  });

  test("parses a pretty-printed, multi-line single JSON value (gws's default without --page-all)", () => {
    expect(parseGwsOutput('{\n  "ok": true,\n  "nested": {\n    "a": 1\n  }\n}\n')).toEqual([
      { ok: true, nested: { a: 1 } },
    ]);
  });

  test("returns an empty array for empty output", () => {
    expect(parseGwsOutput("")).toEqual([]);
    expect(parseGwsOutput("   \n")).toEqual([]);
  });

  test("parses NDJSON into one value per non-empty line", () => {
    expect(parseGwsOutput('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("ignores blank lines", () => {
    expect(parseGwsOutput('{"a":1}\n\n{"b":2}\n\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("throws with the offending line on malformed JSON", () => {
    expect(() => parseGwsOutput("not json")).toThrow(/failed to parse output line 0/);
  });
});

describe("toGwsError", () => {
  test("uses the error envelope's message when present", () => {
    const err = toGwsError(1, JSON.stringify({ error: { code: 404, message: "Not Found", reason: "notFound" } }), "", "normal");
    expect(err).toBeInstanceOf(GwsError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toBe("Not Found");
  });

  test("falls back to stderr when stdout has no envelope", () => {
    const err = toGwsError(5, "", "internal panic", "normal");
    expect(err.message).toBe("internal panic");
  });

  test("falls back to a generic message when neither is available", () => {
    const err = toGwsError(5, "", "", "normal");
    expect(err.message).toBe("gws exited with code 5");
  });

  test("appends auth guidance naming the account, only for exit code 2", () => {
    const authErr = toGwsError(2, JSON.stringify({ error: { message: "Access denied." } }), "", "school");
    expect(authErr.message).toContain("bun run src/cli/auth.ts school");

    const apiErr = toGwsError(1, JSON.stringify({ error: { message: "Not Found" } }), "", "school");
    expect(apiErr.message).not.toContain("auth.ts");
  });
});

describe("GwsProcessRunner", () => {
  let configDir: string;
  const originalConfigDir = process.env.SATELLITE_CONFIG_DIR;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "satellite-gws-runner-"));
    process.env.SATELLITE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.SATELLITE_CONFIG_DIR;
    else process.env.SATELLITE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  function runner(timeoutMs?: number): GwsProcessRunner {
    return new GwsProcessRunner({
      gwsCommand: ["bun", FAKE_GWS],
      oauthClient: { clientId: "id", clientSecret: "secret" },
      timeoutMs,
    });
  }

  test("call returns the parsed JSON response on success", async () => {
    const result = await runner().call("normal", { path: ["ok"] });
    expect(result).toMatchObject({ ok: true });
  });

  test("call parses gws's real pretty-printed, multi-line JSON output", async () => {
    const result = await runner().call("normal", { path: ["pretty"] });
    expect(result).toEqual({ ok: true });
  });

  test("call converts a non-zero exit into a GwsError", async () => {
    await expect(runner().call("normal", { path: ["apifail"] })).rejects.toThrow("Not Found");
  });

  test("call names the account in the auth-error guidance", async () => {
    await expect(runner().call("school", { path: ["authfail"] })).rejects.toThrow("bun run src/cli/auth.ts school");
  });

  test("call surfaces a validation error", async () => {
    await expect(runner().call("normal", { path: ["validationfail"] })).rejects.toThrow("Invalid --params JSON");
  });

  test("call surfaces a stderr-only failure", async () => {
    await expect(runner().call("normal", { path: ["stderr-only-failure"] })).rejects.toThrow("internal panic");
  });

  test("call fails loudly on malformed JSON output", async () => {
    await expect(runner().call("normal", { path: ["malformed"] })).rejects.toThrow(/failed to parse output/);
  });

  test("callAllPages merges every page's raw response in order", async () => {
    const pages = await runner().callAllPages("normal", {
      path: ["pages"],
      params: { count: 3, exhausted: true },
    });
    expect(pages).toEqual([
      { items: [{ id: "item-0" }], nextPageToken: "token-1" },
      { items: [{ id: "item-1" }], nextPageToken: "token-2" },
      { items: [{ id: "item-2" }] },
    ]);
  });

  test("callAllPages throws when the page limit is reached before Google exhausts results", async () => {
    await expect(
      runner().callAllPages("normal", { path: ["pages"], params: { count: 2, exhausted: false } }),
    ).rejects.toThrow(/page limit/);
  });

  test("ensures the account's gws config directory exists with 0700 permissions before calling", async () => {
    await runner().call("normal", { path: ["ok"] });
    const dir = join(configDir, "gws", "normal");
    const { stat } = await import("node:fs/promises");
    const info = await stat(dir);
    expect(info.mode & 0o777).toBe(0o700);
  });

  test("kills a call that exceeds its timeout and reports that it timed out", async () => {
    await expect(runner(100).call("normal", { path: ["slow"], params: { ms: 5000 } })).rejects.toThrow(/timed out/);
  });

  test("serializes calls to the same account on one runner instance, but runs different accounts concurrently", async () => {
    const shared = runner();
    const delayMs = 300;

    const sameAccountStart = Date.now();
    await Promise.all([
      shared.call("normal", { path: ["slow"], params: { ms: delayMs } }),
      shared.call("normal", { path: ["slow"], params: { ms: delayMs } }),
    ]);
    const sameAccountElapsed = Date.now() - sameAccountStart;

    const crossAccountStart = Date.now();
    await Promise.all([
      shared.call("normal", { path: ["slow"], params: { ms: delayMs } }),
      shared.call("school", { path: ["slow"], params: { ms: delayMs } }),
    ]);
    const crossAccountElapsed = Date.now() - crossAccountStart;

    // Two same-account calls run one after another (roughly 2x delayMs), while one of each account runs
    // side by side (roughly 1x delayMs); comparing the two relatively avoids depending on absolute spawn
    // overhead, which varies by machine.
    expect(sameAccountElapsed).toBeGreaterThan(crossAccountElapsed + delayMs * 0.5);
  }, DEFAULT_TEST_TIMEOUT_MS);
});

/** Generous bound for the cross-account parallelism smoke test above; not a precision timing assertion. */
const DEFAULT_TEST_TIMEOUT_MS = 10_000;
