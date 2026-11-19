import type { WorkerRow } from "../workers/workers-store.js";
import type { ProjectRow } from "./projects-store.js";

/** What a reconcile asks tmux and makes. Callers run it in the project's
 *  turn (projectWork): it checks and then creates, so two at once would
 *  each open what neither found. */
export interface ReconcileTmux {
  hasSession(name: string): Promise<boolean>;
  newSession(name: string, cwd: string): Promise<void>;
  hasWindow(session: string, windowName: string): Promise<boolean>;
  /** Returns the new window's id. */
  newWindow(session: string, windowName: string, cwd: string): Promise<string>;
}

/** What a reconcile needs of a worker: one not recorded yet will do. */
export type ReconcileWorker = Pick<WorkerRow, "tmuxWindowName" | "ownership" | "worktreePath">;

export interface ReconcileResult {
  rebuilt?: boolean;
  broken?: boolean;
}

export async function reconcileProject(
  project: ProjectRow,
  activeWorkers: ReconcileWorker[],
  tmux: ReconcileTmux
): Promise<ReconcileResult> {
  const exists = await tmux.hasSession(project.tmuxSessionName);

  if (project.ownership === "app") {
    if (!exists) {
      await tmux.newSession(project.tmuxSessionName, project.workingDir);
      for (const worker of activeWorkers) {
        await reconcileWorker(worker, project, tmux);
      }
      return { rebuilt: true };
    }
    return { rebuilt: false };
  }

  // adopted
  return exists ? { rebuilt: false } : { broken: true };
}

export async function reconcileWorker(
  worker: ReconcileWorker,
  project: ProjectRow,
  tmux: ReconcileTmux
): Promise<ReconcileResult> {
  const exists = await tmux.hasWindow(project.tmuxSessionName, worker.tmuxWindowName);
  if (exists) return { rebuilt: false };

  if (worker.ownership === "app") {
    const cwd = worker.worktreePath ?? project.workingDir;
    await tmux.newWindow(project.tmuxSessionName, worker.tmuxWindowName, cwd);
    return { rebuilt: true };
  }

  return { broken: true };
}
