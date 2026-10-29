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
  /** The manager thread that started this worker; null only for workers archived before threads existed. */
  ownerThreadId: string | null;
}

export interface FeatureStateDto extends FeatureDto {
  tmuxAlive: boolean;
  tmuxStatus?: "alive" | "gone";
}

export type CreateFeatureRequest = Pick<FeatureDto, "name" | "mode"> & {
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
  /** The thread that owns the new worker; without it a thread named after the worker is opened. */
  ownerThreadId?: string;
};

export type RestoreFeatureRequest = {
  mode?: FeatureMode;
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
  tmuxWindowName?: string;
};

/** What archiving a worker would lose. */
export interface ArchiveCheckDto {
  /** Uncommitted files in the worker's own worktree; null when it has none to check. */
  dirtyFiles: number | null;
  /** Commits on the branch whose changes are not in the base; null when there is no branch to check. */
  unmergedCommits: number | null;
  branch: string | null;
  baseRef: string | null;
  /** One sentence per problem, e.g. "3 uncommitted files in the worktree." Empty = safe. */
  findings: string[];
}
