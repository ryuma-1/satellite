import { DEFAULT_CALENDAR_ID, GoogleCalendarAdapter } from "./adapters/google-calendar/adapter";
import { DEFAULT_TASK_LIST_ID, GoogleTasksAdapter } from "./adapters/google-tasks/adapter";
import { loadMcpConfig } from "./config/mcp_config";
import { createModel } from "./llm/model";
import { McpConnection } from "./mcp/client";
import { runAgent } from "./planning/agent";
import { createCalendarTools, resolveCalendarIds } from "./planning/calendar_tools";
import { buildSystemPrompt, resolveAccountCalendars } from "./planning/system_prompt";
import { createTaskTools, resolveTaskListIds } from "./planning/task_tools";

/**
 * Answers one natural-language request, letting the LLM call calendar and (when configured) task tools
 * as needed.
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
  // Tasks is entirely optional (docs/plans/implementation-plan-issue-3-google-tasks.md's 実装方針):
  // only connect when configured at all, and let a connect/auth failure here fail the whole run rather
  // than silently falling back to calendar-only.
  let tasksConnection: McpConnection | undefined;
  // Captured explicitly, rather than left to a bare try/finally, so a close failure below can be reported
  // *alongside* this instead of silently replacing it (a plain `throw` inside `finally` discards whatever
  // the try body threw).
  let bodyFailed = false;
  let bodyError: unknown;
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

    let tools = createCalendarTools(calendar, accountNames, calendarIds);
    let taskListIds: string[] = [];
    const tasksServer = config.mcpServers.tasks;
    if (tasksServer) {
      tasksConnection = await McpConnection.connect(tasksServer);
      taskListIds = resolveTaskListIds(tasksServer.taskListIds, DEFAULT_TASK_LIST_ID);
      const tasks = new GoogleTasksAdapter(tasksConnection, { taskListIds: tasksServer.taskListIds });
      tools = { ...tools, ...createTaskTools(tasks, taskListIds) };
    }

    const answer = runAgent({
      model,
      tools,
      instructions: buildSystemPrompt(new Date(), accountNames, calendarIds, undefined, accountCalendars, taskListIds),
      prompt: question,
      onToolError: (toolName, error) => {
        console.error(`[tool ${toolName}] ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    for await (const chunk of answer) {
      process.stdout.write(chunk);
    }
    process.stdout.write("\n");
  } catch (err) {
    bodyFailed = true;
    bodyError = err;
  }

  // Awaiting these sequentially would leave the tasks child process running forever if closing the
  // calendar connection rejects first; Promise.allSettled attempts both regardless of either failing.
  const closeResults = await Promise.allSettled([connection.close(), tasksConnection?.close()]);
  const closeFailures = closeResults.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  if (bodyFailed && closeFailures.length > 0) {
    // Neither error may be swallowed: the body's is the actual reason the run failed, and a close failure
    // hides a leaked MCP server process. AggregateError keeps the body's error primary (it is listed first
    // and drives the message) while still surfacing every close failure.
    throw new AggregateError(
      [bodyError, ...closeFailures.map((f) => f.reason)],
      `処理中にエラーが発生し，MCP接続のクローズにも失敗しました: ${describeError(bodyError)}`,
    );
  }
  if (bodyFailed) throw bodyError;
  if (closeFailures.length > 0) {
    // Swallowing a close failure would hide a leaked MCP server process, so surface it instead. Only
    // thrown here, on its own, when the try body itself succeeded.
    throw new Error(`MCP接続のクローズに失敗しました:\n${closeFailures.map((f) => describeError(f.reason)).join("\n")}`);
  }
}

/**
 * Renders an unknown thrown value as a single-line message, for embedding inside another error's message.
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  console.error("エラーが発生しました:", err);
  process.exit(1);
});
