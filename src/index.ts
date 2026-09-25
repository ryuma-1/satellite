import { GoogleCalendarAdapter } from "./adapters/google-calendar/adapter";
import { loadMcpConfig } from "./config/mcp_config";
import { createModel } from "./llm/model";
import { McpConnection } from "./mcp/client";
import { runAgent } from "./planning/agent";
import { createCalendarTools } from "./planning/calendar_tools";
import { buildSystemPrompt } from "./planning/system_prompt";

/**
 * Answers one natural-language request, letting the LLM call calendar tools as needed.
 * Usage: bun run src/index.ts <request>
 */
async function main() {
  const question = process.argv.slice(2).join(" ");
  if (!question) {
    throw new Error("質問文を引数として指定してください（例: bun run src/index.ts 質問内容）");
  }

  // Validate local settings before spawning the MCP server, so misconfiguration fails fast.
  const model = createModel();
  const config = await loadMcpConfig();
  const server = config.mcpServers.calendar;
  if (!server) {
    throw new Error('mcp_config.json に "calendar" サーバーの定義がありません');
  }

  const connection = await McpConnection.connect(server);
  try {
    const calendar = new GoogleCalendarAdapter(connection, { accounts: server.accounts });
    const answer = runAgent({
      model,
      tools: createCalendarTools(calendar, server.accounts),
      instructions: buildSystemPrompt(new Date(), server.accounts),
      prompt: question,
      onToolError: (toolName, error) => {
        console.error(`[tool ${toolName}] ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    for await (const chunk of answer) {
      process.stdout.write(chunk);
    }
    process.stdout.write("\n");
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error("エラーが発生しました:", err);
  process.exit(1);
});
