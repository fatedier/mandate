import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { WorkersStore } from "../workers-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { TmuxSnapshot } from "../../../platform/tmux/tmux-types.js";
import { limitToolText } from "../../agent/tool-result-format.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { TaskListItem } from "../../../runtime/task-list.js";
import { params } from "./get-worker-status-schema.js";

interface PaneInfo {
  paneId: string;
  status: string;
  command: string;
  commandTruncated?: boolean;
  summary: string;
  summaryTruncated?: boolean;
  changedAt: string | null;
}

interface Result {
  worker?: {
    id: string;
    name: string;
    /** URL-safe worker identifier: the worker's part of a page address. */
    slug: string;
    projectId: string;
    projectName: string;
    /** URL-safe project identifier: the project's part of a page address. */
    projectSlug: string;
    mode: string;
    branch: string | null;
    baseRef: string | null;
    workingDir: string | null;
  };
  aggregateStatus?: string;
  aggregateTitle?: string;
  panes?: PaneInfo[];
  /** Its worker's queued and running background tasks. */
  backgroundTasks?: TaskListItem[];
  error?: string;
}

interface GetWorkerStatusDeps {
  workersStore: WorkersStore;
  projectsStore: ProjectsStore;
  getSnapshot: () => TmuxSnapshot | null;
  agentStore?: Pick<AgentStore, "getThreadByScope">;
  /** A conversation's queued and running tasks (list_tasks's items). */
  tasksOfThread?: (threadId: string) => TaskListItem[];
}

export function buildGetWorkerStatusTool(
  deps: GetWorkerStatusDeps
): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "get_worker_status",
    description: "Get the current analyzer status, active panes and running background tasks for a worker.",
    parameters: params,
    handler: async ({ workerId }) => {
      const worker = deps.workersStore.getById(workerId);
      if (!worker || worker.archivedAt) return { error: `worker not found: ${workerId}` };
      const project = deps.projectsStore.getById(worker.projectId);
      if (!project) return { error: `project not found for worker: ${workerId}` };

      const snapshot = deps.getSnapshot();
      const session = snapshot?.sessions.find((s) => s.sessionName === project.tmuxSessionName);
      const window = session?.windows.find((w) => w.windowName === worker.tmuxWindowName);

      const panes: PaneInfo[] = (window?.panes ?? []).map((p) => {
        const command = limitToolText(p.currentCommand ?? "", 240);
        const summary = limitToolText(p.analysis?.summary ?? "", 600);
        return {
          paneId: p.paneId,
          status: p.analysis?.status ?? "unknown",
          command: command.text,
          ...(command.truncated ? { commandTruncated: true } : {}),
          summary: summary.text,
          ...(summary.truncated ? { summaryTruncated: true } : {}),
          changedAt: p.changedAt ?? null
        };
      });

      return {
        worker: {
          id: worker.id, name: worker.name, slug: worker.tmuxWindowName,
          projectId: project.id, projectName: project.name, projectSlug: project.tmuxSessionName,
          mode: worker.mode,
          branch: worker.branch,
          baseRef: worker.baseRef,
          workingDir: worker.worktreePath ?? project.workingDir
        },
        aggregateStatus: window?.aggregate?.status ?? "unknown",
        aggregateTitle: window?.aggregate?.title ?? "",
        panes,
        backgroundTasks: workerTasks(deps, workerId)
      };
    }
  };
}

function workerTasks(deps: GetWorkerStatusDeps, workerId: string): TaskListItem[] {
  const worker = deps.agentStore?.getThreadByScope("worker", workerId);
  return worker && deps.tasksOfThread ? deps.tasksOfThread(worker.id) : [];
}
