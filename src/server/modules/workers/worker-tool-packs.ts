import type { AgentStore } from "../agent/agent-store.js";
import { buildArchiveWorkerTool } from "./tools/archive-worker.js";
import { buildCreateWorkerTool } from "./tools/create-worker.js";
import { buildGetWorkerStatusTool } from "./tools/get-worker-status.js";
import { buildListWorkersTool } from "./tools/list-workers.js";
import { buildReadWorkerThreadTool } from "./tools/read-worker-thread.js";
import { buildRestoreWorkerTool } from "./tools/restore-worker.js";
import type { WorkersStore } from "./workers-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { MemoryManager } from "../memory/manager.js";
import type { LifecyclePublisher } from "../../runtime/events.js";
import type { TmuxRuntime } from "../../runtime/runtimes/tmux-runtime.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { TmuxSnapshot } from "../../platform/tmux/tmux-types.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { GitClient } from "../../platform/git/git.js";
import type { TaskListItem } from "../../runtime/task-list.js";

export function buildWorkerCatalogToolPacks(input: {
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  workersStore: WorkersStore;
  getSnapshot: () => TmuxSnapshot | null;
  /** A conversation's queued and running tasks: get_worker_status names its worker's. */
  tasksOfThread?: (threadId: string) => TaskListItem[];
}): ToolPack[] {
  return [
    toolPack("workers.catalog", ["manager"], [
      buildListWorkersTool({
        workersStore: input.workersStore,
        projectsStore: input.projectsStore,
        agentStore: input.agentStore
      }),
      buildGetWorkerStatusTool({
        workersStore: input.workersStore,
        projectsStore: input.projectsStore,
        getSnapshot: input.getSnapshot,
        agentStore: input.agentStore,
        ...(input.tasksOfThread ? { tasksOfThread: input.tasksOfThread } : {})
      }),
      buildReadWorkerThreadTool({
        agentStore: input.agentStore,
        workersStore: input.workersStore
      })
    ])
  ];
}

export function buildWorkerLifecycleToolPacks(input: {
  agentStore: AgentStore;
  projectsStore: ProjectsStore;
  workersStore: WorkersStore;
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  tmuxRuntime: TmuxRuntime;
  publishLifecycle: LifecyclePublisher;
  beforeWorkerArchive?: (workerId: string) => void;
  memory?: MemoryManager | null;
}): ToolPack[] {
  return [
    toolPack("workers.lifecycle", ["manager"], [
      buildCreateWorkerTool({
        workersStore: input.workersStore,
        projectsStore: input.projectsStore,
        agentStore: input.agentStore,
        tmuxClient: input.tmuxClient,
        gitClient: input.gitClient,
        tmuxRuntime: input.tmuxRuntime,
        broadcast: input.publishLifecycle,
        projectMemoryHint: (projectId) => {
          const project = input.projectsStore.getById(projectId);
          return project && input.memory?.getBrief("project", projectId)
            ? `${project.name} has memory: read its brief with memory_read({ target: "project", project: "${project.name}" }) before directing the worker.`
            : null;
        }
      }),
      buildArchiveWorkerTool({
        workersStore: input.workersStore,
        projectsStore: input.projectsStore,
        agentStore: input.agentStore,
        tmuxClient: input.tmuxClient,
        gitClient: input.gitClient,
        tmuxRuntime: input.tmuxRuntime,
        broadcast: input.publishLifecycle,
        beforeWorkerArchive: input.beforeWorkerArchive
      }),
      buildRestoreWorkerTool({
        workersStore: input.workersStore,
        projectsStore: input.projectsStore,
        agentStore: input.agentStore,
        tmuxClient: input.tmuxClient,
        gitClient: input.gitClient,
        tmuxRuntime: input.tmuxRuntime,
        broadcast: input.publishLifecycle
      })
    ])
  ];
}
