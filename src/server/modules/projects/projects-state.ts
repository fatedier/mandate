import type {
  FeatureStateDto,
  ProjectStateDto
} from "../../../shared/api-contracts.js";
import type { ProjectRow } from "./projects-store.js";
import type { FeatureRow } from "../features/features-store.js";

/**
 * Pure-logic computation of the projects-with-drift DTO.
 * `tmuxState` maps `sessionName` to its window names.
 *
 */
export function computeProjectsState(
  projects: ProjectRow[],
  features: FeatureRow[],
  tmuxState: Map<string, string[]>
): ProjectStateDto[] {
  return projects.map((p) => {
    const sessionWindows = tmuxState.get(tmuxStateKey(p.tmuxSessionName));
    const projectAlive = sessionWindows !== undefined;
    const projectTmuxStatus = projectAlive ? "alive" : "gone";
    const projectFeatures = features
      .filter((f) => f.projectId === p.id)
      .map((f): FeatureStateDto => {
        const featureAlive = projectAlive && (sessionWindows ?? []).includes(f.tmuxWindowName);
        return {
          id: f.id,
          projectId: f.projectId,
          name: f.name,
          mode: f.mode,
          branch: f.branch,
          baseRef: f.baseRef,
          worktreePath: f.worktreePath,
          tmuxWindowName: f.tmuxWindowName,
          ownership: f.ownership,
          createdAt: f.createdAt,
          pinnedAt: f.pinnedAt,
          updatedAt: f.updatedAt,
          archivedAt: f.archivedAt,
          tmuxAlive: featureAlive,
          tmuxStatus: featureAlive ? "alive" : "gone"
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
      tmuxAlive: projectAlive,
      tmuxStatus: projectTmuxStatus,
      features: projectFeatures
    };
  });
}

export function tmuxStateKey(sessionName: string) {
  return sessionName;
}
