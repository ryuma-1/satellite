/**
 * Runs `fn` once per target in parallel and merges the results, failing the whole call if any target fails.
 * Extracted from GoogleCalendarAdapter/GoogleTasksAdapter's identical "account × calendar/list" fan-out
 * pattern: returning only the successful targets would silently hide events/tasks, so any single failure
 * fails the entire call, naming every failing target so the user can see exactly what to fix (e.g. re-auth
 * one account) instead of a single opaque error.
 * @param targets Every (account, resource) pair to query.
 * @param label Human-readable identifier for a target, used in the aggregated error message.
 * @param fn Fetches and converts the items for one target.
 */
export async function fanOut<Target, Item>(
  targets: Target[],
  label: (target: Target) => string,
  fn: (target: Target) => Promise<Item[]>,
): Promise<Item[]> {
  const results = await Promise.allSettled(targets.map(fn));

  const failures = results.flatMap((r, i) => {
    if (r.status !== "rejected") return [];
    return [`${label(targets[i]!)}: ${(r.reason as Error).message}`];
  });
  if (failures.length > 0) {
    throw new Error(`gws request failed for ${failures.length} target(s):\n${failures.join("\n")}`);
  }

  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
