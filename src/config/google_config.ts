import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configDir, expandHome } from "./paths";

/**
 * A single named Google account: its nickname, plus any calendars/task lists beyond its own defaults.
 * A plain string in google_config.json's `accounts` array is shorthand for an account with no extras.
 */
export interface AccountConfig {
  /** Account nickname, used as the gws config directory name (`<configDir()>/gws/<name>/`). */
  name: string;
  /**
   * Additional calendar ids (e.g. sub or shared calendars) served alongside this account's primary calendar.
   * Calendars belong to the account they are shared with, so they are only ever queried through it.
   */
  calendarIds: string[];
  /**
   * Additional task list ids (beyond "@default") served alongside this account's default task list.
   */
  taskListIds: string[];
}

/**
 * Account nickname format accepted as a gws config directory name. Checked here so typos fail at startup.
 */
const ACCOUNT_NAME = /^[a-z0-9_-]{1,64}$/;

/**
 * Google Calendar's identifier for a user's own calendar. Rejected wherever extra calendar ids are configured,
 * because the default calendar is always queried anyway; listing it again would fetch its events twice.
 */
const PRIMARY_CALENDAR_ID = "primary";

/**
 * Google Tasks' identifier for a user's default task list. Rejected wherever extra task list ids are
 * configured, for the same reason PRIMARY_CALENDAR_ID is rejected in calendarIds.
 */
const DEFAULT_TASK_LIST_ID = "@default";

/**
 * Default argv prefix used to invoke gws, when google_config.json does not override `gwsCommand`.
 * `gwsCommand` exists so a directly installed binary can be used instead, to cut bunx's launch latency.
 */
export const DEFAULT_GWS_COMMAND = ["bunx", "@googleworkspace/cli@0.22.5"];

/**
 * Parsed contents of google_config.json (design_doc §7.1): the OAuth client to authenticate with, the
 * argv prefix used to invoke gws, and every named Google account satellite operates on.
 */
export interface GoogleConfig {
  /** Path to the downloaded Google Cloud OAuth client JSON (see loadOAuthClient). */
  oauthClientFile: string;
  /** Argv prefix used to invoke gws, e.g. ["bunx", "@googleworkspace/cli@0.22.5"]. */
  gwsCommand: string[];
  /** Every account satellite operates on. At least one is required (named-account mode is mandatory). */
  accounts: AccountConfig[];
}

/**
 * Returns the default location of google_config.json.
 */
export function defaultGoogleConfigPath(): string {
  return join(configDir(), "google_config.json");
}

/**
 * Reads and validates google_config.json.
 * Secrets stay in .env / the OAuth client file and are referenced from the config as ${VAR} (design_doc §4.1).
 */
export async function loadGoogleConfig(
  path: string = defaultGoogleConfigPath(),
  env: Record<string, string | undefined> = process.env,
): Promise<GoogleConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Google config not found: ${path} (copy google_config.json.example there)`);
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch (err) {
    throw new Error(`Failed to parse Google config ${path}: ${(err as Error).message}`);
  }

  return parseGoogleConfig(raw, env, path);
}

/**
 * Validates raw JSON and expands variables. Split from loadGoogleConfig so it can be tested without files.
 */
export function parseGoogleConfig(
  raw: unknown,
  env: Record<string, string | undefined>,
  source = "google_config.json",
): GoogleConfig {
  if (!isRecord(raw) || typeof raw.oauthClientFile !== "string") {
    throw new Error(`${source}: "oauthClientFile" must be a string`);
  }
  const oauthClientFile = expandValue(raw.oauthClientFile, env, `${source}.oauthClientFile`);

  const rawGwsCommand = raw.gwsCommand ?? DEFAULT_GWS_COMMAND;
  if (
    !Array.isArray(rawGwsCommand) ||
    rawGwsCommand.length === 0 ||
    !rawGwsCommand.every((c) => typeof c === "string")
  ) {
    throw new Error(`${source}.gwsCommand must be a non-empty array of strings`);
  }
  const gwsCommand = rawGwsCommand.map((c) => expandValue(c, env, `${source}.gwsCommand`));

  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) {
    // Named-account mode is mandatory (design decision in the implementation plan): there is no longer a
    // single-unnamed-account fallback, so at least one named account must always be configured.
    throw new Error(`${source}.accounts must be a non-empty array`);
  }
  const accounts = raw.accounts.map((a, i) => parseAccountConfig(a, `${source}.accounts[${i}]`));
  const invalidIndex = accounts.findIndex((a) => !ACCOUNT_NAME.test(a.name));
  if (invalidIndex !== -1) {
    throw new Error(`${source}.accounts[${invalidIndex}] must be a name matching ${ACCOUNT_NAME}`);
  }
  if (new Set(accounts.map((a) => a.name)).size !== accounts.length) {
    throw new Error(`${source}.accounts must not contain duplicate names`);
  }

  return { oauthClientFile, gwsCommand, accounts };
}

/**
 * Parses one `accounts` entry. A plain string is shorthand for an account with no extra calendars/task lists.
 */
function parseAccountConfig(raw: unknown, where: string): AccountConfig {
  if (typeof raw === "string") {
    return { name: raw, calendarIds: [], taskListIds: [] };
  }
  if (!isRecord(raw) || typeof raw.name !== "string") {
    throw new Error(`${where} must be a string or an object with a "name" string`);
  }
  return {
    name: raw.name,
    calendarIds: parseCalendarIds(raw.calendarIds, `${where}.calendarIds`),
    taskListIds: parseTaskListIds(raw.taskListIds, `${where}.taskListIds`),
  };
}

/**
 * Validates a list of "additional resource id" fields (calendarIds, taskListIds): a flat array of non-empty,
 * unique strings that must not include `defaultId`, since the default is always queried already and listing
 * it again would fetch it twice.
 */
function parseAdditionalIds(raw: unknown, where: string, defaultId: string): string[] {
  const ids = raw ?? [];
  if (!Array.isArray(ids) || !ids.every((c) => typeof c === "string" && c.length > 0)) {
    throw new Error(`${where} must be an array of non-empty strings`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${where} must not contain duplicates`);
  }
  if (ids.includes(defaultId)) {
    throw new Error(`${where} must not include "${defaultId}", which is always included already`);
  }
  return ids;
}

/**
 * Validates a calendarIds array.
 * Rejects "primary" because the default calendar is always queried already; listing it again would be redundant
 * and would fetch its events twice.
 */
function parseCalendarIds(raw: unknown, where: string): string[] {
  return parseAdditionalIds(raw, where, PRIMARY_CALENDAR_ID);
}

/**
 * Validates a taskListIds array (the tasks counterpart to calendarIds).
 * Rejects "@default" because the default task list is always queried already.
 */
function parseTaskListIds(raw: unknown, where: string): string[] {
  return parseAdditionalIds(raw, where, DEFAULT_TASK_LIST_ID);
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
 * OAuth client id/secret loaded from a Google Cloud Console credentials JSON file (see docs/spikes/gws-cli-0.22.5.md §3).
 */
export interface OAuthClient {
  /** OAuth 2.0 client id. */
  clientId: string;
  /** OAuth 2.0 client secret. */
  clientSecret: string;
}

/**
 * Reads and validates an OAuth client JSON file downloaded from Google Cloud Console.
 * The file's top-level key is "installed" for a Desktop-app client (the only shape observed in the spike);
 * "web" is also accepted defensively, since Google uses the same client_id/client_secret shape for it.
 */
export async function loadOAuthClient(path: string): Promise<OAuthClient> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`OAuth client file not found: ${path}`);
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch (err) {
    throw new Error(`Failed to parse OAuth client file ${path}: ${(err as Error).message}`);
  }

  if (!isRecord(raw)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const section = raw.installed ?? raw.web;
  if (!isRecord(section)) {
    throw new Error(`${path}: expected an "installed" or "web" object`);
  }
  const { client_id: clientId, client_secret: clientSecret } = section;
  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new Error(`${path}: "client_id"/"client_secret" must be strings`);
  }
  return { clientId, clientSecret };
}

/**
 * Returns `<configDir()>/gws/<account>/`, creating it (and enforcing 0700) if it does not exist yet.
 * File-backed keyrings (GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file) store the encryption key alongside the
 * encrypted token in this directory, so it must not be group/world-readable (docs/spikes/gws-cli-0.22.5.md §2).
 */
export async function accountConfigDir(account: string): Promise<string> {
  const dir = join(configDir(), "gws", account);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's `mode` is subject to the process umask, so enforce 0700 explicitly rather than relying on it.
  await chmod(dir, 0o700);
  return dir;
}

/**
 * Narrows unknown JSON values to plain objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
