import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { createWorkerWithMaterialization } from "../worker-service.js";
import type { WorkersStore } from "../workers-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { LifecyclePublisher } from "../../../runtime/events.js";
import type { TmuxClient } from "../../../platform/tmux/tmux.js";
import type { GitClient } from "../../../platform/git/git.js";
import type { TmuxRuntime } from "../../../runtime/runtimes/tmux-runtime.js";
import { params } from "./create-worker-schema.js";

interface Result {
  ok?: true;
  workerId?: string;
  workerName?: string;
  /** URL-safe worker identifier: the worker's part of a page address. */
  workerSlug?: string;
  /** Where the worker's project memory is, when it has a brief. */
  memory?: string;
  error?: string;
}

interface CreateWorkerDeps {
  workersStore: WorkersStore;
  projectsStore: ProjectsStore;
  agentStore: AgentStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  tmuxRuntime: TmuxRuntime;
  broadcast: LifecyclePublisher;
  /** A line pointing at the project's brief, or null when it has none. */
  projectMemoryHint?: (projectId: string) => string | null;
}

export function buildCreateWorkerTool(deps: CreateWorkerDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "create_worker",
    description: "Create a new worker inside a project: a tmux window and, for worktree modes, a git worktree. For new-branch-new-worktree, pass baseRef when the user specifies which branch/tag/commit to branch from; otherwise the backend resolves a default base.",
    parameters: params,
    handler: async (input, ctx) => {
      // The thread that starts a worker owns it.
      const r = await createWorkerWithMaterialization({ ...input, ownerThreadId: ctx.threadId }, {
        workers: deps.workersStore,
        projects: deps.projectsStore,
        agentStore: deps.agentStore,
        tmuxClient: deps.tmuxClient,
        gitClient: deps.gitClient,
        tmuxRuntime: deps.tmuxRuntime
      });
      if (!r.ok) return { error: r.error };
      deps.broadcast({ type: "workerCreated", data: r.worker });
      const hint = deps.projectMemoryHint?.(r.worker.projectId) ?? null;
      return {
        ok: true,
        workerId: r.worker.id,
        workerName: r.worker.name,
        workerSlug: r.worker.tmuxWindowName,
        ...(hint ? { memory: hint } : {})
      };
    }
  };
}
