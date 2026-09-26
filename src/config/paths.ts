import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns the directory holding host-specific settings and token caches (design_doc §7.1).
 * SATELLITE_CONFIG_DIR allows tests and non-standard setups to relocate it.
 */
export function configDir(): string {
  return process.env.SATELLITE_CONFIG_DIR ?? join(homedir(), ".config", "satellite");
}

/**
 * Expands a leading "~" to the user's home directory.
 * Needed because MCP servers receive paths via env vars, where the shell never expands "~".
 */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
