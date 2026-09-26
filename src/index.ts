import { DEFAULT_CALENDAR_ID, GoogleCalendarAdapter } from "./adapters/google-calendar/adapter";
import { loadMcpConfig } from "./config/mcp_config";
import { createModel } from "./llm/model";
import { McpConnection } from "./mcp/client";
import { runAgent } from "./planning/agent";
import { createCalendarTools, resolveCalendarIds } from "./planning/calendar_tools";
import { buildSystemPrompt, resolveAccountCalendars } from "./planning/system_prompt";

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
    const accountNames = server.accounts.map((a) => a.name);
    // Union across accounts (plus the unnamed calendarIds, when there are no named accounts) so the LLM
    // is offered every calendar id it might see in list_events, regardless of which account owns it.
    const calendarIds = resolveCalendarIds(server.accounts, server.calendarIds, DEFAULT_CALENDAR_ID);
    const accountCalendars = resolveAccountCalendars(server.accounts, DEFAULT_CALENDAR_ID);
    const calendar = new GoogleCalendarAdapter(connection, {
      accounts: server.accounts,
      calendarIds: server.calendarIds,
    });
    const answer = runAgent({
      model,
      tools: createCalendarTools(calendar, accountNames, calendarIds),
      instructions: buildSystemPrompt(new Date(), accountNames, calendarIds, undefined, accountCalendars),
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
