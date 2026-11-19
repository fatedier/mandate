import { END_OF_TIME } from "./local-days.js";
import { sliceOf } from "./slice-schema.js";

/**
 * Which kept slices an answer may use, and what it reads from the calls
 * instead.
 *
 * A window is its whole slices and two ends: the part of a slice after the
 * window's cut, and what comes after the last whole slice (the hour under
 * way, or the rest of a window that ends inside an hour). The ends are always
 * read from the calls.
 *
 * A kept slice is used when it was built with the inputs in use, not before
 * the floor, and no earlier than the newest change in it or in any slice
 * before it. A change reaches forward because a thread's step is judged
 * against the call before it: a call that changes can change the verdict of
 * a later one in another slice. Changes happen in the newest slices (a call
 * starting, finishing, being priced), so the older ones stay good.
 */

const HOUR_MS = 3_600_000;

export interface PlannedRead {
  /** The kept slices to use, oldest first. */
  use: string[];
  /** The runs to read from the calls, oldest first: the calls created after
   *  `since` and before `until`. `whole`: the whole slices inside a run, to
   *  keep once read. */
  build: Array<{ since: string; until: string; whole: string[] }>;
}

export function planSlices(input: {
  /** The window: calls created after `since` and before `until` (none: up to the end of time). */
  since: string;
  until: string | null;
  now: number;
  kept: ReadonlyArray<{ start: string; builtSeq: number; inputs: string }>;
  /** The slices' last changes, the window's earlier ones included. */
  changes: ReadonlyArray<{ start: string; seq: number }>;
  state: { seq: number; floor: number };
  inputs: string;
}): PlannedRead {
  const { since, until } = input;
  const sinceMs = Date.parse(since);
  const untilMs = until === null ? Infinity : Date.parse(until);
  // A whole slice ends by the window's end and by now: the hour under way is
  // still filling, and an hour ahead of now is no hour yet (a picked today
  // ends at the next midnight).
  const endMs = Math.min(untilMs, input.now);
  // `since` is not in the window: the first whole slice starts after it.
  const firstStart = (Math.floor(sinceMs / HOUR_MS) + 1) * HOUR_MS;

  const keptAt = new Map(input.kept.map((row) => [row.start, row]));
  const changes = [...input.changes].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let reach = 0;
  let next = 0;

  const use: string[] = [];
  const build: PlannedRead["build"] = [];
  // The run being gathered: where it starts, and the whole slices in it.
  let run: { since: string; whole: string[] } | null = firstStart - 1 > sinceMs ? { since, whole: [] } : null;
  for (let start = firstStart; start + HOUR_MS <= endMs; start += HOUR_MS) {
    const slice = sliceOf(new Date(start).toISOString());
    while (next < changes.length && changes[next]!.start <= slice) {
      reach = Math.max(reach, changes[next]!.seq);
      next += 1;
    }
    const row = keptAt.get(slice);
    if (row && row.inputs === input.inputs && row.builtSeq >= input.state.floor && row.builtSeq >= reach) {
      if (run) build.push({ since: run.since, until: new Date(start).toISOString(), whole: run.whole });
      run = null;
      use.push(slice);
    } else {
      // A slice holds its own first millisecond: it is read from the one before.
      run ??= { since: new Date(start - 1).toISOString(), whole: [] };
      run.whole.push(slice);
    }
  }
  // What is left after the last whole slice.
  const lastEnd = Math.max(firstStart, firstStart + Math.floor((endMs - firstStart) / HOUR_MS) * HOUR_MS);
  const open = lastEnd < untilMs;
  if (open) run ??= { since: lastEnd - 1 > sinceMs ? new Date(lastEnd - 1).toISOString() : since, whole: [] };
  if (run) build.push({ since: run.since, until: until ?? END_OF_TIME, whole: run.whole });
  return { use, build };
}
