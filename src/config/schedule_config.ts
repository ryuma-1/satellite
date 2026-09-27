import { join } from "node:path";
import { configDir } from "./paths";

/**
 * One contiguous block of working time within a day, as minutes from local midnight.
 * Minutes (not "HH:MM" strings) so due-date arithmetic never has to re-parse times.
 */
export interface WorkingRange {
  /** Start of the block, in minutes from local midnight (inclusive). */
  startMinutes: number;
  /** End of the block, in minutes from local midnight (exclusive); up to 1440 to allow ending at midnight. */
  endMinutes: number;
}

/**
 * Working time for each weekday, indexed like Date#getDay() (0 = Sunday ... 6 = Saturday), so callers can
 * look a day up without translating weekday names. Each day's ranges are sorted and non-overlapping; an empty
 * array means no working time that day (such days are never suggested as due dates).
 */
export type WorkingHours = readonly (readonly WorkingRange[])[];

/**
 * Parsed contents of schedule_config.json: the user's own working time, which due-date suggestion schedules
 * tasks into. Kept separate from google_config.json because it describes the user's life, not a Google setup.
 */
export interface ScheduleConfig {
  /** Working time per weekday. */
  workingHours: WorkingHours;
}

/**
 * A single weekday block of 09:00-18:00, the working day assumed before schedule_config.json existed.
 */
const DEFAULT_WEEKDAY_RANGE: WorkingRange = { startMinutes: 9 * 60, endMinutes: 18 * 60 };

/**
 * Working hours used when schedule_config.json is absent: Mon-Fri 09:00-18:00, weekends off. Keeps the
 * behavior of the original hard-coded constants, so the file stays optional.
 */
export const DEFAULT_WORKING_HOURS: WorkingHours = [
  [],
  [DEFAULT_WEEKDAY_RANGE],
  [DEFAULT_WEEKDAY_RANGE],
  [DEFAULT_WEEKDAY_RANGE],
  [DEFAULT_WEEKDAY_RANGE],
  [DEFAULT_WEEKDAY_RANGE],
  [],
];

/**
 * Weekday keys accepted in schedule_config.json's `workingHours`, in Date#getDay() order.
 */
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * "HH:MM" time format. 24:00 is accepted (checked separately) so a block can run until midnight.
 */
const TIME = /^(\d{2}):(\d{2})$/;

/**
 * Returns the default location of schedule_config.json.
 */
export function defaultScheduleConfigPath(): string {
  return join(configDir(), "schedule_config.json");
}

/**
 * Reads and validates schedule_config.json, falling back to DEFAULT_WORKING_HOURS when the file does not exist.
 * A missing file is not an error because the defaults reproduce the pre-config behavior; a malformed one is,
 * since silently ignoring it would schedule tasks into hours the user explicitly excluded.
 */
export async function loadScheduleConfig(path: string = defaultScheduleConfigPath()): Promise<ScheduleConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { workingHours: DEFAULT_WORKING_HOURS };
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch (err) {
    throw new Error(`Failed to parse schedule config ${path}: ${(err as Error).message}`);
  }
  return parseScheduleConfig(raw, path);
}

/**
 * Validates raw JSON. Split from loadScheduleConfig so it can be tested without files.
 * Weekdays omitted from `workingHours` have no working time; omitting `workingHours` itself uses the defaults.
 */
export function parseScheduleConfig(raw: unknown, source = "schedule_config.json"): ScheduleConfig {
  if (!isRecord(raw)) {
    throw new Error(`${source}: expected a JSON object`);
  }
  if (raw.workingHours === undefined) {
    return { workingHours: DEFAULT_WORKING_HOURS };
  }
  if (!isRecord(raw.workingHours)) {
    throw new Error(`${source}.workingHours must be an object keyed by weekday (${WEEKDAY_KEYS.join(", ")})`);
  }

  const unknownKey = Object.keys(raw.workingHours).find((k) => !(WEEKDAY_KEYS as readonly string[]).includes(k));
  if (unknownKey !== undefined) {
    // Rejected rather than ignored, so a typo like "mom" does not silently turn Monday into a day off.
    throw new Error(`${source}.workingHours has unknown key "${unknownKey}" (expected ${WEEKDAY_KEYS.join(", ")})`);
  }

  const rawHours = raw.workingHours;
  const workingHours = WEEKDAY_KEYS.map((key) => parseDayRanges(rawHours[key], `${source}.workingHours.${key}`));
  if (workingHours.every((ranges) => ranges.length === 0)) {
    // With no working time on any day, due-date suggestion would have no candidate day to search for.
    throw new Error(`${source}.workingHours must give at least one weekday some working time`);
  }
  return { workingHours };
}

/**
 * Parses one weekday's list of {start, end} blocks into sorted, non-overlapping WorkingRanges.
 * Overlaps are rejected instead of merged, since they almost always indicate a typo in the config.
 */
function parseDayRanges(raw: unknown, where: string): WorkingRange[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${where} must be an array of {"start": "HH:MM", "end": "HH:MM"} objects`);
  }

  const ranges = raw.map((entry, i) => {
    if (!isRecord(entry) || typeof entry.start !== "string" || typeof entry.end !== "string") {
      throw new Error(`${where}[${i}] must be an object with "start" and "end" strings`);
    }
    const range = {
      startMinutes: parseTime(entry.start, `${where}[${i}].start`),
      endMinutes: parseTime(entry.end, `${where}[${i}].end`),
    };
    if (range.startMinutes >= range.endMinutes) {
      throw new Error(`${where}[${i}]: "start" must be earlier than "end"`);
    }
    return range;
  });

  ranges.sort((a, b) => a.startMinutes - b.startMinutes);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.startMinutes < ranges[i - 1]!.endMinutes) {
      throw new Error(`${where} has overlapping ranges`);
    }
  }
  return ranges;
}

/**
 * Parses "HH:MM" (00:00-24:00) into minutes from local midnight.
 */
function parseTime(value: string, where: string): number {
  const match = TIME.exec(value);
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  const total = hours * 60 + minutes;
  if (!match || minutes > 59 || total > 24 * 60) {
    throw new Error(`${where} must be a time "HH:MM" between 00:00 and 24:00, got "${value}"`);
  }
  return total;
}

/**
 * Narrows unknown JSON values to plain objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
