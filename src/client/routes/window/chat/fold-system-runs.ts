/** Folds runs of consecutive "system" rows (heartbeats, context snapshots,
 *  wake provenance with no reply, watch / alarm events) into one entry, so the
 *  transcript reads as conversation with quiet furniture between turns rather
 *  than furniture with conversation between it. Pure: the list decides what
 *  counts as system through `classify`; this only groups. */

export interface SystemClassification {
  label: string;
  createdAt: string | null;
}

export type FoldedEntry<T> =
  | { kind: "item"; item: T }
  | {
      kind: "fold";
      key: string;
      items: T[];
      counts: Array<{ label: string; count: number }>;
      start: string | null;
      end: string | null;
    };

export function foldSystemRuns<T>(
  items: T[],
  classify: (item: T) => SystemClassification | null,
  keyOf: (item: T) => string
): FoldedEntry<T>[] {
  const out: FoldedEntry<T>[] = [];
  let run: Array<{ item: T; system: SystemClassification }> = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push({ kind: "item", item: run[0]!.item });
    } else {
      const counts: Array<{ label: string; count: number }> = [];
      for (const { system } of run) {
        const existing = counts.find((c) => c.label === system.label);
        if (existing) existing.count += 1;
        else counts.push({ label: system.label, count: 1 });
      }
      out.push({
        kind: "fold",
        key: keyOf(run[0]!.item),
        items: run.map((r) => r.item),
        counts,
        start: run[0]!.system.createdAt,
        end: run[run.length - 1]!.system.createdAt
      });
    }
    run = [];
  };

  for (const item of items) {
    const system = classify(item);
    if (system) {
      run.push({ item, system });
      continue;
    }
    flush();
    out.push({ kind: "item", item });
  }
  flush();
  return out;
}

/** Plain-words noun for a provenance label. Unknown labels get "<label> events". */
const NOUNS: Record<string, [singular: string, plural: string]> = {
  HEARTBEAT: ["heartbeat", "heartbeats"],
  CONTEXT: ["context snapshot", "context snapshots"],
  WATCH: ["watch event", "watch events"],
  ALARM: ["alarm", "alarms"],
  ANALYZER: ["analyzer update", "analyzer updates"],
  RECOVERY: ["recovery", "recoveries"],
  FEATURE: ["feature event", "feature events"],
  "WORK ITEM": ["work item event", "work item events"],
  SIDE: ["side summary", "side summaries"]
};

export function describeFold(
  counts: Array<{ label: string; count: number }>,
  start: string | null,
  end: string | null,
  clock: (iso: string) => string
): string {
  const parts = counts.map(({ label, count }) => {
    const noun = NOUNS[label] ?? [`${label.toLowerCase()} event`, `${label.toLowerCase()} events`];
    return `${count} ${count === 1 ? noun[0] : noun[1]}`;
  });
  if (start && end) {
    const a = clock(start);
    const b = clock(end);
    parts.push(a === b ? a : `${a} – ${b}`);
  } else if (start || end) {
    parts.push(clock((start ?? end)!));
  }
  return parts.join(" · ");
}
