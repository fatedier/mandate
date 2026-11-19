import type {
  WorkerDto,
  ProjectStateDto
} from "../../../shared/api-contracts.js";
import type { ProjectRow } from "./projects-store.js";
import type { WorkerRow } from "../workers/workers-store.js";

/**
 * Pure-logic computation of the projects-with-drift DTO.
 * `tmuxState` maps `sessionName` to its window names.
 *
 */
export function computeProjectsState(
  projects: ProjectRow[],
  workers: WorkerRow[],
  tmuxState: Map<string, string[]>
): ProjectStateDto[] {
  return projects.map((p) => {
    const projectWorkers = workers
      .filter((w) => w.projectId === p.id)
      .map((worker): WorkerDto => {
        return {
          id: worker.id,
          projectId: worker.projectId,
          name: worker.name,
          mode: worker.mode,
          branch: worker.branch,
          baseRef: worker.baseRef,
          worktreePath: worker.worktreePath,
          tmuxWindowName: worker.tmuxWindowName,
          ownership: worker.ownership,
          createdAt: worker.createdAt,
          pinnedAt: worker.pinnedAt,
          updatedAt: worker.updatedAt,
          archivedAt: worker.archivedAt,
          ownerThreadId: worker.ownerThreadId
        };
      });
    return {
      id: p.id,
      name: p.name,
      workingDir: p.workingDir,
      isGit: p.isGit,
      gitRemote: p.gitRemote,
      tmuxSessionName: p.tmuxSessionName,
      ownership: p.ownership,
      sortOrder: p.sortOrder,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      archivedAt: p.archivedAt,
      tmuxStatus: tmuxState.has(p.tmuxSessionName) ? "alive" : "gone",
      workers: projectWorkers
    };
  });
}

