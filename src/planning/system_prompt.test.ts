import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./system_prompt";

describe("buildSystemPrompt", () => {
  const now = new Date(2026, 8, 25, 9, 30, 0);

  test("embeds the local date-time, weekday and time zone", () => {
    const prompt = buildSystemPrompt(now, [], "Asia/Tokyo");
    expect(prompt).toMatch(/現在日時: 2026-09-25T09:30:00[+-]\d{2}:\d{2}/);
    expect(prompt).toContain("タイムゾーン: Asia/Tokyo");
    expect(prompt).toContain("曜日");
  });

  test("lists accounts with the default first", () => {
    const prompt = buildSystemPrompt(now, ["personal", "school"], "Asia/Tokyo");
    expect(prompt).toContain("利用できるアカウント: personal, school（予定の作成先を指定しない場合は personal）");
  });

  test("omits the account line without accounts", () => {
    expect(buildSystemPrompt(now, [], "Asia/Tokyo")).not.toContain("アカウント:");
  });
});
