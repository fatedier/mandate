import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { workerRowToDto, restoreWorkerMaterialization } from "../worker-service.js";
import type { WorkersStore } from "../workers-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { LifecyclePublisher } from "../../../runtime/events.js";
import type { TmuxClient } from "../../../platform/tmux/tmux.js";
import type { GitClient } from "../../../platform/git/git.js";
import type { TmuxRuntime } from "../../../runtime/runtimes/tmux-runtime.js";
import { params } from "./restore-worker-schema.js";

interface Result {
  ok?: true;
  workerId?: string;
  error?: string;
}

interface RestoreWorkerDeps {
  workersStore: WorkersStore;
  projectsStore: ProjectsStore;
  agentStore: AgentStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  tmuxRuntime: TmuxRuntime;
  broadcast: LifecyclePublisher;
  refreshTmux?: () => void;
}

export function buildRestoreWorkerTool(deps: RestoreWorkerDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "restore_worker",
    description: "Restore an archived worker by recreating its tmux window and, when needed, its worktree/branch. Pass branch/worktreePath/tmuxWindowName to avoid restore conflicts.",
    parameters: params,
    handler: async ({ workerId, mode, branch, baseRef, worktreePath, tmuxWindowName }, ctx) => {
      // The thread that brings a worker back owns it from then on
      // — set in the restore's own write, so the change it
      // announces arms this thread's sweep and not the old owner's.
      const owner = ctx.threadId;
      const r = await restoreWorkerMaterialization(
        { id: workerId, mode, branch, baseRef, worktreePath, tmuxWindowName, ownerThreadId: owner },
        {
          projects: deps.projectsStore,
          workers: deps.workersStore,
          tmuxClient: deps.tmuxClient,
          gitClient: deps.gitClient,
          agentStore: deps.agentStore,
          tmuxRuntime: deps.tmuxRuntime,
          broadcast: deps.broadcast,
          refreshTmux: deps.refreshTmux
        }
      );
      if (!r.ok) return { error: r.error };
      const restored = deps.workersStore.getById(workerId) ?? r.worker;
      deps.broadcast({ type: "workerRestored", data: workerRowToDto(restored) });
      deps.broadcast({ type: "workerOwnerChanged", data: { id: workerId, ownerThreadId: owner } });
      return { ok: true, workerId };
    }
  };
}
