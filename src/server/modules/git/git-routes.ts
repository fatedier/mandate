import { existsSync } from "node:fs";
import type { Hono } from "hono";
import {
  API_ROUTES,
  type FeatureChangesFileResponse,
  type FeatureChangesResponse
} from "../../../shared/api-contracts.js";
import type { GitClient } from "../../platform/git/git.js";
import {
  gitDiffFile,
  gitDiffNames,
  gitDiffSummary,
  gitMergeBase,
  type GitChangedName
} from "../../platform/git/git-diff.js";
import { resolveFeatureBaseRef } from "../../platform/git/git-archive-check.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { FeaturesStore } from "../features/features-store.js";

interface GitApiDeps {
  projects: ProjectsStore;
  features: FeaturesStore;
  gitClient?: GitClient;
}

// The summary endpoint primes this per-feature cache; a file fetch within
// the TTL validates membership against it and spawns only the patch diff.
// Misses (cold, expired, or a file created after priming) recompute fresh,
// so correctness never depends on cache state — only latency does.
const NAMES_CACHE_TTL_MS = 5000;

interface NamesCacheEntry {
  at: number;
  against: string;
  names: GitChangedName[];
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
 * `branch` answers "what has this feature changed in total" and still needs a
 * base, with everything that costs.
 */
type CompareMode = "head" | "branch";

function compareModeFrom(value: string | undefined): CompareMode {
  return value === "branch" ? "branch" : "head";
}

const cacheKey = (featureId: string, mode: CompareMode) => `${featureId}:${mode}`;

export function mountGitRoutes(app: Hono, deps: GitApiDeps): void {
  const namesCache = new Map<string, NamesCacheEntry>();
  app.get(API_ROUTES.featureChanges, (c) => {
    const featureId = c.req.param("featureId");
    const mode = compareModeFrom(c.req.query("compare"));
    const dir = resolveFeatureDir(featureId, deps);
    if (!dir.ok) return c.json({ error: dir.error, ...(dir.code ? { code: dir.code } : {}) }, dir.status);

    // Only the branch comparison needs a base. Resolving one for `head` would
    // reintroduce every way that can fail into the view that exists because it
    // cannot fail.
    let against = "HEAD";
    let baseRef = "HEAD";
    if (mode === "branch") {
      const resolved = resolveMergeBase(dir.value);
      if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
      against = resolved.value.mergeBase;
      baseRef = resolved.value.baseRef;
    }
    const { repoDir, gitClient } = dir.value;
    const summary = gitDiffSummary(repoDir, against, gitClient);
    if (!summary) return c.json({ error: "git diff failed" }, 500);
    namesCache.set(cacheKey(featureId, mode), {
      at: Date.now(),
      against: summary.mergeBase,
      names: summary.files.map((f) => ({
        path: f.path,
        oldPath: f.oldPath,
        status: f.status,
        untracked: f.untracked
      }))
    });
    return c.json({
      compare: mode,
      baseRef,
      mergeBase: summary.mergeBase,
      head: summary.head,
      files: summary.files,
      totalAdditions: summary.totalAdditions,
      totalDeletions: summary.totalDeletions
    } satisfies FeatureChangesResponse);
  });

  app.get(API_ROUTES.featureChangesFile, (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path query param is required" }, 400);
    const featureId = c.req.param("featureId");
    const mode = compareModeFrom(c.req.query("compare"));
    const dir = resolveFeatureDir(featureId, deps);
    if (!dir.ok) return c.json({ error: dir.error, ...(dir.code ? { code: dir.code } : {}) }, dir.status);
    const { repoDir, gitClient } = dir.value;

    // Membership gates every read (rejects traversal and anything outside
    // the change set). Fast path: the names cache primed by the summary —
    // a hit means the only subprocess this request runs is the patch diff.
    // The cache is keyed by mode: the two comparisons have different change
    // sets, and membership is what gates every read here.
    const cached = namesCache.get(cacheKey(featureId, mode));
    const fromCache =
      cached && Date.now() - cached.at <= NAMES_CACHE_TTL_MS
        ? cached.names.find((f) => f.path === filePath)
        : undefined;
    let hit = fromCache && cached ? { against: cached.against, entry: fromCache } : undefined;

    if (!hit) {
      let against = "HEAD";
      if (mode === "branch") {
        const resolved = resolveMergeBase(dir.value);
        if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
        against = resolved.value.mergeBase;
      }
      const names = gitDiffNames(repoDir, against, gitClient);
      if (!names) return c.json({ error: "git diff failed" }, 500);
      namesCache.set(cacheKey(featureId, mode), { at: Date.now(), against, names });
      const entry = names.find((f) => f.path === filePath);
      if (!entry) return c.json({ error: "path is not part of this change set" }, 404);
      hit = { against, entry };
    }

    const diff = gitDiffFile(
      repoDir,
      hit.against,
      filePath,
      { untracked: hit.entry.untracked, oldPath: hit.entry.oldPath },
      gitClient
    );
    if (!diff) return c.json({ error: "git diff failed" }, 500);
    return c.json({
      path: filePath,
      patch: diff.patch,
      truncated: diff.truncated,
      binary: diff.binary
    } satisfies FeatureChangesFileResponse);
  });
}

interface ResolvedFeatureDir {
  repoDir: string;
  workingDir: string;
  /** The worker's own branch; null for one that works in the project's
   *  directory on whatever branch that is on. */
  branch: string | null;
  baseRefHint: string | null;
  featureId: string;
  gitClient: GitClient | undefined;
}

interface ResolvedFeatureRepo extends ResolvedFeatureDir {
  baseRef: string;
  mergeBase: string;
}

type ResolveError = { ok: false; status: 400 | 404 | 409; error: string; code?: "worktree_missing" };

/** Store/host/worktree validation only — no git subprocesses. */
function resolveFeatureDir(
  featureId: string,
  deps: GitApiDeps
): { ok: true; value: ResolvedFeatureDir } | ResolveError {
  const feature = deps.features.getById(featureId);
  if (!feature || feature.archivedAt) return { ok: false, status: 404, error: "feature not found" };
  const project = deps.projects.getById(feature.projectId);
  if (!project || project.archivedAt) return { ok: false, status: 404, error: "project not found" };
  if (!project.isGit) return { ok: false, status: 400, error: "project is not a git project" };

  const gitClient = deps.gitClient;
  // A worker with no worktree of its own works in the project's directory,
  // one with no branch of its own among them: what is uncommitted there is
  // read all the same, and is everyone's who works in that directory.
  const repoDir = feature.worktreePath ?? project.workingDir;
  if (feature.worktreePath && !existsSync(feature.worktreePath)) {
    return {
      ok: false,
      status: 409,
      code: "worktree_missing",
      error: `The worktree folder ${feature.worktreePath} is missing. Archive the worker from its ⋯ menu if it's finished.`
    };
  }
  return {
    ok: true,
    value: { repoDir, workingDir: project.workingDir, branch: feature.branch, baseRefHint: feature.baseRef, featureId, gitClient }
  };
}

/** The git half of resolution: base ref + merge base (1-4 subprocesses). */
function resolveMergeBase(
  dir: ResolvedFeatureDir
): { ok: true; value: ResolvedFeatureRepo } | ResolveError {
  // A worker with no branch of its own has no base: with none recorded, the
  // base resolves to whatever the shared directory is on, or was last rebased
  // onto by anyone, and the answer would mean nothing.
  if (!dir.branch) return { ok: false, status: 400, error: "this worker has no branch of its own to compare from a base" };
  // A rebase moves the fork without touching `base_ref`, and git recorded what
  // it was rebased onto. Preferred over the stored value, which then reads as
  // what it is: where the branch was created from.
  const baseRef = resolveFeatureBaseRef(
    { repoDir: dir.repoDir, workingDir: dir.workingDir, baseRefHint: dir.baseRefHint },
    dir.gitClient
  );
  if (!baseRef) return { ok: false, status: 409, error: "could not resolve a base ref for this project" };
  const mergeBase = gitMergeBase(dir.repoDir, baseRef, dir.gitClient);
  if (!mergeBase) {
    return { ok: false, status: 409, error: `could not compute merge-base against '${baseRef}'` };
  }
  return { ok: true, value: { ...dir, baseRef, mergeBase } };
}
