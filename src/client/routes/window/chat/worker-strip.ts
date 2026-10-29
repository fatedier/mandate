import type { AgentPendingMonitorDto, BackgroundTaskDto } from "@shared/api-contracts";
import { taskSections } from "./background-tasks-view";
import type { ThreadWorker } from "@/hooks/useThreadWorkers";
import { foldWaitingLines, waitingLines } from "./waiting-lines";

/** One worker on the strip above a manager thread's composer. */
export type WorkerStripRow =
  | {
      featureId: string;
      name: string;
      kind: "running";
      /** The step its plan has in progress, if any. */
      step: string | null;
      /** When its turn began. */
      since: string | null;
    }
  | {
      featureId: string;
      name: string;
      kind: "waiting";
      /** As its chat's waiting line says it: "Watching" a pane, "Monitoring" a command, "Wakes at" an alarm's time. */
      wait: Pick<ReturnType<typeof waitingLines>[number], "kind" | "lead" | "label" | "mono">;
      /** When it began to wait on it. */
      since: string;
    };

/** What a thread's workers are doing while the thread page is open: each
 *  one running a turn, then each one asleep on a pane watch or a command
 *  monitor (it will wake by itself), the longest at it first. A worker at
 *  rest, asking, or done is not at work. Pure, so who is listed, and in what
 *  order, is tested as data. */
export function workerStrip(
  workers: readonly ThreadWorker[],
  facts: {
    runningSince: (featureId: string) => string | null;
    stepOf: (featureId: string) => string | null;
    waitsOf: (featureId: string) => readonly AgentPendingMonitorDto[];
  }
): WorkerStripRow[] {
  const running: WorkerStripRow[] = [];
  const waiting: WorkerStripRow[] = [];
  for (const worker of workers) {
    if (worker.running) {
      running.push({ featureId: worker.featureId, name: worker.name, kind: "running", step: facts.stepOf(worker.featureId), since: facts.runningSince(worker.featureId) });
      continue;
    }
    const waits = facts.waitsOf(worker.featureId);
    // The wait its chat's line leads with: a pane before a command, as the
    // worker's watching state reads it, the one set last; else the alarm
    // that wakes it first. A subagent or a background command has no
    // waiting line to name it here.
    const line = foldWaitingLines(waitingLines(waits, { watchPanes: new Map() }))?.lead;
    const monitor = line && waits.find((m) => m.id === line.id);
    if (!line || !monitor) continue;
    waiting.push({ featureId: worker.featureId, name: worker.name, kind: "waiting", wait: { kind: line.kind, lead: line.lead, label: line.label, mono: line.mono }, since: monitor.createdAt });
  }
  return [...running.sort(bySince), ...waiting.sort(bySince)];
}

/** The longest at it first; one that does not say when it began, last. */
function bySince(a: WorkerStripRow, b: WorkerStripRow): number {
  const at = (row: WorkerStripRow) => (row.since ? Date.parse(row.since) : Number.NaN);
  const x = at(a);
  const y = at(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
  return x - y;
}


/** A conversation's background tasks on the strip above its composer: each
 *  running one, the longest at it first, then each queued one in the order
 *  they wait — the Background tasks list's own order (taskSections). An
 *  ended one is not at work, except those the reader has open (`held`: a
 *  task whose steps are open, or the tasks the folded row's open list was
 *  opened with): they stay, first, until it closes, so what they watch does
 *  not close under them. Pure, so who is listed, and in what order, is
 *  tested as data. */
export function taskStrip(tasks: readonly BackgroundTaskDto[], held: string | readonly string[] | null = null): BackgroundTaskDto[] {
  const { running, queued } = taskSections(tasks);
  const shown = [...running, ...queued];
  const ids = held === null ? [] : typeof held === "string" ? [held] : held;
  const kept = ids
    .filter((id) => !shown.some((task) => task.id === id))
    .flatMap((id) => tasks.filter((task) => task.id === id));
  return kept.length === 0 ? shown : [...kept, ...shown];
}
