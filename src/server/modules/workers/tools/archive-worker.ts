import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import { archiveWorkerCascade, type ArchiveWorkerCleanupFailure } from "../worker-service.js";
import { ownerRefusal } from "../ownership.js";
import type { ArchiveCheckDto } from "../../../../shared/api/workers.js";
import type { WorkersStore } from "../workers-store.js";
import type { ProjectsStore } from "../../projects/projects-store.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { LifecyclePublisher } from "../../../runtime/events.js";
import type { TmuxClient } from "../../../platform/tmux/tmux.js";
import type { GitClient } from "../../../platform/git/git.js";
import type { TmuxRuntime } from "../../../runtime/runtimes/tmux-runtime.js";
import { params } from "./archive-worker-schema.js";

interface Result {
  ok?: true;
  workerId?: string;
  error?: string;
  cleanupFailures?: ArchiveWorkerCleanupFailure[];
  /** What the refusal found: uncommitted files, unmerged commits. */
  check?: ArchiveCheckDto;
}

interface ArchiveWorkerDeps {
  workersStore: WorkersStore;
  projectsStore: ProjectsStore;
  agentStore: AgentStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  tmuxRuntime: TmuxRuntime;
  broadcast: LifecyclePublisher;
  refreshTmux?: () => void;
  beforeWorkerArchive?: (workerId: string) => void;
}

export function buildArchiveWorkerTool(deps: ArchiveWorkerDeps): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "archive_worker",
    description: "Archive a finished worker: hide it from active work and release its tmux window, worktree and branch. The record, chat, plan and reports are kept; restore_worker brings the workspace back. Archive only after the user confirmed the work is done (merged, or they said so). The call refuses when the worktree has uncommitted files or the branch has work not in its base, and returns what it found: ask the user, and pass confirmedByUser only after they said to archive anyway.",
    parameters: params,
    handler: async ({ workerId, removeWorktree, forceRemoveWorktree, deleteBranch, forceDeleteBranch, confirmedByUser }, ctx) => {
      const refusal = ownerRefusal({ workersStore: deps.workersStore, agentStore: deps.agentStore }, workerId, ctx.threadId);
      if (refusal) return { error: refusal };
      const r = await archiveWorkerCascade(
        {
          id: workerId,
          by: ctx.threadId,
          cleanup: { removeWorktree, forceRemoveWorktree, deleteBranch, forceDeleteBranch },
          confirmed: confirmedByUser
        },
        {
          projects: deps.projectsStore,
          workers: deps.workersStore,
          tmuxClient: deps.tmuxClient,
          gitClient: deps.gitClient,
          agentStore: deps.agentStore,
          tmuxRuntime: deps.tmuxRuntime,
          broadcast: deps.broadcast,
          refreshTmux: deps.refreshTmux,
          beforeWorkerArchive: deps.beforeWorkerArchive
        }
      );
      if (!r.ok) return { error: r.error, cleanupFailures: r.cleanupFailures, ...(r.check ? { check: r.check } : {}) };
      deps.broadcast({ type: "workerArchived", data: { id: workerId, projectId: r.worker.projectId } });
      return { ok: true, workerId, cleanupFailures: r.cleanupFailures?.length ? r.cleanupFailures : undefined };
    }
  };
}
