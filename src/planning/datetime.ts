/**
 * Date conversions between the tool boundary (strings the LLM reads and writes) and Date objects.
 */

/**
 * Matches a date-only value, which is interpreted as local midnight like the calendar mapper does.
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses an ISO 8601 date or date-time string from tool input.
 * The error message is written for the LLM so it can correct its own arguments on the next step.
 */
export function parseDateInput(value: string, field: string): Date {
  const dateOnly = DATE_ONLY.exec(value);
  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} の日時 "${value}" を解釈できません．ISO 8601 形式（例: 2026-09-25T15:00:00+09:00）で指定してください`);
  }
  return parsed;
}

/**
 * Formats a Date as local YYYY-MM-DD.
 */
export function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Formats a Date as ISO 8601 with the local UTC offset (e.g. 2026-09-25T15:00:00+09:00).
 * Date#toISOString() is avoided because a UTC timestamp makes the LLM misjudge "today" near midnight.
 */
export function formatLocalDateTime(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${formatLocalDate(date)}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Zero-pads a number to two digits.
 */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
