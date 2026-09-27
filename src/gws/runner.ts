import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { accountConfigDir } from "../config/google_config";
import { configDir } from "../config/paths";

/**
 * One gws invocation: `gws <path...> [--params <JSON>] [--json <JSON>]` (docs/spikes/gws-cli-0.22.5.md §1).
 */
export interface GwsRequest {
  /** Positional path segments, e.g. ["calendar", "events", "list"] or ["tasks", "tasks", "list"]. */
  path: string[];
  /** `--params` JSON: URL/query parameters. */
  params?: Record<string, unknown>;
  /** `--json` JSON: request body, for insert/patch/update calls. */
  body?: Record<string, unknown>;
}

/**
 * Number of pages requested per `callAllPages` call via `--page-limit`. Chosen generously (design decision in
 * the implementation plan) so ordinary result sets never hit the limit; hitting it becomes an error instead of
 * a silent truncation (see parseGwsPages/callAllPages).
 */
export const PAGE_LIMIT = 50;

/**
 * Upper bound on how long a single gws invocation may run before it is killed, to avoid an auth prompt or a
 * hung network call blocking the whole CLI run forever.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Minimal surface adapters need to invoke gws, so tests can substitute a fake implementation.
 */
export interface GwsCaller {
  /** Runs one gws call and returns its parsed JSON response. */
  call(account: string, req: GwsRequest): Promise<unknown>;
  /**
   * Runs one gws call with `--page-all`, returning every page's parsed JSON response (Google's own list
   * envelope, e.g. `{ items: [...], nextPageToken?: ... }`) in order. Throws if the page limit is reached
   * before Google itself reports no further pages, rather than silently returning a truncated result.
   */
  callAllPages(account: string, req: GwsRequest): Promise<unknown[]>;
}

/**
 * Error raised when a gws invocation exits non-zero, carrying the exit code so callers (and toGwsError's
 * account-specific auth guidance) can react to it.
 */
export class GwsError extends Error {
  constructor(
    message: string,
    /** gws's documented exit code (docs/spikes/gws-cli-0.22.5.md §1): 1 API, 2 auth, 3 validation, 4
     * discovery, 5 internal. */
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "GwsError";
  }
}

/**
 * Shape of the `{"error": {...}}` envelope gws prints to stdout on failure (docs/spikes/gws-cli-0.22.5.md §7).
 */
interface GwsErrorEnvelope {
  error?: { code?: unknown; message?: unknown; reason?: unknown };
}

/**
 * Builds the argv (excluding the gws command itself) for one gws invocation.
 * Pure so its shape can be unit-tested without spawning a process.
 */
export function buildGwsArgs(req: GwsRequest, options: { pageAll?: boolean } = {}): string[] {
  const args = [...req.path];
  if (req.params !== undefined) args.push("--params", JSON.stringify(req.params));
  if (req.body !== undefined) args.push("--json", JSON.stringify(req.body));
  if (options.pageAll) args.push("--page-all", "--page-limit", String(PAGE_LIMIT));
  return args;
}

/**
 * Environment gws needs to authenticate as `account`, using the file keyring backend so no OS keyring entry
 * is ever created (docs/spikes/gws-cli-0.22.5.md §2). Shared by the runner and `bun run src/cli/auth.ts`, so
 * both always authenticate identically.
 */
export function gwsEnv(config: {
  /** `<configDir()>/gws/<account>/`, from google_config.ts's accountConfigDir. */
  configDir: string;
  /** OAuth client id/secret loaded via google_config.ts's loadOAuthClient. */
  clientId: string;
  clientSecret: string;
}): Record<string, string> {
  return {
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: config.configDir,
    GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file",
    GOOGLE_WORKSPACE_CLI_CLIENT_ID: config.clientId,
    GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: config.clientSecret,
  };
}

/**
 * Parses gws's stdout into one value per page.
 * Without `--page-all`, gws pretty-prints a single JSON value across multiple lines, so the whole output is
 * tried as one JSON document first. `--page-all` instead prints NDJSON (one compact JSON object per line,
 * docs/spikes/gws-cli-0.22.5.md §5), which is not valid JSON as a whole (multiple top-level values
 * concatenated), so that case falls back to parsing line by line.
 * Pure so it can be unit-tested without spawning a process.
 */
export function parseGwsOutput(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  try {
    return [JSON.parse(trimmed)];
  } catch {
    // Fall through to NDJSON parsing below.
  }

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`gws: failed to parse output line ${i}: ${(err as Error).message}\nline: ${line}`);
    }
  });
}

/**
 * Converts a non-zero gws exit into a GwsError, using the `{"error": {...}}` envelope on stdout when present
 * (docs/spikes/gws-cli-0.22.5.md §7). Falls back to stderr, then a generic message, since gws does not
 * guarantee the envelope for every failure mode (e.g. a crash before argument parsing).
 * @param account Account the call targeted, only used to build the auth-error guidance message below.
 */
export function toGwsError(exitCode: number, stdout: string, stderr: string, account: string): GwsError {
  const envelope = tryParseErrorEnvelope(stdout);
  const apiMessage = typeof envelope?.error?.message === "string" ? envelope.error.message : undefined;
  const message = apiMessage ?? (stderr.trim() || `gws exited with code ${exitCode}`);

  if (exitCode === 2) {
    // Auth errors are the one case worth guiding the user out of, rather than just surfacing gws's own
    // message: re-running `gws auth login` directly would use the wrong env (see gwsEnv), so point at the
    // wrapper that sets it up identically to the runtime.
    return new GwsError(`${message}\nAccount "${account}" is not authenticated; run: bun run src/cli/auth.ts ${account}`, exitCode);
  }
  return new GwsError(message, exitCode);
}

/**
 * Attempts to read gws's `{"error": {...}}` envelope from stdout; returns undefined for anything else
 * (malformed JSON, a different shape, empty output), since toGwsError must never throw itself.
 */
function tryParseErrorEnvelope(stdout: string): GwsErrorEnvelope | undefined {
  try {
    const parsed = JSON.parse(stdout.trim());
    return isRecord(parsed) ? (parsed as GwsErrorEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Narrows unknown JSON values to plain objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Directory gws is spawned from. Deliberately outside the project and the user's home directory root: a
 * successful `events.delete` writes a stray, empty "download.html" into gws's cwd, because Google's empty
 * DELETE response body is treated as a binary download (docs/spikes/gws-cli-0.22.5.md §8). Spawning from a
 * dedicated scratch directory contains that side effect instead of littering wherever satellite was run from.
 */
async function gwsCwd(): Promise<string> {
  const dir = join(configDir(), "gws-cwd");
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * GwsCaller backed by spawning the real `gws` CLI once per call (design_doc §1.4: no persistent server
 * process). Calls to the same account are serialized, since gws's file-backed keyring is not proven safe
 * for concurrent access from the same account's config directory.
 */
export class GwsProcessRunner implements GwsCaller {
  /** Tail of the serialization chain for each account, so same-account calls never overlap. */
  private readonly queues = new Map<string, Promise<unknown>>();

  /**
   * @param options.gwsCommand Argv prefix used to invoke gws (google_config.json's `gwsCommand`).
   * @param options.oauthClient OAuth client id/secret, loaded once via google_config.ts's loadOAuthClient.
   * @param options.timeoutMs Per-call timeout; defaults to DEFAULT_TIMEOUT_MS.
   */
  constructor(
    private readonly options: {
      gwsCommand: string[];
      oauthClient: { clientId: string; clientSecret: string };
      timeoutMs?: number;
    },
  ) {}

  /** @inheritdoc */
  async call(account: string, req: GwsRequest): Promise<unknown> {
    return this.enqueue(account, async () => {
      const { stdout, stderr, exitCode } = await this.spawn(account, buildGwsArgs(req));
      if (exitCode !== 0) throw toGwsError(exitCode, stdout, stderr, account);
      const [result] = parseGwsOutput(stdout);
      return result;
    });
  }

  /** @inheritdoc */
  async callAllPages(account: string, req: GwsRequest): Promise<unknown[]> {
    return this.enqueue(account, async () => {
      const { stdout, stderr, exitCode } = await this.spawn(account, buildGwsArgs(req, { pageAll: true }));
      if (exitCode !== 0) throw toGwsError(exitCode, stdout, stderr, account);
      const pages = parseGwsOutput(stdout);
      const last = pages[pages.length - 1];
      if (isRecord(last) && typeof last.nextPageToken === "string" && last.nextPageToken.length > 0) {
        // A remaining nextPageToken on the last emitted page means --page-limit was hit before Google ran
        // out of pages (docs/spikes/gws-cli-0.22.5.md §5); returning what we have would silently drop results.
        throw new GwsError(
          `gws hit its page limit (${PAGE_LIMIT}) for account "${account}" before exhausting results: ${JSON.stringify(req.path)}`,
          5,
        );
      }
      return pages;
    }) as Promise<unknown[]>;
  }

  /**
   * Chains `fn` onto the given account's queue, so calls to the same account never run concurrently, while
   * calls to different accounts still run in parallel (fan_out.ts relies on this).
   */
  private async enqueue<T>(account: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(account) ?? Promise.resolve();
    // Chain onto `prior` regardless of whether it resolved or rejected, so one account's failure never
    // blocks its later calls; store a version that never rejects, purely to keep the chain alive.
    const settled = prior.then(
      () => {},
      () => {},
    );
    const next = settled.then(fn);
    this.queues.set(account, next.catch(() => {}));
    return next;
  }

  /**
   * Spawns gws for one call, with stdin closed (never expects interactive input) and a hard timeout so a
   * hung process cannot block the CLI run forever.
   */
  private async spawn(
    account: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const dir = await accountConfigDir(account);
    const env = gwsEnv({ configDir: dir, clientId: this.options.oauthClient.clientId, clientSecret: this.options.oauthClient.clientSecret });
    const proc = Bun.spawn([...this.options.gwsCommand, ...args], {
      cwd: await gwsCwd(),
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (timedOut) {
        // Report the timeout explicitly, rather than letting the caller see it as an opaque non-zero exit
        // from being killed (its exit code/message reveal nothing about why gws stopped responding).
        throw new GwsError(`gws timed out after ${timeoutMs}ms for account "${account}": ${JSON.stringify(args)}`, 5);
      }
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
  }
}
