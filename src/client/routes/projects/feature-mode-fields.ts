import type { FeatureMode } from "@shared/api-contracts";
export type { FeatureMode } from "@shared/api-contracts";

interface FieldVisibility {
  showBranch: boolean;
  showBaseRef: boolean;
  showWorktreePath: boolean;
  branchSource: "none" | "new" | "existing";
}

export function fieldsForMode(mode: FeatureMode): FieldVisibility {
  switch (mode) {
    case "shared-cwd":
      return { showBranch: false, showBaseRef: false, showWorktreePath: false, branchSource: "none" };
    case "new-branch-new-worktree":
      return { showBranch: true, showBaseRef: true, showWorktreePath: false, branchSource: "new" };
    case "existing-branch-new-worktree":
      return { showBranch: true, showBaseRef: false, showWorktreePath: false, branchSource: "existing" };
    case "existing-branch-existing-worktree":
      return { showBranch: true, showBaseRef: false, showWorktreePath: true, branchSource: "existing" };
  }
}
