import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentStore } from "../agent/agent-store.js";
import type { FeaturesStore, FeatureMode, FeatureRow } from "./features-store.js";
import type { FeatureDto } from "../../../shared/api-contracts.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { worktreePathFor } from "../../platform/fs/data-dir.js";
import { gitArchiveCheck } from "../../platform/git/git-archive-check.js";
import type { ArchiveCheckDto } from "../../../shared/api/features.js";
import {
  DEFAULT_GIT,
  gitBranchDelete,
  gitBranchesCreatedInWorktree,
  gitBranchIsStill,
  gitCommonDir,
  gitBranchExists,
  gitRefExists,
  gitResolveDefaultBaseRef,
  gitWorktreeAdd,
  gitWorktreeRemove,
  type GitClient
} from "../../platform/git/git.js";
import { reconcileFeature, reconcileProject } from "../projects/project-reconcile.js";
import type { LifecycleEvent, LifecyclePublisher } from "../../runtime/events.js";
import type { Pane } from "../../runtime/pane-runtime.js";
import type { PaneRuntimeRegistry } from "../../runtime/pane-runtime-registry.js";
import type { PaneMetadataStore } from "../panes/pane-metadata-store.js";
import { sanitizeFeatureName, resolveCollision } from "../../platform/naming/names.js";
import {
  type TmuxClient,
  tmuxHasWindow,
  tmuxKillWindowById,
  tmuxKillWindow
} from "../../platform/tmux/tmux.js";
import { recordingReconcileAdapter, tmuxReconcileAdapter, type OpenedWindow } from "../projects/tmux-reconcile-adapter.js";
import { CommandDidNotAnswerError } from "../../platform/process/command-runner.js";
import { errorText } from "../../../shared/error-text.js";

interface FeatureServiceDeps {
  projects: ProjectsStore;
  features: FeaturesStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  paneRuntimes: PaneRuntimeRegistry;
  paneMetadata?: PaneMetadataStore;
  agentStore?: AgentStore;
  broadcast?: LifecyclePublisher;
  refreshTmux?: () => void;
  beforeFeatureArchive?: (featureId: string) => void;
}

type CreateFeatureResult =
  | { ok: true; feature: FeatureRow }
  | { ok: false; status: number; error: string };

type ArchiveFeatureResult =
  | { ok: true; feature: FeatureRow; cleanupFailures?: ArchiveFeatureCleanupFailure[] }
  | { ok: false; status: number; error: string; cleanupFailures?: ArchiveFeatureCleanupFailure[]; check?: ArchiveCheckDto };

type RestoreFeatureResult =
  | { ok: true; feature: FeatureRow }
  | { ok: false; status: number; error: string };

export type ArchiveFeatureCleanupFailure =
  | { kind: "terminal"; windowName: string; error: string }
  | { kind: "worktree"; worktreePath: string; error: string }
  | { kind: "branch"; branch: string; error: string };

type CreateFeaturePaneResult =
  | { ok: true; pane: Pane }
  | { ok: false; status: number; error: string };

interface ArchiveFeatureCleanupOptions {
  removeWorktree?: boolean;
  forceRemoveWorktree?: boolean;
  deleteBranch?: boolean;
  forceDeleteBranch?: boolean;
}

export class FeatureService {
  constructor(private deps: FeatureServiceDeps) {}

  async create(input: {
    projectId: string;
    name: string;
    mode: unknown;
    branch?: string;
    baseRef?: string;
    worktreePath?: string;
    ownerThreadId?: string | null;
  }): Promise<CreateFeatureResult> {
    const { projectId } = input;
    const name = input.name.trim();

    const project = this.deps.projects.getById(projectId);
    if (!project) return { ok: false, status: 404, error: "project not found" };

    if (!name) return { ok: false, status: 400, error: "name is required" };

    if (!isFeatureMode(input.mode)) return { ok: false, status: 400, error: `unknown mode: ${String(input.mode)}` };
    const mode = input.mode;

    if (mode !== "shared-cwd" && !project.isGit) {
      return { ok: false, status: 400, error: `mode ${mode} requires a git project` };
    }

    const taken = this.deps.features.takenWindowNames(projectId);
    let tmuxWindowName: string;
    try {
      const base = sanitizeFeatureName(name);
      tmuxWindowName = resolveCollision(base, (n) => taken.has(n));
    } catch (err: unknown) {
      return { ok: false, status: 400, error: errorMessage(err, "name sanitization failed") };
    }

    const runtime = this.localRuntime();
    const gitClient = runtime.gitClient;
    const layout = this.createLayout(project, mode, input, runtime);
    if ("error" in layout) return { ok: false, status: 400, error: layout.error };
    const { branch, baseRef, worktreePath } = layout;

    let id: string;
    try {
      id = this.deps.features.insert({
        projectId,
        name,
        mode,
        branch,
        baseRef,
        worktreePath,
        tmuxWindowName,
        ownership: "app",
        ownerThreadId: input.ownerThreadId ?? null
      });
    } catch (err: unknown) {
      return { ok: false, status: 400, error: errorMessage(err, "insert failed") };
    }

    if (makesWorktree(mode)) {
      try {
        addWorktree(project.workingDir, mode, worktreePath!, branch!, baseRef, runtime);
      } catch (err: unknown) {
        this.archiveFailedCreate(id);
        return {
          ok: false,
          status: 500,
          error: `git worktree add failed: ${errorMessage(err)}`
        };
      }
    }

    const reconcile = recordingReconcileAdapter(tmuxReconcileAdapter(runtime.tmuxClient));
    try {
      const adapter = reconcile.adapter;
      const activeFeatures = this.deps.features.listActiveByProject(projectId);
      reconcileProject(project, activeFeatures, adapter);
      const featureRow = this.deps.features.getById(id)!;
      reconcileFeature(featureRow, project, adapter);
    } catch (err: unknown) {
      this.closeOpenedWindow(reconcile.opened, tmuxWindowName, runtime.tmuxClient);
      this.archiveFailedCreate(id);
      if (makesWorktree(mode) && worktreePath) removeAddedWorktree(project.workingDir, mode, worktreePath, branch, gitClient);
      if (err instanceof CommandDidNotAnswerError) throw err;
      return {
        ok: false,
        status: 500,
        error: `tmux materialization failed: ${errorMessage(err)}`
      };
    }

    return { ok: true, feature: this.deps.features.getById(id)! };
  }

  async createShellPane(input: { featureId: string; name?: string; description?: string }): Promise<CreateFeaturePaneResult> {
    const feature = this.deps.features.getById(input.featureId);
    if (!feature || feature.archivedAt) {
      return { ok: false, status: 404, error: "feature not found" };
    }

    const project = this.deps.projects.getById(feature.projectId);
    if (!project || project.archivedAt) {
      return { ok: false, status: 404, error: "project not found" };
    }

    const cwd = feature.worktreePath ?? project.workingDir;
    const runtime = this.deps.paneRuntimes.forProject(project.id);

    try {
      const paneBefore = firstRunningPane(await runtime.listPanes(feature.id));
      if (paneBefore) {
        this.setPaneMetadataIfRequested(project, feature, paneBefore.id, input);
        return { ok: true, pane: paneBefore };
      }

      const featureRuntime = this.localRuntime();
      const adapter = tmuxReconcileAdapter(featureRuntime.tmuxClient);
      reconcileProject(project, this.deps.features.listActiveByProject(project.id), adapter);
      reconcileFeature(feature, project, adapter);
      const paneAfterReconcile = firstRunningPane(await runtime.listPanes(feature.id));

      if (paneAfterReconcile) {
        this.setPaneMetadataIfRequested(project, feature, paneAfterReconcile.id, input);
        return { ok: true, pane: paneAfterReconcile };
      }

      const pane = await runtime.spawnPane({ featureId: feature.id, cwd });
      this.setPaneMetadataIfRequested(project, feature, pane.id, input);
      return { ok: true, pane };
    } catch (err: unknown) {
      if (err instanceof CommandDidNotAnswerError) throw err;
      return { ok: false, status: 500, error: errorMessage(err) };
    }
  }

  private setPaneMetadataIfRequested(
    project: { tmuxSessionName: string },
    feature: { id: string; tmuxWindowName: string },
    paneId: string,
    input: { name?: string; description?: string }
  ): void {
    if (input.name === undefined && input.description === undefined) return;
    this.deps.paneMetadata?.upsert({
      paneId,
      featureId: feature.id,
      sessionName: project.tmuxSessionName,
      windowName: feature.tmuxWindowName,
      name: input.name,
      description: input.description
    });
  }

  /** What archiving this worker would lose; null when the feature or its
   *  project is gone. A worker in shared-cwd mode owns no worktree or
   *  branch, so it has nothing to check. */
  archiveCheck(id: string): ArchiveCheckDto | null {
    const row = this.deps.features.getById(id);
    const project = row ? this.deps.projects.getById(row.projectId) : null;
    if (!row || !project) return null;
    if (row.mode === "shared-cwd") {
      return { dirtyFiles: null, unmergedCommits: null, branch: null, baseRef: null, findings: [] };
    }
    const worktree = row.worktreePath && fs.existsSync(row.worktreePath) ? row.worktreePath : null;
    // Uncommitted files matter only in a worktree this worker made, which
    // archiving removes. A borrowed checkout stays where it is.
    const ownsWorktree = makesWorktree(row.mode);
    return gitArchiveCheck({
      worktreePath: ownsWorktree ? worktree : null,
      repoDir: worktree ?? project.workingDir,
      workingDir: project.workingDir,
      branch: row.branch,
      baseRefHint: row.baseRef
    }, this.localRuntime().gitClient);
  }

  async archive(input: {
    id: string;
    cleanup?: ArchiveFeatureCleanupOptions;
    /** The user said to archive despite what the check found. */
    confirmed?: boolean;
  }): Promise<ArchiveFeatureResult> {
    const row = this.deps.features.getById(input.id);
    if (!row) return { ok: false, status: 404, error: "feature not found" };

    const project = this.deps.projects.getById(row.projectId);
    const cleanup = resolveArchiveFeatureCleanup(row, input);
    const runtime = this.localRuntime();
    const gitClient = runtime.gitClient;
    const failures: ArchiveFeatureCleanupFailure[] = [];

    // Never archive away uncommitted or unmerged work
    // without the user's say-so. The refusal carries the findings so the
    // caller can ask.
    if (!input.confirmed) {
      const check = this.archiveCheck(row.id);
      if (check && check.findings.length > 0) {
        return { ok: false, status: 409, error: check.findings.join(" "), check };
      }
    }

    const worktreePath = row.worktreePath;
    // Branches are deleted in the project's folder; when the worktree is still
    // there it must be of that same repository (a project moved to another
    // repository keeps an archived worker's old worktree): if not, no branch
    // is deleted and the worktree is kept, so a second archive still sees
    // whose it is; both are said.
    const worktreeThere = Boolean(worktreePath && fs.existsSync(worktreePath));
    const sameRepository = (a: string, b: string) => {
      try {
        const repository = gitCommonDir(a, gitClient);
        return repository !== null && repository === gitCommonDir(b, gitClient);
      } catch {
        return false; // git did not answer: not shown to be the same
      }
    };
    const otherRepository = worktreeThere && project?.workingDir ? !sameRepository(worktreePath!, project.workingDir) : false;
    // The branches the worker made in its own worktree (an MR's), read while
    // the worktree is still there, by git's own records only: a branch made
    // anywhere else stays, even one the worker checked out. Kept when the
    // caller keeps branches or the worktree.
    const workerBranches = cleanup.removeWorktree && input.cleanup?.deleteBranch !== false && makesWorktree(row.mode)
      && worktreeThere && !otherRepository
      ? gitBranchesCreatedInWorktree(worktreePath!, gitClient).filter((made) => made.name !== row.branch)
      : [];
    if (cleanup.removeWorktree && worktreePath && otherRepository) {
      failures.push({ kind: "worktree", worktreePath, error: "the worktree belongs to another repository than the project's folder; it was kept" });
      this.deps.broadcast?.(cleanupFailedEvent(input.id, failures.at(-1)!));
    } else if (cleanup.removeWorktree && worktreePath) {
      this.tryCleanup(input.id, failures, () => {
        gitWorktreeRemove(worktreePath, project?.workingDir, { force: cleanup.forceRemoveWorktree }, gitClient);
      }, (error) => ({ kind: "worktree", worktreePath, error }));
    }

    // A branch git did not answer about is left as it is, and said so, like
    // one that would not delete.
    const branch = row.branch;
    if (cleanup.deleteBranch && branch && otherRepository) {
      failures.push({ kind: "branch", branch, error: "the worktree belongs to another repository than the project's folder; no branch was deleted" });
      this.deps.broadcast?.(cleanupFailedEvent(input.id, failures.at(-1)!));
    } else if (cleanup.deleteBranch && project?.workingDir && branch) {
      this.tryCleanup(input.id, failures, () => {
        if (gitBranchExists(project.workingDir, branch, gitClient)) {
          gitBranchDelete(project.workingDir, branch, { force: cleanup.forceDeleteBranch }, gitClient);
        }
      }, (error) => ({ kind: "branch", branch, error }));
    }
    // Only a safe delete, never forced: one not merged stays, and is said.
    // Read again first: by now the name may be another branch.
    for (const made of project?.workingDir ? workerBranches : []) {
      this.tryCleanup(input.id, failures, () => {
        if (gitBranchIsStill(project!.workingDir, made, gitClient)) {
          gitBranchDelete(project!.workingDir, made.name, { force: false }, gitClient);
        }
      }, (error) => ({ kind: "branch", branch: made.name, error }));
    }

    // A window tmux did not answer about is left as it is, and said so, like
    // one that would not close: the archive itself goes ahead either way.
    if (project) {
      this.tryCleanup(input.id, failures, () => {
        if (tmuxHasWindow(project.tmuxSessionName, row.tmuxWindowName, runtime.tmuxClient)) {
          tmuxKillWindow(project.tmuxSessionName, row.tmuxWindowName, runtime.tmuxClient);
          this.deps.refreshTmux?.();
        }
      }, (error) => ({ kind: "terminal", windowName: row.tmuxWindowName, error }));
    }

    if (!row.archivedAt) {
      try {
        this.deps.beforeFeatureArchive?.(input.id);
      } catch (err) {
        const msg = errorText(err);
        console.warn(`[mandate] memory feature-archive hook failed: ${msg}`);
      }
      this.deps.features.archive(input.id);
    }

    return { ok: true, feature: this.deps.features.getById(input.id) ?? row, cleanupFailures: failures };
  }

  /** One archive cleanup step: a failure is kept for the result and
   *  broadcast, never thrown. */
  private tryCleanup(
    featureId: string,
    failures: ArchiveFeatureCleanupFailure[],
    step: () => void,
    failed: (error: string) => ArchiveFeatureCleanupFailure
  ): void {
    try {
      step();
    } catch (err: unknown) {
      const failure = failed(errorMessage(err));
      failures.push(failure);
      this.deps.broadcast?.(cleanupFailedEvent(featureId, failure));
    }
  }

  async restore(input: {
    id: string;
    mode?: unknown;
    branch?: string;
    baseRef?: string;
    worktreePath?: string;
    tmuxWindowName?: string;
    /** The thread that restores it owns it (restore_feature). */
    ownerThreadId?: string | null;
  }): Promise<RestoreFeatureResult> {
    const feature = this.deps.features.getById(input.id);
    if (!feature) return { ok: false, status: 404, error: "feature not found" };
    if (!feature.archivedAt) return { ok: false, status: 409, error: "feature is not archived" };

    const project = this.deps.projects.getById(feature.projectId);
    if (!project || project.archivedAt) return { ok: false, status: 404, error: "project not found or archived" };

    const mode = input.mode === undefined ? feature.mode : input.mode;
    if (!isFeatureMode(mode)) return { ok: false, status: 400, error: `unknown mode: ${String(mode)}` };
    if (mode !== "shared-cwd" && !project.isGit) {
      return { ok: false, status: 400, error: `mode ${mode} requires a git project` };
    }

    const runtime = this.localRuntime();
    const gitClient = runtime.gitClient;
    const tmuxWindowName = normalizedOverride(input.tmuxWindowName, feature.tmuxWindowName);
    if (!tmuxWindowName) return { ok: false, status: 400, error: "tmuxWindowName is required" };
    const taken = this.restoreNameConflict(feature, project, tmuxWindowName, runtime.tmuxClient);
    if (taken) return { ok: false, status: 409, error: taken };

    const branch = normalizeRestoreBranch(mode, normalizedOverride(input.branch, feature.branch));
    const baseRefInput = normalizedOptional(input.baseRef);
    const baseRef = mode === "new-branch-new-worktree"
      ? baseRefInput || feature.baseRef || gitResolveDefaultBaseRef(project.workingDir, gitClient)
      : baseRefInput || feature.baseRef;
    const worktreePath = normalizeRestoreWorktreePath({
      mode,
      explicit: normalizedOptional(input.worktreePath),
      archived: feature.worktreePath,
      defaultWorktreePath: branch ? this.worktreePathForProject(project, branch) : null
    });

    const conflict = this.restoreResourceConflict({
      project,
      runtime,
      gitClient,
      mode,
      branch,
      baseRef,
      worktreePath
    });
    if (conflict) return conflict;

    let addedWorktree = false;
    // What a failure puts back: the row as it is now, and whether its thread was open.
    const hadOpenThread = this.deps.agentStore?.getThreadByScope("worker", input.id) != null;
    const reconcile = recordingReconcileAdapter(tmuxReconcileAdapter(runtime.tmuxClient));
    try {
      if (makesWorktree(mode)) {
        addWorktree(project.workingDir, mode, worktreePath!, branch!, baseRef, runtime);
        addedWorktree = true;
      }

      this.deps.features.restore({
        id: input.id,
        mode,
        branch,
        baseRef,
        worktreePath,
        tmuxWindowName,
        ownerThreadId: input.ownerThreadId ?? null
      });
      this.deps.agentStore?.restoreMainThread("worker", input.id);

      const adapter = reconcile.adapter;
      reconcileProject(project, this.deps.features.listActiveByProject(project.id), adapter);
      const restored = this.deps.features.getById(input.id)!;
      reconcileFeature(restored, project, adapter);
      this.deps.refreshTmux?.();
      return { ok: true, feature: restored };
    } catch (err) {
      this.closeOpenedWindow(reconcile.opened, tmuxWindowName, runtime.tmuxClient);
      if (addedWorktree && worktreePath) removeAddedWorktree(project.workingDir, mode, worktreePath, branch, gitClient);
      this.undoRestoredRecords(feature, hadOpenThread);
      if (err instanceof CommandDidNotAnswerError) throw err;
      return { ok: false, status: 500, error: errorMessage(err) };
    }
  }

  /** What already holds the name or window a restored worker would take. */
  private restoreNameConflict(
    feature: FeatureRow,
    project: { tmuxSessionName: string },
    tmuxWindowName: string,
    tmuxClient: TmuxClient
  ): string | null {
    if (this.deps.features.activeNameExists(feature.projectId, feature.name, feature.id)) {
      return `feature name '${feature.name}' is already active`;
    }
    if (this.deps.features.activeWindowNameExists(feature.projectId, tmuxWindowName, feature.id)) {
      return `feature window '${tmuxWindowName}' is already active`;
    }
    if (tmuxHasWindow(project.tmuxSessionName, tmuxWindowName, tmuxClient)) {
      return `tmux window '${tmuxWindowName}' already exists`;
    }
    return null;
  }

  /** Best-effort rollback of a failed restore's records: the row as it was,
   *  and its thread closed again unless it was open before. */
  private undoRestoredRecords(feature: FeatureRow, hadOpenThread: boolean): void {
    if (this.deps.features.getById(feature.id)?.archivedAt === null) {
      try { this.deps.features.undoRestore(feature); } catch { /* best-effort rollback */ }
    }
    if (!hadOpenThread) {
      const reopened = this.deps.agentStore?.getThreadByScope("worker", feature.id);
      if (reopened) {
        try { this.deps.agentStore?.archiveThread(reopened.id); } catch { /* best-effort rollback */ }
      }
    }
  }

  /** Best-effort: the window this attempt opened for its own worker, by id. */
  private closeOpenedWindow(opened: OpenedWindow[], windowName: string, tmuxClient: TmuxClient): void {
    for (const window of opened) {
      if (window.window !== windowName) continue;
      try { tmuxKillWindowById(window.id, tmuxClient); } catch { /* best-effort rollback */ }
    }
  }

  private restoreResourceConflict(input: {
    project: { workingDir: string };
    runtime: FeatureHostRuntime;
    gitClient: GitClient;
    mode: FeatureMode;
    branch: string | null;
    baseRef: string | null;
    worktreePath: string | null;
  }): RestoreFeatureResult | null {
    const { project, runtime, gitClient, mode, branch, baseRef, worktreePath } = input;
    if (mode === "shared-cwd") return null;
    if (!branch) return { ok: false, status: 400, error: "branch is required" };

    if (mode === "new-branch-new-worktree") {
      if (gitBranchExists(project.workingDir, branch, gitClient)) {
        return { ok: false, status: 409, error: `branch '${branch}' already exists` };
      }
      if (!baseRef) return { ok: false, status: 400, error: "baseRef could not be resolved" };
      if (!gitRefExists(project.workingDir, baseRef, gitClient)) {
        return { ok: false, status: 400, error: `baseRef '${baseRef}' does not resolve to a commit` };
      }
    } else if (!gitBranchExists(project.workingDir, branch, gitClient)) {
      return { ok: false, status: 409, error: `branch '${branch}' does not exist` };
    }

    if (mode === "existing-branch-existing-worktree") {
      if (!worktreePath) return { ok: false, status: 400, error: "worktreePath is required" };
      if (!runtime.directoryExists(worktreePath)) {
        return { ok: false, status: 409, error: `worktreePath '${worktreePath}' does not exist` };
      }
      return null;
    }

    if (!worktreePath) return { ok: false, status: 400, error: "worktreePath is required" };
    if (runtime.directoryExists(worktreePath)) {
      return { ok: false, status: 409, error: `worktreePath '${worktreePath}' already exists` };
    }
    return null;
  }

  private archiveFailedCreate(featureId: string) {
    const thread = this.deps.agentStore?.getThreadByScope("worker", featureId);
    if (thread) this.deps.agentStore?.archiveThread(thread.id);
    this.deps.features.archive(featureId);
  }

  private gitClient(): GitClient {
    return this.deps.gitClient ?? DEFAULT_GIT;
  }

  private localRuntime(): FeatureHostRuntime {
    return {
      tmuxClient: this.deps.tmuxClient,
      gitClient: this.gitClient(),
      directoryExists: (dir) => fs.existsSync(dir),
      ensureDirectory: (dir) => fs.mkdirSync(dir, { recursive: true }),
      dirname: path.dirname
    };
  }

  /** The branch, base and worktree a new worker of this mode works in, each
   *  checked against the repository; or why the request cannot be one. */
  private createLayout(
    project: { workingDir: string; tmuxSessionName: string },
    mode: FeatureMode,
    input: { branch?: string; baseRef?: string; worktreePath?: string },
    runtime: FeatureHostRuntime
  ): { branch: string | null; baseRef: string | null; worktreePath: string | null } | { error: string } {
    const branchInput = (input.branch ?? "").trim();
    const baseRefInput = (input.baseRef ?? "").trim();
    const worktreePathInput = (input.worktreePath ?? "").trim();
    const gitClient = runtime.gitClient;
    if (mode === "shared-cwd") return { branch: null, baseRef: null, worktreePath: null };
    if (!branchInput) return { error: "branch is required" };
    if (mode === "new-branch-new-worktree") {
      if (gitBranchExists(project.workingDir, branchInput, gitClient)) {
        return { error: `branch '${branchInput}' already exists` };
      }
      const baseRef = baseRefInput || gitResolveDefaultBaseRef(project.workingDir, gitClient);
      if (!baseRef) return { error: "baseRef could not be resolved" };
      if (!gitRefExists(project.workingDir, baseRef, gitClient)) {
        return { error: `baseRef '${baseRef}' does not resolve to a commit` };
      }
      return { branch: branchInput, baseRef, worktreePath: this.worktreePathForProject(project, branchInput) };
    }
    if (mode === "existing-branch-new-worktree") {
      if (!gitBranchExists(project.workingDir, branchInput, gitClient)) {
        return { error: `branch '${branchInput}' does not exist` };
      }
      return { branch: branchInput, baseRef: null, worktreePath: this.worktreePathForProject(project, branchInput) };
    }
    if (!worktreePathInput) return { error: "worktreePath is required" };
    if (!runtime.directoryExists(worktreePathInput)) return { error: "worktreePath does not exist" };
    return { branch: branchInput, baseRef: null, worktreePath: worktreePathInput };
  }

  private worktreePathForProject(project: { tmuxSessionName: string }, branch: string): string {
    const sanitizedBranch = sanitizeFeatureName(branch);
    return worktreePathFor(project.tmuxSessionName, sanitizedBranch);
  }
}

interface FeatureHostRuntime {
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  directoryExists(dir: string): boolean;
  ensureDirectory(dir: string): void;
  dirname(path: string): string;
}

export async function createFeatureWithMaterialization(
  input: {
    projectId: string;
    name: string;
    mode: unknown;
    branch?: string;
    baseRef?: string;
    worktreePath?: string;
    ownerThreadId?: string | null;
  },
  deps: FeatureServiceDeps
): Promise<CreateFeatureResult> {
  return new FeatureService(deps).create(input);
}

export async function archiveFeatureCascade(
  input: { id: string; cleanup?: ArchiveFeatureCleanupOptions; confirmed?: boolean },
  deps: FeatureServiceDeps
): Promise<ArchiveFeatureResult> {
  return new FeatureService(deps).archive(input);
}

export async function restoreFeatureMaterialization(
  input: {
    id: string;
    mode?: unknown;
    branch?: string;
    baseRef?: string;
    worktreePath?: string;
    tmuxWindowName?: string;
    ownerThreadId?: string | null;
  },
  deps: FeatureServiceDeps
): Promise<RestoreFeatureResult> {
  return new FeatureService(deps).restore(input);
}

export function featureRowToDto(row: FeatureRow): FeatureDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    mode: row.mode,
    branch: row.branch,
    baseRef: row.baseRef,
    worktreePath: row.worktreePath,
    tmuxWindowName: row.tmuxWindowName,
    ownership: row.ownership,
    pinnedAt: row.pinnedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    ownerThreadId: row.ownerThreadId
  };
}

function firstRunningPane(panes: Pane[]): Pane | null {
  return panes.find((pane) => pane.status === "running") ?? null;
}

function isFeatureMode(value: unknown): value is FeatureMode {
  return (
    value === "shared-cwd" ||
    value === "new-branch-new-worktree" ||
    value === "existing-branch-new-worktree" ||
    value === "existing-branch-existing-worktree"
  );
}

function normalizedOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizedOverride(value: string | undefined, fallback: string | null): string | null {
  return normalizedOptional(value) ?? fallback;
}

function normalizeRestoreBranch(mode: FeatureMode, value: string | null): string | null {
  return mode === "shared-cwd" ? null : value;
}

function normalizeRestoreWorktreePath(input: {
  mode: FeatureMode;
  explicit: string | null;
  archived: string | null;
  defaultWorktreePath: string | null;
}): string | null {
  if (input.mode === "shared-cwd") return null;
  if (input.mode === "existing-branch-existing-worktree") {
    return input.explicit ?? input.archived;
  }
  return input.explicit ?? input.archived ?? input.defaultWorktreePath;
}

/** The modes whose worker gets a worktree of its own, made for it. */
function makesWorktree(mode: FeatureMode): boolean {
  return mode === "new-branch-new-worktree" || mode === "existing-branch-new-worktree";
}

function addWorktree(
  projectDir: string,
  mode: FeatureMode,
  worktreePath: string,
  branch: string,
  baseRef: string | null,
  runtime: FeatureHostRuntime
): void {
  runtime.ensureDirectory(runtime.dirname(worktreePath));
  gitWorktreeAdd(projectDir, worktreePath, branch, {
    newBranch: mode === "new-branch-new-worktree",
    baseRef
  }, runtime.gitClient);
}

/** Best-effort rollback of addWorktree: the worktree, and the branch it made
 *  — or adding it again fails on "already exists". */
function removeAddedWorktree(projectDir: string, mode: FeatureMode, worktreePath: string, branch: string | null, gitClient: GitClient): void {
  try { gitWorktreeRemove(worktreePath, projectDir, { force: true }, gitClient); }
  catch { /* best-effort rollback */ }
  if (mode === "new-branch-new-worktree" && branch) {
    try { gitBranchDelete(projectDir, branch, { force: true }, gitClient); }
    catch { /* best-effort rollback */ }
  }
}

function cleanupFailedEvent(featureId: string, failure: ArchiveFeatureCleanupFailure): LifecycleEvent {
  switch (failure.kind) {
    case "worktree":
      return { type: "featureWorktreeCleanupFailed", data: { id: featureId, worktreePath: failure.worktreePath, error: failure.error } };
    case "branch":
      return { type: "featureBranchCleanupFailed", data: { id: featureId, branch: failure.branch, error: failure.error } };
    case "terminal":
      return { type: "featureTerminalCleanupFailed", data: { id: featureId, windowName: failure.windowName, error: failure.error } };
  }
}

function resolveArchiveFeatureCleanup(
  feature: FeatureRow,
  input: { cleanup?: ArchiveFeatureCleanupOptions }
): Required<ArchiveFeatureCleanupOptions> {
  const createdWorktree = makesWorktree(feature.mode);
  const createdBranch = feature.mode === "new-branch-new-worktree";
  return {
    removeWorktree: input.cleanup?.removeWorktree ?? createdWorktree,
    forceRemoveWorktree: input.cleanup?.forceRemoveWorktree ?? false,
    deleteBranch: input.cleanup?.deleteBranch ?? createdBranch,
    forceDeleteBranch: input.cleanup?.forceDeleteBranch ?? false
  };
}

function errorMessage(error: unknown, fallback = "operation failed"): string {
  return error instanceof Error ? error.message : String(error || fallback);
}
