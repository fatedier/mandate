import { existsSync } from "node:fs";
import type { Hono } from "hono";
import {
  API_ROUTES,
  type WorkerChangesFileResponse,
  type WorkerChangesResponse
} from "../../../shared/api-contracts.js";
import type { GitClient } from "../../platform/git/git.js";
import {
  gitDiffFile,
  gitDiffNames,
  gitDiffSummary,
  gitMergeBase,
  type GitChangedName
} from "../../platform/git/git-diff.js";
import { resolveWorkerBaseRef } from "../../platform/git/git-archive-check.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { WorkersStore } from "../workers/workers-store.js";

interface GitApiDeps {
  projects: ProjectsStore;
  workers: WorkersStore;
  gitClient?: GitClient;
}

// The summary endpoint primes this per-worker cache; a file fetch within
// the TTL validates membership against it and spawns only the patch diff.
// Misses (cold, expired, or a file created after priming) recompute fresh,
// so correctness never depends on cache state — only latency does.
const NAMES_CACHE_TTL_MS = 5000;

interface NamesCacheEntry {
  at: number;
  against: string;
  names: GitChangedName[];
  /** Which read of the key it came from: reads end in any order now that git
   *  runs while the server goes on, and an older one never replaces a newer. */
  read: number;
}

/**
 * What the working tree is compared against.
 *
 * `head` answers "what is being changed right now" and is the default: it needs
 * no base ref, so it cannot go stale, cannot be orphaned by a history rewrite,
 * and cannot bury the answer. Against a stale base, the branch comparison
 * lists far more files than the work touched, and it fails outright for a
 * branch that shares no ancestor with `main` after a rewrite.
 *
 * `branch` answers "what has this worker changed in total" and still needs a
 * base, with everything that costs.
 */
type CompareMode = "head" | "branch";

function compareModeFrom(value: string | undefined): CompareMode {
  return value === "branch" ? "branch" : "head";
}

const cacheKey = (workerId: string, mode: CompareMode) => `${workerId}:${mode}`;

export function mountGitRoutes(app: Hono, deps: GitApiDeps): void {
  const namesCache = new Map<string, NamesCacheEntry>();
  const reads = new Map<string, number>();
  const startRead = (key: string): number => {
    const read = (reads.get(key) ?? 0) + 1;
    reads.set(key, read);
    return read;
  };
  const keepNames = (key: string, entry: NamesCacheEntry) => {
    const kept = namesCache.get(key);
    if (!kept || kept.read <= entry.read) namesCache.set(key, entry);
  };
  // git runs while the server goes on: the diff of a large tree takes a
  // quarter of a second and more.
  app.get(API_ROUTES.workerChanges, async (c) => {
    const workerId = c.req.param("workerId");
    const mode = compareModeFrom(c.req.query("compare"));
    const dir = resolveWorkerDir(workerId, deps);
    if (!dir.ok) return c.json({ error: dir.error, ...(dir.code ? { code: dir.code } : {}) }, dir.status);

    // Only the branch comparison needs a base. Resolving one for `head` would
    // reintroduce every way that can fail into the view that exists because it
    // cannot fail.
    const read = startRead(cacheKey(workerId, mode));
    let against = "HEAD";
    let baseRef = "HEAD";
    if (mode === "branch") {
      const resolved = await resolveMergeBase(dir.value);
      // Gone while git looked (its worktree with it): that, not git's failure.
      const still = resolveWorkerDir(workerId, deps);
      if (!still.ok) return c.json({ error: still.error, ...(still.code ? { code: still.code } : {}) }, still.status);
      if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
      against = resolved.value.mergeBase;
      baseRef = resolved.value.baseRef;
    }
    const { repoDir, gitClient } = dir.value;
    const summary = await gitDiffSummary(repoDir, against, gitClient);
    // The worker may have been archived (or its worktree removed) while git ran.
    const still = resolveWorkerDir(workerId, deps);
    if (!still.ok) return c.json({ error: still.error, ...(still.code ? { code: still.code } : {}) }, still.status);
    if (!summary) return c.json({ error: "git diff failed" }, 500);
    keepNames(cacheKey(workerId, mode), {
      at: Date.now(),
      against: summary.mergeBase,
      names: summary.files.map((f) => ({
        path: f.path,
        oldPath: f.oldPath,
        status: f.status,
        untracked: f.untracked
      })),
      read
    });
    return c.json({
      compare: mode,
      baseRef,
      mergeBase: summary.mergeBase,
      head: summary.head,
      files: summary.files,
      totalAdditions: summary.totalAdditions,
      totalDeletions: summary.totalDeletions
    } satisfies WorkerChangesResponse);
  });

  app.get(API_ROUTES.workerChangesFile, async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path query param is required" }, 400);
    const workerId = c.req.param("workerId");
    const mode = compareModeFrom(c.req.query("compare"));
    const dir = resolveWorkerDir(workerId, deps);
    if (!dir.ok) return c.json({ error: dir.error, ...(dir.code ? { code: dir.code } : {}) }, dir.status);
    const { repoDir, gitClient } = dir.value;

    // Membership gates every read (rejects traversal and anything outside
    // the change set). Fast path: the names cache primed by the summary —
    // a hit means the only subprocess this request runs is the patch diff.
    // The cache is keyed by mode: the two comparisons have different change
    // sets, and membership is what gates every read here.
    const cached = namesCache.get(cacheKey(workerId, mode));
    const fromCache =
      cached && Date.now() - cached.at <= NAMES_CACHE_TTL_MS
        ? cached.names.find((f) => f.path === filePath)
        : undefined;
    let hit = fromCache && cached ? { against: cached.against, entry: fromCache } : undefined;

    if (!hit) {
      const read = startRead(cacheKey(workerId, mode));
      let against = "HEAD";
      if (mode === "branch") {
        const resolved = await resolveMergeBase(dir.value);
        const still = resolveWorkerDir(workerId, deps);
        if (!still.ok) return c.json({ error: still.error, ...(still.code ? { code: still.code } : {}) }, still.status);
        if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
        against = resolved.value.mergeBase;
      }
      const names = await gitDiffNames(repoDir, against, gitClient);
      const still = resolveWorkerDir(workerId, deps);
      if (!still.ok) return c.json({ error: still.error, ...(still.code ? { code: still.code } : {}) }, still.status);
      if (!names) return c.json({ error: "git diff failed" }, 500);
      keepNames(cacheKey(workerId, mode), { at: Date.now(), against, names, read });
      const entry = names.find((f) => f.path === filePath);
      if (!entry) return c.json({ error: "path is not part of this change set" }, 404);
      hit = { against, entry };
    }

    const diff = await gitDiffFile(
      repoDir,
      hit.against,
      filePath,
      { untracked: hit.entry.untracked, oldPath: hit.entry.oldPath },
      gitClient
    );
    const still = resolveWorkerDir(workerId, deps);
    if (!still.ok) return c.json({ error: still.error, ...(still.code ? { code: still.code } : {}) }, still.status);
    if (!diff) return c.json({ error: "git diff failed" }, 500);
    return c.json({
      path: filePath,
      patch: diff.patch,
      truncated: diff.truncated,
      binary: diff.binary
    } satisfies WorkerChangesFileResponse);
  });
}

interface ResolvedWorkerDir {
  repoDir: string;
  workingDir: string;
  /** The worker's own branch; null for one that works in the project's
   *  directory on whatever branch that is on. */
  branch: string | null;
  baseRefHint: string | null;
  workerId: string;
  gitClient: GitClient | undefined;
}

interface ResolvedWorkerRepo extends ResolvedWorkerDir {
  baseRef: string;
  mergeBase: string;
}

type ResolveError = { ok: false; status: 400 | 404 | 409; error: string; code?: "worktree_missing" };

/** Store/host/worktree validation only — no git subprocesses. */
function resolveWorkerDir(
  workerId: string,
  deps: GitApiDeps
): { ok: true; value: ResolvedWorkerDir } | ResolveError {
  const worker = deps.workers.getById(workerId);
  if (!worker || worker.archivedAt) return { ok: false, status: 404, error: "worker not found" };
  const project = deps.projects.getById(worker.projectId);
  if (!project || project.archivedAt) return { ok: false, status: 404, error: "project not found" };
  if (!project.isGit) return { ok: false, status: 400, error: "project is not a git project" };

  const gitClient = deps.gitClient;
  // A worker with no worktree of its own works in the project's directory,
  // one with no branch of its own among them: what is uncommitted there is
  // read all the same, and is everyone's who works in that directory.
  const repoDir = worker.worktreePath ?? project.workingDir;
  if (worker.worktreePath && !existsSync(worker.worktreePath)) {
    return {
      ok: false,
      status: 409,
      code: "worktree_missing",
      error: `The worktree folder ${worker.worktreePath} is missing. Archive the worker from its ⋯ menu if it's finished.`
    };
  }
  return {
    ok: true,
    value: { repoDir, workingDir: project.workingDir, branch: worker.branch, baseRefHint: worker.baseRef, workerId, gitClient }
  };
}

/** The git half of resolution: base ref + merge base (1-4 subprocesses). */
async function resolveMergeBase(
  dir: ResolvedWorkerDir
): Promise<{ ok: true; value: ResolvedWorkerRepo } | ResolveError> {
  // A worker with no branch of its own has no base: with none recorded, the
  // base resolves to whatever the shared directory is on, or was last rebased
  // onto by anyone, and the answer would mean nothing.
  if (!dir.branch) return { ok: false, status: 400, error: "this worker has no branch of its own to compare from a base" };
  // A rebase moves the fork without touching `base_ref`, and git recorded what
  // it was rebased onto. Preferred over the stored value, which then reads as
  // what it is: where the branch was created from.
  const baseRef = await resolveWorkerBaseRef(
    { repoDir: dir.repoDir, workingDir: dir.workingDir, baseRefHint: dir.baseRefHint },
    dir.gitClient
  );
  if (!baseRef) return { ok: false, status: 409, error: "could not resolve a base ref for this project" };
  const mergeBase = await gitMergeBase(dir.repoDir, baseRef, dir.gitClient);
  if (!mergeBase) {
    return { ok: false, status: 409, error: `could not compute merge-base against '${baseRef}'` };
  }
  return { ok: true, value: { ...dir, baseRef, mergeBase } };
}
