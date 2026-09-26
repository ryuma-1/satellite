import { join } from "node:path";
import { configDir, expandHome } from "./paths";

/**
 * A single account served by an MCP server: its nickname, plus any calendars beyond its own default one.
 * A plain string in mcp_config.json's `accounts` array is shorthand for `{ name, calendarIds: [] }`.
 */
export interface AccountConfig {
  /** Account nickname, matching the one registered on the MCP server (e.g. via `auth <nickname>`). */
  name: string;
  /**
   * Additional calendar ids (e.g. sub or shared calendars) served alongside this account's default calendar.
   * Empty when only the default calendar is used. Calendars belong to the account they are shared with,
   * so they cannot be queried through a different account.
   */
  calendarIds: string[];
}

/**
 * Launch settings for a single MCP server, after variable expansion.
 */
export interface McpServerConfig {
  /** Executable to spawn (e.g. "bunx"). */
  command: string;
  /** Arguments passed to the executable. */
  args: string[];
  /** Extra environment variables for the server process. */
  env: Record<string, string>;
  /**
   * Accounts served by this server, in priority order (the first is the default account for writes).
   * Empty when the server is used with a single, unnamed account (see `calendarIds` below).
   */
  accounts: AccountConfig[];
  /**
   * Additional calendar ids for the server's single unnamed account. Only meaningful (and only accepted
   * at parse time) when `accounts` is empty; once accounts are named, each owns its calendars instead.
   */
  calendarIds: string[];
}

/**
 * Account nickname format accepted by @cocal/google-calendar-mcp. Checked here so typos fail at startup.
 */
const ACCOUNT_NAME = /^[a-z0-9_-]{1,64}$/;

/**
 * Google Calendar's identifier for a user's own calendar. Rejected wherever extra calendar ids are configured,
 * because the default calendar is always queried anyway; listing it again would fetch its events twice.
 */
const PRIMARY_CALENDAR_ID = "primary";

/**
 * Parsed contents of mcp_config.json, keyed by service kind (e.g. "calendar").
 */
export interface McpConfig {
  /** Server definitions keyed by service kind. */
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Returns the default location of mcp_config.json.
 */
export function defaultMcpConfigPath(): string {
  return join(configDir(), "mcp_config.json");
}

/**
 * Reads and validates mcp_config.json.
 * Secrets stay in .env and are referenced from the config as ${VAR} (design_doc §4.1).
 */
export async function loadMcpConfig(
  path: string = defaultMcpConfigPath(),
  env: Record<string, string | undefined> = process.env,
): Promise<McpConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`MCP config not found: ${path} (copy mcp_config.json.example there)`);
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch (err) {
    throw new Error(`Failed to parse MCP config ${path}: ${(err as Error).message}`);
  }

  return parseMcpConfig(raw, env, path);
}

/**
 * Validates raw JSON and expands variables. Split from loadMcpConfig so it can be tested without files.
 */
export function parseMcpConfig(
  raw: unknown,
  env: Record<string, string | undefined>,
  source = "mcp_config.json",
): McpConfig {
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) {
    throw new Error(`${source}: "mcpServers" must be an object`);
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(raw.mcpServers)) {
    const where = `${source}: mcpServers.${name}`;
    if (!isRecord(server) || typeof server.command !== "string") {
      throw new Error(`${where}.command must be a string`);
    }

    const args = server.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      throw new Error(`${where}.args must be an array of strings`);
    }

    const serverEnv = server.env ?? {};
    if (!isRecord(serverEnv) || !Object.values(serverEnv).every((v) => typeof v === "string")) {
      throw new Error(`${where}.env must be an object of strings`);
    }

    const rawAccounts = server.accounts ?? [];
    if (!Array.isArray(rawAccounts)) {
      throw new Error(`${where}.accounts must be an array`);
    }
    const accounts = rawAccounts.map((a, i) => parseAccountConfig(a, `${where}.accounts[${i}]`));
    const invalidIndex = accounts.findIndex((a) => !ACCOUNT_NAME.test(a.name));
    if (invalidIndex !== -1) {
      throw new Error(`${where}.accounts[${invalidIndex}] must be a name matching ${ACCOUNT_NAME}`);
    }
    if (new Set(accounts.map((a) => a.name)).size !== accounts.length) {
      throw new Error(`${where}.accounts must not contain duplicate names`);
    }

    const calendarIds = parseCalendarIds(server.calendarIds, `${where}.calendarIds`);
    // calendarIds belongs to whichever single account is implicit; once accounts are named, it is ambiguous
    // which one it was meant for, so the caller must move it under the owning account instead.
    if (accounts.length > 0 && calendarIds.length > 0) {
      throw new Error(
        `${where}.calendarIds must be empty once accounts are named; ` +
          `move each id under its owning account (${where}.accounts[].calendarIds)`,
      );
    }

    mcpServers[name] = {
      command: server.command,
      args: args.map((a) => expandValue(a, env, `${where}.args`)),
      env: Object.fromEntries(
        Object.entries(serverEnv as Record<string, string>).map(([k, v]) => [
          k,
          expandValue(v, env, `${where}.env.${k}`),
        ]),
      ),
      accounts,
      calendarIds,
    };
  }

  return { mcpServers };
}

/**
 * Parses one `accounts` entry. A plain string is shorthand for an account with no extra calendars,
 * so existing configs (accounts as string[]) keep working unchanged.
 */
function parseAccountConfig(raw: unknown, where: string): AccountConfig {
  if (typeof raw === "string") {
    return { name: raw, calendarIds: [] };
  }
  if (!isRecord(raw) || typeof raw.name !== "string") {
    throw new Error(`${where} must be a string or an object with a "name" string`);
  }
  return { name: raw.name, calendarIds: parseCalendarIds(raw.calendarIds, `${where}.calendarIds`) };
}

/**
 * Validates a calendarIds array (used for both the top-level and per-account fields).
 * Rejects "primary" because the default calendar is always queried already; listing it again would be redundant
 * and would fetch its events twice.
 */
function parseCalendarIds(raw: unknown, where: string): string[] {
  const calendarIds = raw ?? [];
  if (!Array.isArray(calendarIds) || !calendarIds.every((c) => typeof c === "string" && c.length > 0)) {
    throw new Error(`${where} must be an array of non-empty strings`);
  }
  if (new Set(calendarIds).size !== calendarIds.length) {
    throw new Error(`${where} must not contain duplicates`);
  }
  if (calendarIds.includes(PRIMARY_CALENDAR_ID)) {
    throw new Error(`${where} must not include "${PRIMARY_CALENDAR_ID}", which is always included already`);
  }
  return calendarIds;
}

/**
 * Substitutes ${VAR} references and a leading "~".
 * Undefined variables are an error, because silently passing "" would surface later as a confusing auth failure.
 */
function expandValue(value: string, env: Record<string, string | undefined>, where: string): string {
  const substituted = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new Error(`${where}: environment variable ${name} is not set`);
    }
    return resolved;
  });
  return expandHome(substituted);
}

/**
 * Narrows unknown JSON values to plain objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
