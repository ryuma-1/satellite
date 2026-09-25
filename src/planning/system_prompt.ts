import { formatLocalDateTime } from "./datetime";

/**
 * Builds the system prompt (design_doc §6.2).
 * The current time is embedded up front because nearly every calendar request is relative ("tomorrow", "this week"),
 * and computing it via a tool round-trip would be wasteful.
 * @param timeZone IANA zone name; injectable so tests do not depend on the host setting.
 */
export function buildSystemPrompt(
  now: Date,
  accounts: string[],
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
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
  }
  return lines.join("\n");
}
