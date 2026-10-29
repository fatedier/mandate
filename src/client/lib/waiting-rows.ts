import { featureHref, threadHref } from "@/lib/feature-href";
import { markdownToText } from "@/lib/markdown-text";
import type { WaitingEntryDto } from "@shared/api/thread-status";
import type { WaitingKind } from "@shared/status-words";

/** One thing that waits on the user, as Home lists it. */
export interface WaitingRow {
  key: string;
  kind: WaitingEntryDto["kind"];
  waiting: WaitingKind;
  /** The thread it is in; a worker with no thread, its project; the agent's name. */
  title: string;
  /** Who waits: the worker, or the thread's manager; empty for the agent's
   *  own question, where nobody stands between the user and it. */
  name: string;
  text: string;
  href: string;
}

/** What the client adds to the server's list: the name the page gives
 *  Your agent. */
export interface WaitingRowFacts {
  agentLabel: string;
}

/** The server's list of what waits on the user, in its order, as Home words
 *  it: its rows, and by their number the count on what opens Home, so the
 *  two cannot disagree. A decision's or a result's text is the manager's
 *  reply, read as plain words. Pure, so the rows are tested as data. */
export function waitingRows(entries: readonly WaitingEntryDto[], facts: WaitingRowFacts): WaitingRow[] {
  return entries.flatMap((entry): WaitingRow[] => {
    // What an agent wrote (a question, a decision, a result) is read as plain
    // words; what broke or stopped is shown as it was said.
    const text = entry.waiting === "input" || entry.waiting === "decision" || entry.waiting === "result" ? markdownToText(entry.text) : entry.text;
    if (entry.kind === "agent") {
      return [{ key: entry.key, kind: entry.kind, waiting: entry.waiting, title: facts.agentLabel, name: "", text, href: "/agent" }];
    }
    if (entry.kind === "worker") {
      const featureId = entry.featureId ?? "";
      const where = entry.place;
      const href = entry.threadId
        ? `${threadHref(entry.threadId)}?worker=${encodeURIComponent(featureId)}`
        : where ? featureHref(where.projectSlug, where.featureSlug) : "/home";
      return [{ key: entry.key, kind: entry.kind, waiting: entry.waiting, title: entry.threadTitle ?? where?.projectName ?? "", name: entry.workerName ?? featureId, text, href }];
    }
    if (!entry.threadId) return [];
    return [{ key: entry.key, kind: entry.kind, waiting: entry.waiting, title: entry.threadTitle ?? "", name: "manager", text, href: threadHref(entry.threadId) }];
  });
}

/** The count with its colour, for the badges: red when something broke,
 *  yellow when a question waits, the accent otherwise. `withoutAgent`: the
 *  sidebar's badge leaves out Your agent's own question, which its row shows. */
export function waitingSummary(rows: readonly WaitingRow[], opts: { withoutAgent?: boolean } = {}): { count: number; urgent: boolean; failed: boolean } {
  const counted = opts.withoutAgent ? rows.filter((row) => row.kind !== "agent") : rows;
  return {
    count: counted.length,
    // What needs the user: a question, or a thread that broke. A decision or
    // a result to read is worth a look, and is the accent.
    urgent: counted.some((row) => row.waiting !== "decision" && row.waiting !== "result"),
    failed: counted.some((row) => row.waiting === "failed" || row.waiting === "stopped")
  };
}

/** Where rows wait, as one line: each thread (or project) once, in the
 *  rows' order, with how many rows it has when more than one
 *  ("project-1 3.21 release ×2 · project-2 cache expiry"). */
export function waitingPlaces(rows: readonly WaitingRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.title, (counts.get(row.title) ?? 0) + 1);
  return [...counts].map(([title, n]) => (n > 1 ? `${title} ×${n}` : title)).join(" · ");
}
