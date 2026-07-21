import type { ApiErrorResponse } from "./common.js";

export type FeatureMode =
  | "shared-cwd"
  | "new-branch-new-worktree"
  | "existing-branch-new-worktree"
  | "existing-branch-existing-worktree";

export type FeatureOwnership = "app" | "adopted";

export interface FeatureDto {
  id: string;
  projectId: string;
  name: string;
  mode: FeatureMode;
  branch: string | null;
  baseRef: string | null;
  worktreePath: string | null;
  tmuxWindowName: string;
  ownership: FeatureOwnership;
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface FeatureStateDto extends FeatureDto {
  tmuxAlive: boolean;
  tmuxStatus?: "alive" | "gone";
}

export type CreateFeatureRequest = Pick<FeatureDto, "name" | "mode"> & {
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
};

export type RestoreFeatureRequest = {
  mode?: FeatureMode;
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
  tmuxWindowName?: string;
};

export type CreateFeatureResponse = FeatureDto | ApiErrorResponse;
