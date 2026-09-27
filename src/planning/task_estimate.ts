/**
 * Marker embedded in a task's notes to record its estimated hours, e.g. "[estimate: 1.5h]".
 * Google Tasks has no duration field, so the estimate lives in notes, where it survives across devices and
 * can still be edited by hand in the Google Tasks UI.
 */
const ESTIMATE_MARKER = /\[estimate:\s*(\d+(?:\.\d+)?)\s*h\]/i;

/**
 * Same as ESTIMATE_MARKER, but also matching the line break that withEstimateMarker places before it, so
 * replacing a marker does not leave blank lines behind.
 */
const ESTIMATE_MARKER_LINE = /\n?\[estimate:\s*\d+(?:\.\d+)?\s*h\]/gi;

/**
 * Reads the estimated hours recorded in `notes` by withEstimateMarker (or typed by hand in the same format).
 * @returns undefined when there is no marker, or when its value is zero, so callers apply their own default.
 */
export function parseEstimateHours(notes: string | undefined): number | undefined {
  const match = notes === undefined ? null : ESTIMATE_MARKER.exec(notes);
  if (!match) return undefined;
  const hours = Number(match[1]);
  return hours > 0 ? hours : undefined;
}

/**
 * Returns `notes` with an estimate marker for `hours` appended on its own line, replacing any existing marker
 * so a task never carries two conflicting estimates.
 */
export function withEstimateMarker(notes: string | undefined, hours: number): string {
  const marker = `[estimate: ${hours}h]`;
  const body = (notes ?? "").replace(ESTIMATE_MARKER_LINE, "").trimEnd();
  return body.length > 0 ? `${body}\n${marker}` : marker;
}
