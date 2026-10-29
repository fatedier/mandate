import { ASKING_LABEL, WAITING_LABEL, type FeatureState } from "@shared/feature-state";

type WorkerGroupKey = "failed" | "stopped" | "asking" | "in_progress" | "blocked" | "idle";

export const WORKER_GROUP_LABEL: Record<WorkerGroupKey, string> = {
  failed: WAITING_LABEL.failed,
  stopped: WAITING_LABEL.stopped,
  asking: ASKING_LABEL,
  in_progress: "In progress",
  blocked: "Blocked",
  idle: "Idle"
};

// What went wrong first, then the worker that waits for an answer (its
// manager's first), then the rest by what the plan says. A finished plan is
// its manager's to hear, and idle here.
const ORDER: WorkerGroupKey[] = ["failed", "stopped", "asking", "in_progress", "blocked", "idle"];

type Waiting = "failed" | "stopped" | null;

export function workerGroup(w: { state: FeatureState; waiting: Waiting }): WorkerGroupKey {
  if (w.waiting === "failed") return "failed";
  if (w.waiting === "stopped") return "stopped";
  if (w.state === "asking") return "asking";
  if (w.state === "planning" || w.state === "in_progress") return "in_progress";
  if (w.state === "blocked") return "blocked";
  return "idle";
}

export function groupWorkers<T extends { state: FeatureState; waiting: Waiting }>(workers: T[]): Array<{ key: WorkerGroupKey; workers: T[] }> {
  return ORDER
    .map((key) => ({ key, workers: workers.filter((w) => workerGroup(w) === key) }))
    .filter((g) => g.workers.length > 0);
}

export type WorkerTab = "chat" | "plan" | "changes" | "reports" | "terminal";

/** Chat where an answer or a look at what went wrong is wanted; Plan otherwise. */
export function defaultWorkerTab(w: { waiting: Waiting; asking?: boolean }): WorkerTab {
  return w.asking || w.waiting === "failed" || w.waiting === "stopped" ? "chat" : "plan";
}

/** A worker `?tab=` value. */
export function workerTabFromParam(value: string | null): WorkerTab | null {
  switch (value) {
    case "chat": case "plan": case "changes": case "reports": case "terminal": return value;
    default: return null;
  }
}
