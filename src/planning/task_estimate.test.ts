import { describe, expect, test } from "bun:test";
import { parseEstimateHours, withEstimateMarker } from "./task_estimate";

describe("parseEstimateHours", () => {
  test("reads an integer or decimal estimate from anywhere in the notes", () => {
    expect(parseEstimateHours("[estimate: 3h]")).toBe(3);
    expect(parseEstimateHours("draft outline\n[estimate: 1.5h]")).toBe(1.5);
    expect(parseEstimateHours("[Estimate:2 h] then more text")).toBe(2);
  });

  test("returns undefined without a marker, for a zero estimate, or for undefined notes", () => {
    expect(parseEstimateHours("just notes")).toBeUndefined();
    expect(parseEstimateHours("[estimate: 0h]")).toBeUndefined();
    expect(parseEstimateHours(undefined)).toBeUndefined();
  });
});

describe("withEstimateMarker", () => {
  test("appends the marker on its own line after existing notes", () => {
    expect(withEstimateMarker("draft", 3)).toBe("draft\n[estimate: 3h]");
  });

  test("returns just the marker when there are no notes", () => {
    expect(withEstimateMarker(undefined, 2)).toBe("[estimate: 2h]");
    expect(withEstimateMarker("", 2)).toBe("[estimate: 2h]");
  });

  test("replaces an existing marker instead of adding a second one", () => {
    const updated = withEstimateMarker("draft\n[estimate: 3h]", 5);
    expect(updated).toBe("draft\n[estimate: 5h]");
    expect(parseEstimateHours(updated)).toBe(5);
  });
});
