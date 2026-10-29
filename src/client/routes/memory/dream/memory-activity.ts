import type { MemoryEntryDto } from "@shared/api-contracts";
import { memoryLastUpdate, memoryTextAsLearned } from "@shared/memory-last-update";
import type { DreamBatch } from "./memory-run-model";
import { formatCalendarDate } from "@/lib/format";

export const ACTIVITY_KINDS = ["learned", "updated", "forgotten", "dream"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** A memory's event carries the text its row shows: as it was learned, what
 *  a rewrite added (`added`), or the memory as it is. */
export type MemoryEvent =
  | { kind: "learned"; at: string; id: string; entry: MemoryEntryDto; text: string }
  | { kind: "updated"; at: string; id: string; entry: MemoryEntryDto; text: string; added: boolean }
  | { kind: "forgotten"; at: string; id: string; entry: MemoryEntryDto; text: string; reason: string }
  | { kind: "dream"; at: string; id: string; dream: DreamBatch };

/** Why an agent forgot a memory, or "" when the memory was not forgotten
 *  (a dream's merge or archive is in that dream's detail instead). */
export function forgottenReason(entry: MemoryEntryDto): string {
  const reason = entry.metadata?.forgottenReason;
  return entry.status === "archived" && typeof reason === "string" ? reason : "";
}

/**
 * One stream out of four sources.
 *
 * The store keeps no event log, so the events are reconstructed: a memory's
 * `createdAt` is when it was learned, the time kept with the version an
 * extraction's rewrite replaced is when it was rewritten, a dream's batch is
 * its own event, and an archived entry's `updatedAt` stands in for when it
 * was archived. That last one is an approximation — `updatedAt` moves for
 * any write — but archiving is itself such a write, and an archive is the
 * write that matters.
 *
 * A dream's rewrite is not a top-level event: it happens inside the dream,
 * and the dream row already reports what it changed; listing it alongside
 * would say the same thing twice. An extraction's rewrite happens in no
 * dream, so it is an event of its own. Only the last change of a memory's
 * text is kept, so only that one, when it was an extraction's, is told.
 */
export function buildActivityFeed(input: {
  learned: MemoryEntryDto[];
  /** What extractions rewrote last, read apart: a rewrite of an old memory
   *  is not among the newest learned. */
  updated?: MemoryEntryDto[];
  archived: MemoryEntryDto[];
  dreams: DreamBatch[];
}): MemoryEvent[] {
  const events: MemoryEvent[] = [
    // The parts a dream split off are left out by the query (learned=1):
    // they are the dream's doing, in its detail.
    ...input.learned.map(
      (entry): MemoryEvent => ({
        kind: "learned",
        at: entry.createdAt,
        id: `learned:${entry.id}`,
        entry,
        text: memoryTextAsLearned(entry)
      })
    ),
    ...(input.updated ?? []).flatMap((entry): MemoryEvent[] => {
      const last = memoryLastUpdate(entry);
      if (!last?.byExtraction) return [];
      return [{ kind: "updated", at: last.at, id: `updated:${entry.id}`, entry, text: last.added ?? entry.content, added: last.added !== null }];
    }),
    ...input.archived.filter((entry) => forgottenReason(entry)).map(
      (entry): MemoryEvent => ({
        kind: "forgotten",
        at: entry.updatedAt,
        id: `forgotten:${entry.id}`,
        entry,
        text: entry.content,
        reason: forgottenReason(entry)
      })
    ),
    ...input.dreams.map(
      (dream): MemoryEvent => ({
        kind: "dream",
        at: dream.startedAt,
        id: `dream:${dream.id}`,
        dream
      })
    )
  ];

  return events
    .filter((event) => Number.isFinite(Date.parse(event.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
}

type ActivityDay = { key: string; label: string; events: MemoryEvent[] };

/**
 * Split the feed into day sections. The heading carries the date so individual
 * rows only need a clock time — within a day the date is the same on every row,
 * and repeating it is the noise this page keeps trying to grow back.
 */
export function groupByDay(events: MemoryEvent[], now: Date = new Date()): ActivityDay[] {
  const days: ActivityDay[] = [];
  for (const event of events) {
    const date = new Date(event.at);
    const key = dayKey(date);
    const last = days[days.length - 1];
    if (last?.key === key) last.events.push(event);
    else days.push({ key, label: dayLabel(date, now), events: [event] });
  }
  return days;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(date: Date, now: Date): string {
  if (dayKey(date) === dayKey(now)) return "Today";
  const yesterday = new Date(now.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  // The app's one way to write a date — never the ambient locale, which
  // rendered its own date format between two English headings.
  return formatCalendarDate(date.getTime(), now.getTime());
}

/**
 * What a dream did, totalled across its partitions.
 *
 * `reviewed` is null while the dream is still going: appliedCount is only
 * written when a run finishes, whereas the action counts update live, so a
 * running dream reported "0 reviewed, 23 changed" — a contradiction.
 */
export function dreamTotals(dream: DreamBatch): { reviewed: number | null; changed: number } {
  let reviewed = 0;
  let changed = 0;
  for (const run of dream.runs) {
    reviewed += run.appliedCount ?? 0;
    const counts = run.actionCounts;
    changed += counts.update + counts.merge + counts.archive + counts.move + counts.split;
  }
  return { reviewed: dream.running ? null : reviewed, changed };
}
