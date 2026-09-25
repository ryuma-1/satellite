import { GoogleCalendarAdapter } from "../adapters/google-calendar/adapter";
import { loadMcpConfig } from "../config/mcp_config";
import { McpConnection } from "../mcp/client";

/**
 * Manual smoke test for the calendar MCP integration: lists events for the next N days.
 * Usage: bun run src/cli/calendar_check.ts [days=7]
 */
async function main() {
  const days = Number(process.argv[2] ?? 7);
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`日数は正の整数で指定してください（指定値: ${process.argv[2]}）`);
  }

  const config = await loadMcpConfig();
  const server = config.mcpServers.calendar;
  if (!server) {
    throw new Error('mcp_config.json に "calendar" サーバーの定義がありません');
  }

  const connection = await McpConnection.connect(server);
  try {
    const calendar = new GoogleCalendarAdapter(connection, { accounts: server.accounts });
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + days);

    const events = await calendar.listEvents({ from, to });
    if (events.length === 0) {
      console.log(`今後${days}日間の予定はありません`);
      return;
    }
    for (const e of events) {
      const when = e.allDay
        ? `${e.start.toLocaleDateString()} (終日)`
        : `${e.start.toLocaleString()} - ${e.end.toLocaleTimeString()}`;
      const account = e.account ? `[${e.account}] ` : "";
      console.log(`${when}  ${account}${e.title}${e.location ? ` @ ${e.location}` : ""}`);
    }
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error("エラーが発生しました:", err);
  process.exit(1);
});
