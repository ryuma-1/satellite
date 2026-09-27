import { GoogleCalendarAdapter } from "../adapters/google-calendar/adapter";
import { loadGoogleConfig, loadOAuthClient } from "../config/google_config";
import { GwsProcessRunner } from "../gws/runner";

/**
 * Manual smoke test for the calendar gws integration: lists events for the next N days.
 * Usage: bun run src/cli/calendar_check.ts [days=7]
 */
async function main() {
  const days = Number(process.argv[2] ?? 7);
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`日数は正の整数で指定してください（指定値: ${process.argv[2]}）`);
  }

  const config = await loadGoogleConfig();
  const oauthClient = await loadOAuthClient(config.oauthClientFile);
  const runner = new GwsProcessRunner({ gwsCommand: config.gwsCommand, oauthClient });
  const calendar = new GoogleCalendarAdapter(runner, { accounts: config.accounts });

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
    const calendarId = e.calendarId ? `(${e.calendarId}) ` : "";
    console.log(`${when}  ${account}${calendarId}${e.title}${e.location ? ` @ ${e.location}` : ""}`);
  }
}

main().catch((err) => {
  console.error("エラーが発生しました:", err);
  process.exit(1);
});
