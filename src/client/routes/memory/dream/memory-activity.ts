import type { MemoryEntryDto } from "@shared/api-contracts";
import type { DreamBatch } from "./memory-run-model";

export const ACTIVITY_KINDS = ["learned", "archived", "dream"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type MemoryEvent =
  | { kind: "learned"; at: string; id: string; entry: MemoryEntryDto }
  | { kind: "archived"; at: string; id: string; entry: MemoryEntryDto }
  | { kind: "dream"; at: string; id: string; dream: DreamBatch };

/**
 * One stream out of three sources.
 *
 * The store keeps no event log, so the events are reconstructed: a memory's
 * `createdAt` is when it was learned, a dream's batch is its own event, and an
 * archived entry's `updatedAt` stands in for when it was archived. That last
 * one is an approximation — `updatedAt` moves for any write — but on this data
 * every archived row had been updated after creation, and an archive is the
 * write that matters.
 *
 * A rewrite is deliberately not a top-level event. Rewrites happen *inside* a
 * dream, and the dream row already reports what it changed; listing them
 * alongside would say the same thing twice, which is the fault this page was
 * built to remove. Opening a dream shows each one.
 */
export function buildActivityFeed(input: {
  learned: MemoryEntryDto[];
  archived: MemoryEntryDto[];
  dreams: DreamBatch[];
}): MemoryEvent[] {
  const events: MemoryEvent[] = [
    ...input.learned.map(
      (entry): MemoryEvent => ({
        kind: "learned",
        at: entry.createdAt,
        id: `learned:${entry.id}`,
        entry
      })
    ),
    ...input.archived.map(
      (entry): MemoryEvent => ({
        kind: "archived",
        at: entry.updatedAt,
        id: `archived:${entry.id}`,
        entry
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

export type ActivityDay = { key: string; label: string; events: MemoryEvent[] };

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
  // Pinned to en-US rather than the browser locale: this product's copy is
  // English throughout, and the ambient locale rendered "7月26日" between two
  // English headings.
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric"
  });
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
    changed += counts.update + counts.merge + counts.archive + counts.rescope;
  }
  return { reviewed: dream.running ? null : reviewed, changed };
}
