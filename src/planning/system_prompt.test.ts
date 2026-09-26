import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, resolveAccountCalendars } from "./system_prompt";

describe("buildSystemPrompt", () => {
  const now = new Date(2026, 8, 25, 9, 30, 0);

  test("embeds the local date-time, weekday and time zone", () => {
    const prompt = buildSystemPrompt(now, [], [], "Asia/Tokyo");
    expect(prompt).toMatch(/現在日時: 2026-09-25T09:30:00[+-]\d{2}:\d{2}/);
    expect(prompt).toContain("タイムゾーン: Asia/Tokyo");
    expect(prompt).toContain("曜日");
  });

  test("lists accounts with the default first", () => {
    const prompt = buildSystemPrompt(now, ["personal", "school"], [], "Asia/Tokyo");
    expect(prompt).toContain("利用できるアカウント: personal, school（予定の作成先を指定しない場合は personal）");
  });

  test("omits the account line without accounts", () => {
    expect(buildSystemPrompt(now, [], [], "Asia/Tokyo")).not.toContain("アカウント:");
  });

  test("lists calendars with the default first", () => {
    const prompt = buildSystemPrompt(now, [], ["primary", "work@example.com"], "Asia/Tokyo");
    expect(prompt).toContain("利用できるカレンダー: primary, work@example.com（予定の作成先を指定しない場合は primary）");
  });

  test("omits the calendar line with only the default calendar", () => {
    expect(buildSystemPrompt(now, [], ["primary"], "Asia/Tokyo")).not.toContain("カレンダー:");
    expect(buildSystemPrompt(now, [], [], "Asia/Tokyo")).not.toContain("カレンダー:");
  });

  test("lists per-account calendars only for accounts with extra calendars", () => {
    const prompt = buildSystemPrompt(now, ["normal", "school"], [], "Asia/Tokyo", [
      { name: "school", calendarIds: ["primary", "nomura.laboratory@gmail.com"] },
    ]);
    expect(prompt).toContain("利用できるカレンダー: school: primary, nomura.laboratory@gmail.com");
  });

  test("omits the calendar line when no account has an extra calendar", () => {
    const prompt = buildSystemPrompt(now, ["normal", "school"], [], "Asia/Tokyo", [
      { name: "normal", calendarIds: ["primary"] },
      { name: "school", calendarIds: ["primary"] },
    ]);
    expect(prompt).not.toContain("カレンダー:");
  });

  test("omits task guidance when tasks is not configured", () => {
    const prompt = buildSystemPrompt(now, [], [], "Asia/Tokyo", [], []);
    expect(prompt).not.toContain("list_tasks");
    expect(prompt).not.toContain("タスクリスト:");
  });

  test("adds task tool guidance without listing task lists when only the default is configured", () => {
    const prompt = buildSystemPrompt(now, [], [], "Asia/Tokyo", [], ["@default"]);
    expect(prompt).toContain("list_tasks ツールで取得してください");
    expect(prompt).not.toContain("タスクリスト:");
  });

  test("lists every task list when more than the default is configured", () => {
    const prompt = buildSystemPrompt(now, [], [], "Asia/Tokyo", [], ["@default", "work-list"]);
    expect(prompt).toContain("利用できるタスクリスト: @default, work-list");
  });
});

describe("resolveAccountCalendars", () => {
  test("prefixes each account's extras with the default calendar", () => {
    const accountCalendars = resolveAccountCalendars(
      [{ name: "school", calendarIds: ["nomura.laboratory@gmail.com"] }],
      "primary",
    );
    expect(accountCalendars).toEqual([
      { name: "school", calendarIds: ["primary", "nomura.laboratory@gmail.com"] },
    ]);
  });

  test("omits accounts with no extra calendars", () => {
    const accountCalendars = resolveAccountCalendars(
      [
        { name: "normal", calendarIds: [] },
        { name: "school", calendarIds: ["nomura.laboratory@gmail.com"] },
      ],
      "primary",
    );
    expect(accountCalendars).toEqual([
      { name: "school", calendarIds: ["primary", "nomura.laboratory@gmail.com"] },
    ]);
  });
});
