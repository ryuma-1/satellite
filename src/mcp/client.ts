import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../config/mcp_config";

/**
 * Minimal surface adapters need from an MCP connection, so tests can substitute a fake.
 */
export interface McpToolCaller {
  /** Invokes a tool and returns its parsed result. Throws when the tool reports an error. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Shape of a tools/call result that parseToolResult inspects.
 */
interface ToolResultLike {
  // The SDK's result union includes a legacy { toolResult } variant; the index signature lets it through.
  [key: string]: unknown;
  content?: unknown;
  isError?: unknown;
  structuredContent?: unknown;
}

/**
 * Converts a raw tools/call result into a plain value.
 * Servers commonly return JSON as a text block, so text is JSON-parsed when possible.
 */
export function parseToolResult(toolName: string, result: ToolResultLike): unknown {
  const text = Array.isArray(result.content)
    ? result.content
        .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
    : "";

  if (result.isError === true) {
    throw new Error(`MCP tool "${toolName}" failed: ${text || "(no message)"}`);
  }

  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A live connection to an MCP server spawned over stdio for the lifetime of one CLI run (design_doc §1.4).
 */
export class McpConnection implements McpToolCaller {
  /**
   * Use McpConnection.connect() instead; the constructor assumes an already-connected client.
   */
  private constructor(private readonly client: Client) {}

  /**
   * Spawns the server process and completes the MCP initialize handshake.
   */
  static async connect(server: McpServerConfig): Promise<McpConnection> {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      // StdioClientTransport only inherits a small safe subset of the parent env by default,
      // so server-specific variables (credentials path, token path) must be passed explicitly.
      env: { ...getDefaultEnvironment(), ...server.env },
      // Server logs and auth prompts go to our stderr so failures are visible to the user.
      stderr: "inherit",
    });
    const client = new Client({ name: "satellite", version: "0.1.0" });
    await client.connect(transport);
    return new McpConnection(client);
  }

  /**
   * Calls a tool on the connected server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.client.callTool({ name, arguments: args });
    return parseToolResult(name, result);
  }

  /**
   * Closes the connection and terminates the server process.
   */
  async close(): Promise<void> {
    await this.client.close();
  }
}
