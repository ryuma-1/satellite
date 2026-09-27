import type { SkillMeta } from "../skills/registry";
import { formatLocalDateTime } from "./datetime";
import type { AccountTaskLists } from "./task_tools";

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
 * Builds the per-account calendar lists consumed by buildSystemPrompt's `accountCalendars` option: each
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
 * Inputs for buildSystemPrompt, grouped into an options object since the account/calendar/task-list
 * bookkeeping grew past a handful of positional parameters once tasks became always-on (issue #5).
 */
export interface BuildSystemPromptOptions {
  /** Current time, embedded up front since nearly every request is relative ("tomorrow", "this week"). */
  now: Date;
  /** Configured account nicknames, in priority order (the first is the default for writes). At least one. */
  accounts: string[];
  /**
   * Per-account calendar lists (see resolveAccountCalendars). Accounts with just their default calendar are
   * omitted, since there is then nothing to disambiguate for that account.
   */
  accountCalendars?: AccountCalendars[];
  /**
   * Per-account task lists (see task_tools.ts's resolveAccountTaskLists). Tasks are always enabled once
   * accounts are configured (design decision, issue #5), so this is only empty in tests that omit it.
   */
  accountTaskLists?: AccountTaskLists[];
  /**
   * Every discovered Skill's metadata (from discoverSkills), presented as a description list every turn
   * (design_doc §2.2 step 1) so the LLM can decide whether to call load_skill for one of them.
   */
  skills?: SkillMeta[];
  /** IANA zone name; injectable so tests do not depend on the host setting. */
  timeZone?: string;
}

/**
 * Builds the system prompt (design_doc §6.2).
 * The current time is embedded up front because nearly every calendar request is relative ("tomorrow", "this week"),
 * and computing it via a tool round-trip would be wasteful.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const {
    now,
    accounts,
    accountCalendars = [],
    accountTaskLists = [],
    skills = [],
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  } = options;

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

  if (skills.length > 0) {
    lines.push("- 利用可能な Skill（該当するものがあれば load_skill で本体を読み込んでから，その手順に従ってください）:");
    for (const skill of skills) {
      lines.push(`  - ${skill.name}: ${skill.description}`);
    }
  }

  if (accounts.length > 0) {
    lines.push(`- 利用できるアカウント: ${accounts.join(", ")}（予定の作成先を指定しない場合は ${accounts[0]}）`);
    const withExtraCalendars = accountCalendars.filter((a) => a.calendarIds.length > 1);
    if (withExtraCalendars.length > 0) {
      const perAccount = withExtraCalendars.map((a) => `${a.name}: ${a.calendarIds.join(", ")}`);
      lines.push(`- 利用できるカレンダー: ${perAccount.join("，")}`);
    }
  }

  if (accountTaskLists.length > 0) {
    lines.push("- タスクの情報が必要なときは，list_tasks ツールで取得してください．");
    const withExtraTaskLists = accountTaskLists.filter((a) => a.taskListIds.length > 1);
    if (accountTaskLists.length > 1 || withExtraTaskLists.length > 0) {
      const perAccount = accountTaskLists.map((a) => `${a.name}: ${a.taskListIds.join(", ")}`);
      lines.push(`- 利用できるタスクリスト: ${perAccount.join("，")}`);
    }
  }

  return lines.join("\n");
}
