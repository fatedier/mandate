import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { FeaturesStore } from "../features-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { TmuxSnapshot } from "../../../platform/tmux/tmux-types.js";
import { limitToolText } from "../../agent/tool-result-format.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { TaskListItem } from "../../../runtime/task-list.js";

const params = z.object({ featureId: z.string().min(1) });

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
  feature?: {
    id: string;
    name: string;
    /** URL-safe feature identifier: the worker's part of a page address. */
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

interface GetFeatureStatusDeps {
  featuresStore: FeaturesStore;
  projectsStore: ProjectsStore;
  getSnapshot: () => TmuxSnapshot | null;
  agentStore?: Pick<AgentStore, "getThreadByScope">;
  /** A conversation's queued and running tasks (list_tasks's items). */
  tasksOfThread?: (threadId: string) => TaskListItem[];
}

export function buildGetFeatureStatusTool(
  deps: GetFeatureStatusDeps
): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "get_feature_status",
    description: "Get the current analyzer status, active panes and running background tasks for a feature.",
    parameters: params,
    handler: async ({ featureId }) => {
      const feature = deps.featuresStore.getById(featureId);
      if (!feature || feature.archivedAt) return { error: `feature not found: ${featureId}` };
      const project = deps.projectsStore.getById(feature.projectId);
      if (!project) return { error: `project not found for feature: ${featureId}` };

      const snapshot = deps.getSnapshot();
      const session = snapshot?.sessions.find((s) => s.sessionName === project.tmuxSessionName);
      const window = session?.windows.find((w) => w.windowName === feature.tmuxWindowName);

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
        feature: {
          id: feature.id, name: feature.name, slug: feature.tmuxWindowName,
          projectId: project.id, projectName: project.name, projectSlug: project.tmuxSessionName,
          mode: feature.mode,
          branch: feature.branch,
          baseRef: feature.baseRef,
          workingDir: feature.worktreePath ?? project.workingDir
        },
        aggregateStatus: window?.aggregate?.status ?? "unknown",
        aggregateTitle: window?.aggregate?.title ?? "",
        panes,
        backgroundTasks: workerTasks(deps, featureId)
      };
    }
  };
}

function workerTasks(deps: GetFeatureStatusDeps, featureId: string): TaskListItem[] {
  const worker = deps.agentStore?.getThreadByScope("worker", featureId);
  return worker && deps.tasksOfThread ? deps.tasksOfThread(worker.id) : [];
}
