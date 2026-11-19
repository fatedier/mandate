export interface WorkerChangedFileDto {
  path: string;
  oldPath: string | null;
  status: "A" | "M" | "D" | "R";
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  uncommitted: boolean;
  /** file is not tracked by git at all (as opposed to tracked-but-dirty) */
  untracked: boolean;
}

export interface WorkerChangesResponse {
  /** What the working tree was compared against. `head` shows only what is
   *  uncommitted; `branch` shows everything since the worker forked. */
  compare: "head" | "branch";
  /** The ref named in the UI. `HEAD` in head mode. */
  baseRef: string;
  mergeBase: string;
  head: string;
  files: WorkerChangedFileDto[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface WorkerChangesFileResponse {
  path: string;
  patch: string;
  truncated: boolean;
  binary: boolean;
}
