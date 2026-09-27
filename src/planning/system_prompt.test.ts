import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, resolveAccountCalendars } from "./system_prompt";

describe("buildSystemPrompt", () => {
  const now = new Date(2026, 8, 25, 9, 30, 0);

  test("embeds the local date-time, weekday and time zone", () => {
    const prompt = buildSystemPrompt({ now, accounts: [], timeZone: "Asia/Tokyo" });
    expect(prompt).toMatch(/現在日時: 2026-09-25T09:30:00[+-]\d{2}:\d{2}/);
    expect(prompt).toContain("タイムゾーン: Asia/Tokyo");
    expect(prompt).toContain("曜日");
  });

  test("lists accounts with the default first", () => {
    const prompt = buildSystemPrompt({ now, accounts: ["personal", "school"], timeZone: "Asia/Tokyo" });
    expect(prompt).toContain("利用できるアカウント: personal, school（予定の作成先を指定しない場合は personal）");
  });

  test("omits the account line without accounts", () => {
    expect(buildSystemPrompt({ now, accounts: [], timeZone: "Asia/Tokyo" })).not.toContain("アカウント:");
  });

  test("lists per-account calendars only for accounts with extra calendars", () => {
    const prompt = buildSystemPrompt({
      now,
      accounts: ["normal", "school"],
      accountCalendars: [{ name: "school", calendarIds: ["primary", "nomura.laboratory@gmail.com"] }],
      timeZone: "Asia/Tokyo",
    });
    expect(prompt).toContain("利用できるカレンダー: school: primary, nomura.laboratory@gmail.com");
  });

  test("omits the calendar line when no account has an extra calendar", () => {
    const prompt = buildSystemPrompt({
      now,
      accounts: ["normal", "school"],
      accountCalendars: [
        { name: "normal", calendarIds: ["primary"] },
        { name: "school", calendarIds: ["primary"] },
      ],
      timeZone: "Asia/Tokyo",
    });
    expect(prompt).not.toContain("カレンダー:");
  });

  test("omits task guidance when no accountTaskLists are given", () => {
    const prompt = buildSystemPrompt({ now, accounts: [], timeZone: "Asia/Tokyo" });
    expect(prompt).not.toContain("list_tasks");
    expect(prompt).not.toContain("タスクリスト:");
  });

  test("adds task tool guidance without listing task lists when only the default is configured", () => {
    const prompt = buildSystemPrompt({
      now,
      accounts: [],
      accountTaskLists: [{ name: "acct", taskListIds: ["@default"] }],
      timeZone: "Asia/Tokyo",
    });
    expect(prompt).toContain("list_tasks ツールで取得してください");
    expect(prompt).not.toContain("タスクリスト:");
  });

  test("lists every account/task-list combination when there is more than one", () => {
    const prompt = buildSystemPrompt({
      now,
      accounts: [],
      accountTaskLists: [{ name: "acct", taskListIds: ["@default", "work-list"] }],
      timeZone: "Asia/Tokyo",
    });
    expect(prompt).toContain("利用できるタスクリスト: acct: @default, work-list");
  });

  test("lists task lists when multiple accounts are configured, even with only the default list each", () => {
    const prompt = buildSystemPrompt({
      now,
      accounts: [],
      accountTaskLists: [
        { name: "personal", taskListIds: ["@default"] },
        { name: "school", taskListIds: ["@default"] },
      ],
      timeZone: "Asia/Tokyo",
    });
    expect(prompt).toContain("利用できるタスクリスト: personal: @default，school: @default");
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
