import type { AgentScope } from "../agent-store.js";
import type { ToolContext } from "../tool-registry.js";
import type { WorkersStore, WorkerRow } from "../../workers/workers-store.js";
import type { ProjectsStore, ProjectRow } from "../../projects/projects-store.js";

/** Which worker's pane a pane monitor is on, as the manager names it. A
 *  worker names none: it is always on its own. */
interface PaneMonitorTarget {
  workerId?: string;
}

interface PaneMonitorTargetDeps {
  scope: AgentScope;
  projectsStore?: ProjectsStore;
  workersStore?: WorkersStore;
}

/** The window key of the pane a monitor is on: the worker's bound
 *  worker window, or the worker the manager names. */
export function resolvePaneWindowKey(ctx: ToolContext, pane: PaneMonitorTarget, deps: PaneMonitorTargetDeps): string {
  return deps.scope === "worker" ? workerWindowKeyFromCtx(ctx) : managerWindowKey(pane, deps);
}

/** Builds the tmux window key. Must stay in lockstep with
 *  WorkerWindowStore.listActiveWindowKeys() and parseWindowKey() in
 *  runtime/pane-monitor-state.ts — all three build/parse the same key shape. */
export function workerWindowKey(
  project: Pick<ProjectRow, "tmuxSessionName">,
  worker: Pick<WorkerRow, "tmuxWindowName">
): string {
  return `${project.tmuxSessionName}:${worker.tmuxWindowName}`;
}

function workerWindowKeyFromCtx(ctx: ToolContext): string {
  if (!ctx.project || !ctx.worker) {
    throw new Error("the worker's pane monitor context is incomplete");
  }
  return workerWindowKey(ctx.project, ctx.worker);
}

function managerWindowKey(pane: PaneMonitorTarget, deps: PaneMonitorTargetDeps): string {
  if (!deps.projectsStore || !deps.workersStore) {
    throw new Error("the manager's pane monitor resolver is not configured");
  }

  const workerId = pane.workerId?.trim();
  if (!workerId) throw new Error("workerId is required");
  const worker = deps.workersStore.getById(workerId);
  if (!worker || worker.archivedAt) throw new Error(`worker not found: ${workerId}`);
  const project = deps.projectsStore.getById(worker.projectId);
  if (!project || project.archivedAt) throw new Error(`project not found for worker: ${workerId}`);
  return workerWindowKey(project, worker);
}
