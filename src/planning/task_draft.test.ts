import { describe, expect, test } from "bun:test";
import { checkTaskDraft } from "./task_draft";

describe("checkTaskDraft", () => {
  test("reports complete: true and no missing fields when everything is present", () => {
    expect(checkTaskDraft({ title: "Write report", estimatedHours: 2, deadline: "2026-10-01" })).toEqual({
      complete: true,
      missing: [],
    });
  });

  test("reports every field missing when the draft is empty", () => {
    expect(checkTaskDraft({})).toEqual({
      complete: false,
      missing: ["title", "estimatedHours", "deadline"],
    });
  });

  test("reports only the fields that are actually missing", () => {
    expect(checkTaskDraft({ title: "Write report" })).toEqual({
      complete: false,
      missing: ["estimatedHours", "deadline"],
    });
  });

  test("treats an empty or blank title as missing, not merely present", () => {
    expect(checkTaskDraft({ title: "", estimatedHours: 2, deadline: "2026-10-01" }).missing).toEqual(["title"]);
    expect(checkTaskDraft({ title: "   ", estimatedHours: 2, deadline: "2026-10-01" }).missing).toEqual(["title"]);
  });

  test("treats a zero or negative estimatedHours as missing, not merely present", () => {
    expect(checkTaskDraft({ title: "T", estimatedHours: 0, deadline: "2026-10-01" }).missing).toEqual([
      "estimatedHours",
    ]);
    expect(checkTaskDraft({ title: "T", estimatedHours: -1, deadline: "2026-10-01" }).missing).toEqual([
      "estimatedHours",
    ]);
  });

  test("treats an empty or blank deadline as missing, not merely present", () => {
    expect(checkTaskDraft({ title: "T", estimatedHours: 1, deadline: "" }).missing).toEqual(["deadline"]);
    expect(checkTaskDraft({ title: "T", estimatedHours: 1, deadline: "  " }).missing).toEqual(["deadline"]);
  });
});
