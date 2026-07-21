import type { FeatureRow } from "../features/features-store.js";
import type { ProjectRow } from "./projects-store.js";

export interface ReconcileTmux {
  hasSession(name: string): boolean;
  newSession(name: string, cwd: string): void;
  hasWindow(session: string, windowName: string): boolean;
  newWindow(session: string, windowName: string, cwd: string): void;
}

export interface ReconcileResult {
  rebuilt?: boolean;
  broken?: boolean;
}

export function reconcileProject(
  project: ProjectRow,
  activeFeatures: FeatureRow[],
  tmux: ReconcileTmux
): ReconcileResult {
  const exists = tmux.hasSession(project.tmuxSessionName);

  if (project.ownership === "app") {
    if (!exists) {
      tmux.newSession(project.tmuxSessionName, project.workingDir);
      for (const feature of activeFeatures) {
        reconcileFeature(feature, project, tmux);
      }
      return { rebuilt: true };
    }
    return { rebuilt: false };
  }

  // adopted
  return exists ? { rebuilt: false } : { broken: true };
}

export function reconcileFeature(
  feature: FeatureRow,
  project: ProjectRow,
  tmux: ReconcileTmux
): ReconcileResult {
  const exists = tmux.hasWindow(project.tmuxSessionName, feature.tmuxWindowName);
  if (exists) return { rebuilt: false };

  if (feature.ownership === "app") {
    const cwd = feature.worktreePath ?? project.workingDir;
    tmux.newWindow(project.tmuxSessionName, feature.tmuxWindowName, cwd);
    return { rebuilt: true };
  }

  return { broken: true };
}
