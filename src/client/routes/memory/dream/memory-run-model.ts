import type { MemoryDreamActionDto, MemoryDreamRunDto } from "@shared/api-contracts";
import { parseMemoryEntry } from "./helpers";

/**
 * One dream is a chain of runs, one per partition, executed back to back —
 * each project in turn, then global. The scheduler records them as separate
 * rows whose timestamps abut exactly: a run's `finishedAt` is the next run's
 * `startedAt`. The tolerance covers scheduling slack without ever bridging two
 * dreams, which sit ~12 hours apart.
 */
const BATCH_GAP_MS = 60_000;

export type DreamBatch = {
  /** Stable across refreshes: the id of the run that opened the dream. */
  id: string;
  startedAt: string;
  /** Null while the dream is still going. */
  finishedAt: string | null;
  /** True while any of its runs is still going. */
  running: boolean;
  /** Execution order — the projects the dream walked, then global. */
  runs: MemoryDreamRunDto[];
};

/**
 * Group runs into the dreams they belong to.
 *
 * Flat, the list showed twelve rows carrying three identical "9h ago"s, three
 * "22h ago"s and so on, presenting one scheduled event as many. Reading it,
 * you could not tell that a dream sweeps every project and then global, nor
 * how long one takes. The time now belongs to the dream, because within a
 * dream it is the same time.
 *
 * Input is expected newest-first, as the API returns it; output preserves that
 * for the dreams themselves while ordering each dream's runs the way they ran.
 */
export function groupRunsIntoDreams(runs: MemoryDreamRunDto[]): DreamBatch[] {
  const batches: DreamBatch[] = [];
  let current: MemoryDreamRunDto[] = [];

  const flush = () => {
    if (current.length === 0) return;
    // `current` is newest-first; the dream ran in the reverse order.
    const ordered = [...current].reverse();
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    // finishedAt stays null while anything is still going. It used to fall
    // back to startedAt, which made a running dream render as one that had
    // finished in zero seconds.
    const running = ordered.some((run) => run.status === "running" || !run.finishedAt);
    batches.push({
      id: first.id,
      startedAt: first.startedAt,
      finishedAt: running ? null : (last.finishedAt ?? null),
      running,
      runs: ordered
    });
    current = [];
  };

  for (const run of runs) {
    const previous = current[current.length - 1];
    if (previous && !chains(run, previous)) flush();
    current.push(run);
  }
  flush();
  return batches;
}

/** `older` ran immediately before `newer` — its end meets the other's start. */
function chains(older: MemoryDreamRunDto, newer: MemoryDreamRunDto): boolean {
  const end = Date.parse(older.finishedAt ?? "");
  const start = Date.parse(newer.startedAt ?? "");
  if (!Number.isFinite(end) || !Number.isFinite(start)) return false;
  const gap = start - end;
  return gap >= 0 && gap <= BATCH_GAP_MS;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Kept out of the component: reading the clock during render is impure, and
 *  the compiler lint rejects it there. */
export function countRecentDreams(dreams: DreamBatch[], now: number = Date.now()): number {
  const cutoff = now - SEVEN_DAYS_MS;
  return dreams.filter((dream) => Date.parse(dream.startedAt) >= cutoff).length;
}

/** How long a dream took — "5m 48s", "1m", "12s" — rendered inline after a
 *  separator. Returns "" for a run that has not finished or whose timestamps do
 *  not parse, so the caller drops the separator with it. Deliberately not
 *  shared with activity-model's formatCallDurationMs: that one fills a column,
 *  where an em dash holds the width an empty string would collapse. */
export function formatDreamDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "";
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export const ACTION_EFFECTS = ["update", "merge", "archive", "rescope", "keep"] as const;
export type ActionEffect = (typeof ACTION_EFFECTS)[number];

/** Unrecognised action types are treated as changes — safer to over-show a
 *  new action type than to file it under "nothing happened". */
export function actionEffect(action: MemoryDreamActionDto): ActionEffect | "other" {
  const type = action.actionType.toLowerCase();
  return (ACTION_EFFECTS as readonly string[]).includes(type) ? (type as ActionEffect) : "other";
}

export function isChange(action: MemoryDreamActionDto): boolean {
  return actionEffect(action) !== "keep";
}

/**
 * Split a run's actions into what it did and what it left alone.
 *
 * This is the whole point of the detail view. A typical run is 10 keeps and
 * one archive; rendering all eleven as equal cards means scrolling through ten
 * essays explaining why nothing was done to find the one thing that happened.
 * Keeps are real output — the run did consider them — so they are kept, but
 * behind a disclosure.
 *
 * Order within `changed` follows ACTION_EFFECTS: destructive and structural
 * edits first, since those are what you would open a run to audit.
 */
export function partitionActions(actions: MemoryDreamActionDto[]): {
  changed: MemoryDreamActionDto[];
  unchanged: MemoryDreamActionDto[];
} {
  const rank = (action: MemoryDreamActionDto) => {
    const index = (ACTION_EFFECTS as readonly string[]).indexOf(actionEffect(action));
    return index === -1 ? ACTION_EFFECTS.length : index;
  };
  const changed = actions.filter(isChange).sort((a, b) => rank(a) - rank(b));
  return { changed, unchanged: actions.filter((action) => !isChange(action)) };
}

export type ActionContent = {
  /** What the memory says now — the `after` when the run rewrote it. */
  current: string;
  /** The prior text, only when the run actually replaced it. */
  previous: string;
};

/**
 * The text to show for an action.
 *
 * `after` wins where it exists, because it is what the memory says now. The
 * old view rendered before and after as two equal blocks, which for these runs
 * meant two near-full paragraphs with nothing marking what moved — and the
 * model frequently rewrites a memory end to end, sometimes translating it, so
 * a word-level diff would light up every token and say even less. The reason
 * field already states what changed; `previous` just has to be reachable.
 */
export function actionContent(action: MemoryDreamActionDto): ActionContent {
  const before = parseMemoryEntry(action.before)?.content ?? "";
  const after = parseMemoryEntry(action.after)?.content ?? "";
  if (after && after !== before) return { current: after, previous: before };
  return { current: after || before, previous: "" };
}

/** Kind and scope read as one phrase ("semantic · project"), not two chips. */
export function actionFacets(action: MemoryDreamActionDto): string {
  const entry = parseMemoryEntry(action.after) ?? parseMemoryEntry(action.before);
  return [entry?.kind, entry?.scope].filter(Boolean).join(" · ");
}

/**
 * A one-line count of what a run did, for the disclosure headings.
 * Returns "" when there is nothing to count, so callers can skip the heading.
 */
export function countLabel(count: number, noun: string): string {
  if (count === 0) return "";
  return `${count} ${noun}`;
}
