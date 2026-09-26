import { formatLocalDateTime } from "./datetime";

/**
 * An account's full calendar list (its default calendar plus its own extras), used to describe
 * multi-calendar accounts to the LLM. Defined locally, mirroring GoogleCalendarAccount, so this module
 * does not depend on config types.
 */
export interface AccountCalendars {
  /** Account nickname. */
  name: string;
  /** All calendar ids configured for this account, default first. */
  calendarIds: string[];
}

/**
 * Builds the per-account calendar lists consumed by buildSystemPrompt's `accountCalendars` parameter: each
 * account's default calendar plus its own extras, omitting accounts with none since there is then nothing
 * to disambiguate for that account. Extracted so the assembly is unit-tested directly, instead of only
 * reachable through main()'s wiring.
 * @param accounts Configured accounts, each with its own extra calendar ids.
 * @param defaultCalendarId Google Calendar's identifier for a user's own calendar (DEFAULT_CALENDAR_ID).
 */
export function resolveAccountCalendars(
  accounts: { name: string; calendarIds: string[] }[],
  defaultCalendarId: string,
): AccountCalendars[] {
  return accounts
    .filter((a) => a.calendarIds.length > 0)
    .map((a) => ({ name: a.name, calendarIds: [defaultCalendarId, ...a.calendarIds] }));
}

/**
 * Builds the system prompt (design_doc §6.2).
 * The current time is embedded up front because nearly every calendar request is relative ("tomorrow", "this week"),
 * and computing it via a tool round-trip would be wasteful.
 * @param calendarIds All configured calendar ids (including the default); used only in unnamed-account mode
 * (accounts is empty), and mentioned to the LLM only when there is more than one.
 * @param timeZone IANA zone name; injectable so tests do not depend on the host setting.
 * @param accountCalendars Per-account calendar lists; used only when accounts is non-empty. Accounts with just
 * their default calendar are omitted, since there is then nothing to disambiguate for that account.
 * @param taskListIds De-duplicated task lists (default plus configured extras); empty when the tasks server
 * is not configured at all, in which case task-related guidance is omitted entirely.
 */
export function buildSystemPrompt(
  now: Date,
  accounts: string[],
  calendarIds: string[] = [],
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
  accountCalendars: AccountCalendars[] = [],
  taskListIds: string[] = [],
): string {
  const weekday = now.toLocaleDateString("ja-JP", { weekday: "long", timeZone });
  const lines = [
    "あなたはユーザーのスケジュール管理を支援するアシスタントです．",
    `現在日時: ${formatLocalDateTime(now)}（${weekday}，タイムゾーン: ${timeZone}）`,
    "",
    "- カレンダーの情報が必要なときは，推測せずに必ずツールで取得してください．",
    "- ツールに渡す日時は，UTC オフセット付きの ISO 8601 形式で指定してください．",
    "- 予定の更新・削除では，list_events で取得した id と account を使ってください．",
    "- 回答は日本語で，簡潔にしてください．",
  ];
  if (accounts.length > 0) {
    lines.push(
      `- 利用できるアカウント: ${accounts.join(", ")}（予定の作成先を指定しない場合は ${accounts[0]}）`,
    );
    const withExtraCalendars = accountCalendars.filter((a) => a.calendarIds.length > 1);
    if (withExtraCalendars.length > 0) {
      const perAccount = withExtraCalendars.map((a) => `${a.name}: ${a.calendarIds.join(", ")}`);
      lines.push(`- 利用できるカレンダー: ${perAccount.join("，")}`);
    }
  } else if (calendarIds.length > 1) {
    lines.push(
      `- 利用できるカレンダー: ${calendarIds.join(", ")}（予定の作成先を指定しない場合は ${calendarIds[0]}）`,
    );
  }
  if (taskListIds.length > 0) {
    lines.push("- タスクの情報が必要なときは，list_tasks ツールで取得してください．");
    if (taskListIds.length > 1) {
      lines.push(`- 利用できるタスクリスト: ${taskListIds.join(", ")}`);
    }
  }
  return lines.join("\n");
}
