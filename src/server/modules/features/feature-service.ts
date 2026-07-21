import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentStore } from "../agent/agent-store.js";
import type { FeaturesStore, FeatureMode, FeatureRow } from "./features-store.js";
import type { FeatureDto } from "../../../shared/api-contracts.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { worktreePathFor } from "../../platform/fs/data-dir.js";
import {
  DEFAULT_GIT,
  gitBranchDelete,
  gitBranchExists,
  gitRefExists,
  gitResolveDefaultBaseRef,
  gitWorktreeAdd,
  gitWorktreeRemove,
  type GitClient
} from "../../platform/git/git.js";
import { reconcileFeature, reconcileProject } from "../projects/project-reconcile.js";
import type { LifecyclePublisher } from "../../runtime/events.js";
import type { Pane } from "../../runtime/pane-runtime.js";
import type { PaneRuntimeRegistry } from "../../runtime/pane-runtime-registry.js";
import type { PaneMetadataStore } from "../panes/pane-metadata-store.js";
import { sanitizeFeatureName, resolveCollision } from "../../platform/naming/names.js";
import {
  type TmuxClient,
  tmuxHasWindow,
  tmuxKillWindow
} from "../../platform/tmux/tmux.js";
import { tmuxReconcileAdapter } from "../projects/tmux-reconcile-adapter.js";

export interface FeatureServiceDeps {
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

export type CreateFeatureResult =
  | { ok: true; feature: FeatureRow }
  | { ok: false; status: number; error: string };

export type ArchiveFeatureResult =
  | { ok: true; feature: FeatureRow; cleanupFailures?: ArchiveFeatureCleanupFailure[] }
  | { ok: false; status: number; error: string; cleanupFailures?: ArchiveFeatureCleanupFailure[] };

export type RestoreFeatureResult =
  | { ok: true; feature: FeatureRow }
  | { ok: false; status: number; error: string };

export type ArchiveFeatureCleanupFailure =
  | { kind: "terminal"; windowName: string; error: string }
  | { kind: "worktree"; worktreePath: string; error: string }
  | { kind: "branch"; branch: string; error: string };

export type CreateFeaturePaneResult =
  | { ok: true; pane: Pane }
  | { ok: false; status: number; error: string };

export interface ArchiveFeatureCleanupOptions {
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

    let branch: string | null = null;
    let baseRef: string | null = null;
    let worktreePath: string | null = null;
    const branchInput = (input.branch ?? "").trim();
    const baseRefInput = (input.baseRef ?? "").trim();
    const worktreePathInput = (input.worktreePath ?? "").trim();
    const runtime = this.localRuntime();
    const gitClient = runtime.gitClient;

    if (mode === "new-branch-new-worktree") {
      if (!branchInput) return { ok: false, status: 400, error: "branch is required" };
      if (gitBranchExists(project.workingDir, branchInput, gitClient)) {
        return { ok: false, status: 400, error: `branch '${branchInput}' already exists` };
      }
      branch = branchInput;
      baseRef = baseRefInput || gitResolveDefaultBaseRef(project.workingDir, gitClient);
      if (!baseRef) return { ok: false, status: 400, error: "baseRef could not be resolved" };
      if (!gitRefExists(project.workingDir, baseRef, gitClient)) {
        return { ok: false, status: 400, error: `baseRef '${baseRef}' does not resolve to a commit` };
      }
      worktreePath = this.worktreePathForProject(project, branchInput);
    } else if (mode === "existing-branch-new-worktree") {
      if (!branchInput) return { ok: false, status: 400, error: "branch is required" };
      if (!gitBranchExists(project.workingDir, branchInput, gitClient)) {
        return { ok: false, status: 400, error: `branch '${branchInput}' does not exist` };
      }
      branch = branchInput;
      worktreePath = this.worktreePathForProject(project, branchInput);
    } else if (mode === "existing-branch-existing-worktree") {
      if (!branchInput) return { ok: false, status: 400, error: "branch is required" };
      if (!worktreePathInput) return { ok: false, status: 400, error: "worktreePath is required" };
      if (!runtime.directoryExists(worktreePathInput)) {
        return { ok: false, status: 400, error: "worktreePath does not exist" };
      }
      branch = branchInput;
      worktreePath = worktreePathInput;
    }

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
        ownership: "app"
      });
    } catch (err: unknown) {
      return { ok: false, status: 400, error: errorMessage(err, "insert failed") };
    }

    if (mode === "new-branch-new-worktree" || mode === "existing-branch-new-worktree") {
      try {
        runtime.ensureDirectory(runtime.dirname(worktreePath!));
        gitWorktreeAdd(project.workingDir, worktreePath!, branch!, {
          newBranch: mode === "new-branch-new-worktree",
          baseRef
        }, gitClient);
      } catch (err: unknown) {
        this.archiveFailedCreate(id);
        return {
          ok: false,
          status: 500,
          error: `git worktree add failed: ${errorMessage(err)}`
        };
      }
    }

    try {
      const adapter = tmuxReconcileAdapter(runtime.tmuxClient);
      const activeFeatures = this.deps.features.listActiveByProject(projectId);
      reconcileProject(project, activeFeatures, adapter);
      const featureRow = this.deps.features.getById(id)!;
      reconcileFeature(featureRow, project, adapter);
    } catch (err: unknown) {
      this.archiveFailedCreate(id);
      if ((mode === "new-branch-new-worktree" || mode === "existing-branch-new-worktree") && worktreePath) {
        try { gitWorktreeRemove(worktreePath, project.workingDir, { force: true }, gitClient); }
        catch { /* swallow */ }
      }
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

  async archive(input: {
    id: string;
    killWorktree?: boolean;
    cleanup?: ArchiveFeatureCleanupOptions;
  }): Promise<ArchiveFeatureResult> {
    const row = this.deps.features.getById(input.id);
    if (!row) return { ok: false, status: 404, error: "feature not found" };

    const project = this.deps.projects.getById(row.projectId);
    const cleanup = resolveArchiveFeatureCleanup(row, input);
    const runtime = this.localRuntime();
    const gitClient = runtime.gitClient;
    const failures: ArchiveFeatureCleanupFailure[] = [];

    if (cleanup.removeWorktree && row.worktreePath) {
      try {
        gitWorktreeRemove(row.worktreePath, project?.workingDir, { force: cleanup.forceRemoveWorktree }, gitClient);
      } catch (err: unknown) {
        const failure = { kind: "worktree" as const, worktreePath: row.worktreePath, error: errorMessage(err) };
        failures.push(failure);
        this.deps.broadcast?.({
          type: "featureWorktreeCleanupFailed",
          data: { id: input.id, worktreePath: failure.worktreePath, error: failure.error }
        });
      }
    }

    if (
      cleanup.deleteBranch &&
      project?.workingDir &&
      row.branch &&
      gitBranchExists(project.workingDir, row.branch, gitClient)
    ) {
      try {
        gitBranchDelete(project.workingDir, row.branch, { force: cleanup.forceDeleteBranch }, gitClient);
      } catch (err: unknown) {
        const failure = { kind: "branch" as const, branch: row.branch, error: errorMessage(err) };
        failures.push(failure);
        this.deps.broadcast?.({
          type: "featureBranchCleanupFailed",
          data: { id: input.id, branch: failure.branch, error: failure.error }
        });
      }
    }

    if (project && tmuxHasWindow(project.tmuxSessionName, row.tmuxWindowName, runtime.tmuxClient)) {
      try {
        tmuxKillWindow(project.tmuxSessionName, row.tmuxWindowName, runtime.tmuxClient);
        this.deps.refreshTmux?.();
      } catch (err: unknown) {
        const failure = { kind: "terminal" as const, windowName: row.tmuxWindowName, error: errorMessage(err) };
        failures.push(failure);
        this.deps.broadcast?.({
          type: "featureTerminalCleanupFailed",
          data: { id: input.id, windowName: failure.windowName, error: failure.error }
        });
      }
    }

    if (!row.archivedAt) {
      try {
        this.deps.beforeFeatureArchive?.(input.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mandate] memory feature-archive hook failed: ${msg}`);
      }
      this.deps.features.archive(input.id);
    }

    return { ok: true, feature: this.deps.features.getById(input.id) ?? row, cleanupFailures: failures };
  }

  async restore(input: {
    id: string;
    mode?: unknown;
    branch?: string;
    baseRef?: string;
    worktreePath?: string;
    tmuxWindowName?: string;
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
    if (this.deps.features.activeNameExists(feature.projectId, feature.name, feature.id)) {
      return { ok: false, status: 409, error: `feature name '${feature.name}' is already active` };
    }
    if (this.deps.features.activeWindowNameExists(feature.projectId, tmuxWindowName, feature.id)) {
      return { ok: false, status: 409, error: `feature window '${tmuxWindowName}' is already active` };
    }
    if (tmuxHasWindow(project.tmuxSessionName, tmuxWindowName, runtime.tmuxClient)) {
      return { ok: false, status: 409, error: `tmux window '${tmuxWindowName}' already exists` };
    }

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
    try {
      if (mode === "new-branch-new-worktree" || mode === "existing-branch-new-worktree") {
        runtime.ensureDirectory(runtime.dirname(worktreePath!));
        gitWorktreeAdd(project.workingDir, worktreePath!, branch!, {
          newBranch: mode === "new-branch-new-worktree",
          baseRef
        }, gitClient);
        addedWorktree = true;
      }

      this.deps.features.restore({
        id: input.id,
        mode,
        branch,
        baseRef,
        worktreePath,
        tmuxWindowName
      });
      this.deps.agentStore?.restoreMainThread("worker", input.id);

      const adapter = tmuxReconcileAdapter(runtime.tmuxClient);
      reconcileProject(project, this.deps.features.listActiveByProject(project.id), adapter);
      const restored = this.deps.features.getById(input.id)!;
      reconcileFeature(restored, project, adapter);
      this.deps.refreshTmux?.();
      return { ok: true, feature: restored };
    } catch (err) {
      if (addedWorktree && worktreePath) {
        try { gitWorktreeRemove(worktreePath, project.workingDir, { force: true }, gitClient); }
        catch { /* best-effort rollback */ }
        if (mode === "new-branch-new-worktree" && branch) {
          try { gitBranchDelete(project.workingDir, branch, { force: true }, gitClient); }
          catch { /* best-effort rollback */ }
        }
      }
      if (this.deps.features.getById(input.id)?.archivedAt === null) {
        try { this.deps.features.archive(input.id); } catch { /* best-effort rollback */ }
      }
      return { ok: false, status: 500, error: errorMessage(err) };
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
  },
  deps: FeatureServiceDeps
): Promise<CreateFeatureResult> {
  return new FeatureService(deps).create(input);
}

export async function archiveFeatureCascade(
  input: { id: string; killWorktree?: boolean; cleanup?: ArchiveFeatureCleanupOptions },
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
    archivedAt: row.archivedAt
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

function resolveArchiveFeatureCleanup(
  feature: FeatureRow,
  input: { killWorktree?: boolean; cleanup?: ArchiveFeatureCleanupOptions }
): Required<ArchiveFeatureCleanupOptions> {
  const createdWorktree =
    feature.mode === "new-branch-new-worktree" ||
    feature.mode === "existing-branch-new-worktree";
  const createdBranch = feature.mode === "new-branch-new-worktree";
  return {
    removeWorktree: input.cleanup?.removeWorktree ?? input.killWorktree ?? createdWorktree,
    forceRemoveWorktree: input.cleanup?.forceRemoveWorktree ?? false,
    deleteBranch: input.cleanup?.deleteBranch ?? createdBranch,
    forceDeleteBranch: input.cleanup?.forceDeleteBranch ?? false
  };
}

function errorMessage(error: unknown, fallback = "operation failed"): string {
  return error instanceof Error ? error.message : String(error || fallback);
}
