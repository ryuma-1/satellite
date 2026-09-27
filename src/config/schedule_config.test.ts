import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKING_HOURS, loadScheduleConfig, parseScheduleConfig } from "./schedule_config";

describe("parseScheduleConfig", () => {
  test("uses the defaults when workingHours is omitted", () => {
    expect(parseScheduleConfig({}).workingHours).toEqual(DEFAULT_WORKING_HOURS);
  });

  test("parses HH:MM ranges into minutes, indexed by Date#getDay(), sorting each day's ranges", () => {
    const config = parseScheduleConfig({
      workingHours: {
        mon: [
          { start: "13:00", end: "18:30" },
          { start: "09:00", end: "12:00" },
        ],
        sat: [{ start: "22:00", end: "24:00" }],
      },
    });
    expect(config.workingHours[1]).toEqual([
      { startMinutes: 540, endMinutes: 720 },
      { startMinutes: 780, endMinutes: 1110 },
    ]);
    expect(config.workingHours[6]).toEqual([{ startMinutes: 1320, endMinutes: 1440 }]);
  });

  test("treats omitted weekdays as days off", () => {
    const config = parseScheduleConfig({ workingHours: { wed: [{ start: "09:00", end: "10:00" }] } });
    expect(config.workingHours.filter((ranges) => ranges.length > 0)).toHaveLength(1);
    expect(config.workingHours[0]).toEqual([]);
  });

  test("rejects an unknown weekday key", () => {
    expect(() => parseScheduleConfig({ workingHours: { mom: [] } })).toThrow(/unknown key "mom"/);
  });

  test("rejects malformed times", () => {
    for (const bad of ["9:00", "24:30", "12:60", "noon"]) {
      expect(() => parseScheduleConfig({ workingHours: { mon: [{ start: bad, end: "23:00" }] } })).toThrow(/HH:MM/);
    }
  });

  test("rejects a range whose start is not before its end", () => {
    expect(() => parseScheduleConfig({ workingHours: { mon: [{ start: "10:00", end: "10:00" }] } })).toThrow(
      /earlier than/,
    );
  });

  test("rejects overlapping ranges on the same day", () => {
    expect(() =>
      parseScheduleConfig({
        workingHours: {
          mon: [
            { start: "09:00", end: "12:00" },
            { start: "11:00", end: "13:00" },
          ],
        },
      }),
    ).toThrow(/overlapping/);
  });

  test("rejects a schedule with no working time on any day", () => {
    expect(() => parseScheduleConfig({ workingHours: { mon: [] } })).toThrow(/at least one weekday/);
  });
});

describe("loadScheduleConfig", () => {
  /** Temporary directory holding config files written by each test. */
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "satellite-schedule-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("falls back to the defaults when the file does not exist", async () => {
    const config = await loadScheduleConfig(join(dir, "missing.json"));
    expect(config.workingHours).toEqual(DEFAULT_WORKING_HOURS);
  });

  test("reads and validates an existing file", async () => {
    const path = join(dir, "schedule_config.json");
    await Bun.write(path, JSON.stringify({ workingHours: { tue: [{ start: "08:00", end: "16:00" }] } }));
    const config = await loadScheduleConfig(path);
    expect(config.workingHours[2]).toEqual([{ startMinutes: 480, endMinutes: 960 }]);
  });

  test("reports invalid JSON instead of silently using the defaults", async () => {
    const path = join(dir, "schedule_config.json");
    await Bun.write(path, "{ not json");
    await expect(loadScheduleConfig(path)).rejects.toThrow(/Failed to parse schedule config/);
  });
});
