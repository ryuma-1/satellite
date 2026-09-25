import { join } from "node:path";
import { configDir, expandHome } from "./paths";

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
   * Account nicknames served by this server, in priority order (the first is the default for writes).
   * Empty when the server is used with a single, unnamed account.
   */
  accounts: string[];
}

/**
 * Account nickname format accepted by @cocal/google-calendar-mcp. Checked here so typos fail at startup.
 */
const ACCOUNT_NAME = /^[a-z0-9_-]{1,64}$/;

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

    const accounts = server.accounts ?? [];
    if (!Array.isArray(accounts) || !accounts.every((a) => typeof a === "string" && ACCOUNT_NAME.test(a))) {
      throw new Error(`${where}.accounts must be an array of names matching ${ACCOUNT_NAME}`);
    }
    if (new Set(accounts).size !== accounts.length) {
      throw new Error(`${where}.accounts must not contain duplicates`);
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
    };
  }

  return { mcpServers };
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
