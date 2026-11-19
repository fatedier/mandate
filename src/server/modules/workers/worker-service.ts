import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentStore } from "../agent/agent-store.js";
import type { WorkersStore, WorkerMode, WorkerRow } from "./workers-store.js";
import type { WorkerDto } from "../../../shared/api-contracts.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { worktreePathFor } from "../../platform/fs/data-dir.js";
import { gitArchiveCheck } from "../../platform/git/git-archive-check.js";
import type { ArchiveCheckDto } from "../../../shared/api/workers.js";
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
import { reconcileWorker, reconcileProject } from "../projects/project-reconcile.js";
import type { LifecyclePublisher } from "../../runtime/events.js";
import type { Pane } from "../../runtime/pane-runtime.js";
import type { TmuxRuntime } from "../../runtime/runtimes/tmux-runtime.js";
import { sanitizeWorkerName, resolveCollision } from "../../platform/naming/names.js";
import {
  type TmuxClient,
  tmuxHasWindow,
  tmuxKillWindowById,
  tmuxKillWindow
} from "../../platform/tmux/tmux.js";
import { recordingReconcileAdapter, tmuxReconcileAdapter, type OpenedWindow } from "../projects/tmux-reconcile-adapter.js";
import { projectWork } from "../projects/project-work.js";
import { ensureOpenOwner, ownerRefusal } from "./ownership.js";
import { CommandDidNotAnswerError } from "../../platform/process/command-runner.js";
import { errorText } from "../../../shared/error-text.js";

interface WorkerServiceDeps {
  projects: ProjectsStore;
  workers: WorkersStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  tmuxRuntime: TmuxRuntime;
  agentStore?: AgentStore;
  broadcast?: LifecyclePublisher;
  refreshTmux?: () => void;
  beforeWorkerArchive?: (workerId: string) => void;
}

type CreateWorkerResult =
  | { ok: true; worker: WorkerRow }
  | { ok: false; status: number; error: string };

type ArchiveWorkerResult =
  | { ok: true; worker: WorkerRow; cleanupFailures?: ArchiveWorkerCleanupFailure[] }
  | { ok: false; status: number; error: string; cleanupFailures?: ArchiveWorkerCleanupFailure[]; check?: ArchiveCheckDto };

type RestoreWorkerResult =
  | { ok: true; worker: WorkerRow }
  | { ok: false; status: number; error: string };

export type ArchiveWorkerCleanupFailure =
  | { kind: "terminal"; windowName: string; error: string }
  | { kind: "worktree"; worktreePath: string; error: string }
  | { kind: "branch"; branch: string; error: string };

type CreateWorkerPaneResult =
  | { ok: true; pane: Pane }
  | { ok: false; status: number; error: string };

/** Every active worker has an open owner: given, the made or restored
 *  worker gets one in its own turn, `preferred` when that is an open manager
 *  thread, else the one it has when still open, else a thread of its own. */
interface OpenOwner {
  preferred?: string | null;
}

interface CreateShellPaneInput {
  workerId: string;
}

interface CreateWorkerInput {
  projectId: string;
  openOwner?: OpenOwner;
  name: string;
  mode: unknown;
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
  ownerThreadId?: string | null;
}

interface ArchiveWorkerInput {
  id: string;
  /** The thread asking, when a thread asks: it may archive only a worker
   *  that is its own, when its turn comes. */
  by?: string;
  cleanup?: ArchiveWorkerCleanupOptions;
  /** The user said to archive despite what the check found. */
  confirmed?: boolean;
}

interface RestoreWorkerInput {
  id: string;
  mode?: unknown;
  branch?: string;
  baseRef?: string;
  worktreePath?: string;
  tmuxWindowName?: string;
  /** The thread that restores it owns it (restore_worker). */
  ownerThreadId?: string | null;
}

interface ArchiveWorkerCleanupOptions {
  removeWorktree?: boolean;
  forceRemoveWorktree?: boolean;
  deleteBranch?: boolean;
  forceDeleteBranch?: boolean;
}

export class WorkerService {
  constructor(private deps: WorkerServiceDeps) {}

  /** One at a time per project. The worker is recorded only once git has
   *  made its worktree, so nothing finds it, or opens a terminal for it,
   *  before its folder is there; what was checked before git ran is checked
   *  again after it answered, just before the record is written. */
  create(input: CreateWorkerInput): Promise<CreateWorkerResult> {
    return projectWork.run(input.projectId, () => this.createAlone(input));
  }

  private async createAlone(input: CreateWorkerInput): Promise<CreateWorkerResult> {
    const { projectId } = input;
    const name = input.name.trim();

    const project = this.deps.projects.getById(projectId);
    if (!project || project.archivedAt) return { ok: false, status: 404, error: "project not found" };

    if (!name) return { ok: false, status: 400, error: "name is required" };

    if (!isWorkerMode(input.mode)) return { ok: false, status: 400, error: `unknown mode: ${String(input.mode)}` };
    const mode = input.mode;

    if (mode !== "shared-cwd" && !project.isGit) {
      return { ok: false, status: 400, error: `mode ${mode} requires a git project` };
    }

    let windowBase: string;
    try {
      windowBase = sanitizeWorkerName(name);
    } catch (err: unknown) {
      return { ok: false, status: 400, error: errorMessage(err, "name sanitization failed") };
    }
    if (this.deps.workers.activeNameExists(projectId, name)) {
      return { ok: false, status: 400, error: `worker name '${name}' is already active` };
    }

    const gitClient = this.gitClient();
    const tmuxClient = this.deps.tmuxClient;
    const layout = await this.createLayout(project, mode, input, gitClient);
    if ("error" in layout) return { ok: false, status: 400, error: layout.error };
    const { branch, baseRef, worktreePath } = layout;

    if (makesWorktree(mode)) {
      try {
        await addWorktree(project.workingDir, mode, worktreePath!, branch!, baseRef, gitClient);
      } catch (err: unknown) {
        return {
          ok: false,
          status: 500,
          error: `git worktree add failed: ${errorMessage(err)}`
        };
      }
    }
    const takeBackWorktree = async () => {
      if (makesWorktree(mode) && worktreePath) await removeAddedWorktree(project.workingDir, mode, worktreePath, branch, gitClient);
    };

    // The worker's window is opened before it is recorded, as its worktree
    // was: nothing finds the worker, or starts work in it, until both are
    // there, and a failure leaves no record to take back. The names taken are
    // read in the project's turn, which every other window-making work waits for.
    const taken = this.deps.workers.takenWindowNames(projectId);
    let tmuxWindowName: string;
    try {
      tmuxWindowName = resolveCollision(windowBase, (n) => taken.has(n));
    } catch (err: unknown) {
      await takeBackWorktree();
      return { ok: false, status: 400, error: errorMessage(err, "name sanitization failed") };
    }
    const reconcile = recordingReconcileAdapter(tmuxReconcileAdapter(tmuxClient));
    const takeBackWindow = () => this.closeOpenedWindow(reconcile.opened, tmuxWindowName, tmuxClient);
    try {
      const adapter = reconcile.adapter;
      await reconcileProject(project, this.deps.workers.listActiveByProject(projectId), adapter);
      await reconcileWorker({ tmuxWindowName, ownership: "app", worktreePath }, project, adapter);
    } catch (err: unknown) {
      await takeBackWindow();
      await takeBackWorktree();
      if (err instanceof CommandDidNotAnswerError) throw err;
      return {
        ok: false,
        status: 500,
        error: `tmux materialization failed: ${errorMessage(err)}`
      };
    }

    // From here to the record, nothing waits: git and tmux answered while the
    // server went on, so the thread that asked may have been archived
    // meanwhile (it must leave no worker behind).
    if (this.ownerArchived(input.ownerThreadId)) {
      await takeBackWindow();
      await takeBackWorktree();
      return { ok: false, status: 409, error: OWNER_ARCHIVED };
    }
    let id: string;
    try {
      id = this.deps.workers.insert({
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
      await takeBackWindow();
      await takeBackWorktree();
      return { ok: false, status: 400, error: errorMessage(err, "insert failed") };
    }

    this.giveOpenOwner(id, input.openOwner);
    return { ok: true, worker: this.deps.workers.getById(id)! };
  }

  /** In the project's turn: it may rebuild the worker's window, which a
   *  create, archive or restore of a worker may be changing. */
  async createShellPane(input: CreateShellPaneInput): Promise<CreateWorkerPaneResult> {
    const worker = this.deps.workers.getById(input.workerId);
    if (!worker || worker.archivedAt) {
      return { ok: false, status: 404, error: "worker not found" };
    }
    return projectWork.run(worker.projectId, () => this.createShellPaneAlone(input));
  }

  private async createShellPaneAlone(input: CreateShellPaneInput): Promise<CreateWorkerPaneResult> {
    const worker = this.deps.workers.getById(input.workerId);
    if (!worker || worker.archivedAt) {
      return { ok: false, status: 404, error: "worker not found" };
    }

    const project = this.deps.projects.getById(worker.projectId);
    if (!project || project.archivedAt) {
      return { ok: false, status: 404, error: "project not found" };
    }

    const cwd = worker.worktreePath ?? project.workingDir;
    const runtime = this.deps.tmuxRuntime;

    try {
      const paneBefore = (await runtime.listPanes(worker.id))[0] ?? null;
      if (paneBefore) {
        return { ok: true, pane: paneBefore };
      }

      const adapter = tmuxReconcileAdapter(this.deps.tmuxClient);
      await reconcileProject(project, this.deps.workers.listActiveByProject(project.id), adapter);
      await reconcileWorker(worker, project, adapter);
      const paneAfterReconcile = (await runtime.listPanes(worker.id))[0] ?? null;

      if (paneAfterReconcile) {
        return { ok: true, pane: paneAfterReconcile };
      }

      const pane = await runtime.spawnPane({ workerId: worker.id, cwd });
      return { ok: true, pane };
    } catch (err: unknown) {
      if (err instanceof CommandDidNotAnswerError) throw err;
      return { ok: false, status: 500, error: errorMessage(err) };
    }
  }


  /** What archiving this worker would lose; null when the worker or its
   *  project is gone. A worker in shared-cwd mode owns no worktree or
   *  branch, so it has nothing to check. */
  async archiveCheck(id: string): Promise<ArchiveCheckDto | null> {
    const row = this.deps.workers.getById(id);
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
    }, this.gitClient());
  }

  /** One at a time per project: the row is read again once the work before
   *  it is done, so a worker archived meanwhile is not archived twice over. */
  async archive(input: ArchiveWorkerInput): Promise<ArchiveWorkerResult> {
    const row = this.deps.workers.getById(input.id);
    if (!row) return { ok: false, status: 404, error: "worker not found" };
    return projectWork.run(row.projectId, () => this.archiveAlone(input));
  }

  private async archiveAlone(input: ArchiveWorkerInput): Promise<ArchiveWorkerResult> {
    const row = this.deps.workers.getById(input.id);
    if (!row) return { ok: false, status: 404, error: "worker not found" };
    // Asked again in turn: another thread may have restored it meanwhile.
    const refusal = input.by && this.deps.agentStore ? ownerRefusal({ workersStore: this.deps.workers, agentStore: this.deps.agentStore }, row.id, input.by) : null;
    if (refusal) return { ok: false, status: 409, error: refusal };

    const project = this.deps.projects.getById(row.projectId);
    const cleanup = resolveArchiveWorkerCleanup(row, input);
    const tmuxClient = this.deps.tmuxClient;
    const gitClient = this.gitClient();
    const failures: ArchiveWorkerCleanupFailure[] = [];

    // Never archive away uncommitted or unmerged work
    // without the user's say-so. The refusal carries the findings so the
    // caller can ask.
    if (!input.confirmed) {
      const check = await this.archiveCheck(row.id);
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
    const sameRepository = async (a: string, b: string) => {
      try {
        const repository = await gitCommonDir(a, gitClient);
        return repository !== null && repository === await gitCommonDir(b, gitClient);
      } catch {
        return false; // git did not answer: not shown to be the same
      }
    };
    const otherRepository = worktreeThere && project?.workingDir ? !await sameRepository(worktreePath!, project.workingDir) : false;
    // The branches the worker made in its own worktree (an MR's), read while
    // the worktree is still there, by git's own records only: a branch made
    // anywhere else stays, even one the worker checked out. Kept when the
    // caller keeps branches or the worktree.
    const workerBranches = cleanup.removeWorktree && input.cleanup?.deleteBranch !== false && makesWorktree(row.mode)
      && worktreeThere && !otherRepository
      ? (await gitBranchesCreatedInWorktree(worktreePath!, gitClient)).filter((made) => made.name !== row.branch)
      : [];
    if (cleanup.removeWorktree && worktreePath && otherRepository) {
      failures.push({ kind: "worktree", worktreePath, error: "the worktree belongs to another repository than the project's folder; it was kept" });
    } else if (cleanup.removeWorktree && worktreePath) {
      await this.tryCleanup(input.id, failures, async () => {
        await gitWorktreeRemove(worktreePath, project?.workingDir, { force: cleanup.forceRemoveWorktree }, gitClient);
      }, (error) => ({ kind: "worktree", worktreePath, error }));
    }

    // A branch git did not answer about is left as it is, and said so, like
    // one that would not delete.
    const branch = row.branch;
    if (cleanup.deleteBranch && branch && otherRepository) {
      failures.push({ kind: "branch", branch, error: "the worktree belongs to another repository than the project's folder; no branch was deleted" });
    } else if (cleanup.deleteBranch && project?.workingDir && branch) {
      await this.tryCleanup(input.id, failures, async () => {
        if (await gitBranchExists(project.workingDir, branch, gitClient)) {
          await gitBranchDelete(project.workingDir, branch, { force: cleanup.forceDeleteBranch }, gitClient);
        }
      }, (error) => ({ kind: "branch", branch, error }));
    }
    // Only a safe delete, never forced: one not merged stays, and is said.
    // Read again first: by now the name may be another branch.
    for (const made of project?.workingDir ? workerBranches : []) {
      await this.tryCleanup(input.id, failures, async () => {
        if (await gitBranchIsStill(project!.workingDir, made, gitClient)) {
          await gitBranchDelete(project!.workingDir, made.name, { force: false }, gitClient);
        }
      }, (error) => ({ kind: "branch", branch: made.name, error }));
    }

    // A window tmux did not answer about is left as it is, and said so, like
    // one that would not close: the archive itself goes ahead either way.
    if (project) {
      await this.tryCleanup(input.id, failures, async () => {
        if (await tmuxHasWindow(project.tmuxSessionName, row.tmuxWindowName, tmuxClient)) {
          await tmuxKillWindow(project.tmuxSessionName, row.tmuxWindowName, tmuxClient);
          this.deps.refreshTmux?.();
        }
      }, (error) => ({ kind: "terminal", windowName: row.tmuxWindowName, error }));
    }

    if (!row.archivedAt) {
      try {
        this.deps.beforeWorkerArchive?.(input.id);
      } catch (err) {
        const msg = errorText(err);
        console.warn(`[mandate] memory worker-archive hook failed: ${msg}`);
      }
      this.deps.workers.archive(input.id);
    }

    return { ok: true, worker: this.deps.workers.getById(input.id) ?? row, cleanupFailures: failures };
  }

  /** One archive cleanup step: a failure is kept for the result and
   *  broadcast, never thrown. */
  private async tryCleanup(
    workerId: string,
    failures: ArchiveWorkerCleanupFailure[],
    step: () => void | Promise<void>,
    failed: (error: string) => ArchiveWorkerCleanupFailure
  ): Promise<void> {
    try {
      await step();
    } catch (err: unknown) {
      const failure = failed(errorMessage(err));
      failures.push(failure);
    }
  }

  /** One at a time per project: the row is read again once the work before
   *  it is done, so a worker restored meanwhile is not restored twice. */
  async restore(input: RestoreWorkerInput): Promise<RestoreWorkerResult> {
    const worker = this.deps.workers.getById(input.id);
    if (!worker) return { ok: false, status: 404, error: "worker not found" };
    return projectWork.run(worker.projectId, () => this.restoreAlone(input));
  }

  private async restoreAlone(input: RestoreWorkerInput): Promise<RestoreWorkerResult> {
    const worker = this.deps.workers.getById(input.id);
    if (!worker) return { ok: false, status: 404, error: "worker not found" };
    if (!worker.archivedAt) return { ok: false, status: 409, error: "worker is not archived" };

    const project = this.deps.projects.getById(worker.projectId);
    if (!project || project.archivedAt) return { ok: false, status: 404, error: "project not found or archived" };

    const mode = input.mode === undefined ? worker.mode : input.mode;
    if (!isWorkerMode(mode)) return { ok: false, status: 400, error: `unknown mode: ${String(mode)}` };
    if (mode !== "shared-cwd" && !project.isGit) {
      return { ok: false, status: 400, error: `mode ${mode} requires a git project` };
    }

    const tmuxClient = this.deps.tmuxClient;
    const gitClient = this.gitClient();
    const tmuxWindowName = normalizedOverride(input.tmuxWindowName, worker.tmuxWindowName);
    if (!tmuxWindowName) return { ok: false, status: 400, error: "tmuxWindowName is required" };
    const taken = await this.restoreNameConflict(worker, project, tmuxWindowName, tmuxClient);
    if (taken) return { ok: false, status: 409, error: taken };

    const branch = normalizeRestoreBranch(mode, normalizedOverride(input.branch, worker.branch));
    const baseRefInput = normalizedOptional(input.baseRef);
    const baseRef = mode === "new-branch-new-worktree"
      ? baseRefInput || worker.baseRef || await gitResolveDefaultBaseRef(project.workingDir, gitClient)
      : baseRefInput || worker.baseRef;
    const worktreePath = normalizeRestoreWorktreePath({
      mode,
      explicit: normalizedOptional(input.worktreePath),
      archived: worker.worktreePath,
      defaultWorktreePath: branch ? this.worktreePathForProject(project, branch) : null
    });

    const conflict = await this.restoreResourceConflict({
      project,
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
    const reconcile = recordingReconcileAdapter(tmuxReconcileAdapter(tmuxClient));
    try {
      // Its worktree and window first, its records last, as for a create:
      // nothing starts work in the worker until both are there.
      if (makesWorktree(mode)) {
        await addWorktree(project.workingDir, mode, worktreePath!, branch!, baseRef, gitClient);
        addedWorktree = true;
      }
      const adapter = reconcile.adapter;
      await reconcileProject(project, this.deps.workers.listActiveByProject(project.id), adapter);
      await reconcileWorker({ tmuxWindowName, ownership: worker.ownership, worktreePath }, project, adapter);

      // From here to the records, nothing waits. The row itself can have
      // gone meanwhile: its old manager's delete takes it without a turn here.
      if (!this.deps.workers.getById(input.id)) throw new WorkerGoneError();
      if (this.ownerArchived(input.ownerThreadId)) throw new OwnerArchivedError();
      this.deps.workers.restore({
        id: input.id,
        mode,
        branch,
        baseRef,
        worktreePath,
        tmuxWindowName,
        ownerThreadId: input.ownerThreadId ?? null
      });
      this.deps.agentStore?.restoreMainThread("worker", input.id);
      this.deps.refreshTmux?.();
      return { ok: true, worker: this.deps.workers.getById(input.id)! };
    } catch (err) {
      // Records first, should any have been written: nothing may start work
      // on the worker while git takes its worktree back.
      this.undoRestoredRecords(worker, hadOpenThread);
      await this.closeOpenedWindow(reconcile.opened, tmuxWindowName, tmuxClient);
      if (addedWorktree && worktreePath) await removeAddedWorktree(project.workingDir, mode, worktreePath, branch, gitClient);
      if (err instanceof CommandDidNotAnswerError) throw err;
      if (err instanceof OwnerArchivedError) return { ok: false, status: 409, error: OWNER_ARCHIVED };
      if (err instanceof WorkerGoneError) return { ok: false, status: 404, error: "worker not found" };
      return { ok: false, status: 500, error: errorMessage(err) };
    }
  }

  /** What already holds the name or window a restored worker would take. */
  private async restoreNameConflict(
    worker: WorkerRow,
    project: { tmuxSessionName: string },
    tmuxWindowName: string,
    tmuxClient: TmuxClient
  ): Promise<string | null> {
    if (this.deps.workers.activeNameExists(worker.projectId, worker.name, worker.id)) {
      return `worker name '${worker.name}' is already active`;
    }
    if (this.deps.workers.activeWindowNameExists(worker.projectId, tmuxWindowName, worker.id)) {
      return `worker window '${tmuxWindowName}' is already active`;
    }
    if (await tmuxHasWindow(project.tmuxSessionName, tmuxWindowName, tmuxClient)) {
      return `tmux window '${tmuxWindowName}' already exists`;
    }
    return null;
  }

  /** Best-effort rollback of a failed restore's records: the row as it was,
   *  and its thread closed again unless it was open before. */
  private undoRestoredRecords(worker: WorkerRow, hadOpenThread: boolean): void {
    if (this.deps.workers.getById(worker.id)?.archivedAt === null) {
      try { this.deps.workers.undoRestore(worker); } catch { /* best-effort rollback */ }
    }
    if (!hadOpenThread) {
      const reopened = this.deps.agentStore?.getThreadByScope("worker", worker.id);
      if (reopened) {
        try { this.deps.agentStore?.archiveThread(reopened.id); } catch { /* best-effort rollback */ }
      }
    }
  }

  /** Best-effort: the window this attempt opened for its own worker, by id. */
  private async closeOpenedWindow(opened: OpenedWindow[], windowName: string, tmuxClient: TmuxClient): Promise<void> {
    for (const window of opened) {
      if (window.window !== windowName) continue;
      try { await tmuxKillWindowById(window.id, tmuxClient); } catch { /* best-effort rollback */ }
    }
  }

  private async restoreResourceConflict(input: {
    project: { workingDir: string };
    gitClient: GitClient;
    mode: WorkerMode;
    branch: string | null;
    baseRef: string | null;
    worktreePath: string | null;
  }): Promise<RestoreWorkerResult | null> {
    const { project, gitClient, mode, branch, baseRef, worktreePath } = input;
    if (mode === "shared-cwd") return null;
    if (!branch) return { ok: false, status: 400, error: "branch is required" };

    if (mode === "new-branch-new-worktree") {
      if (await gitBranchExists(project.workingDir, branch, gitClient)) {
        return { ok: false, status: 409, error: `branch '${branch}' already exists` };
      }
      if (!baseRef) return { ok: false, status: 400, error: "baseRef could not be resolved" };
      if (!await gitRefExists(project.workingDir, baseRef, gitClient)) {
        return { ok: false, status: 400, error: `baseRef '${baseRef}' does not resolve to a commit` };
      }
    } else if (!await gitBranchExists(project.workingDir, branch, gitClient)) {
      return { ok: false, status: 409, error: `branch '${branch}' does not exist` };
    }

    if (mode === "existing-branch-existing-worktree") {
      if (!worktreePath) return { ok: false, status: 400, error: "worktreePath is required" };
      if (!fs.existsSync(worktreePath)) {
        return { ok: false, status: 409, error: `worktreePath '${worktreePath}' does not exist` };
      }
      return null;
    }

    if (!worktreePath) return { ok: false, status: 400, error: "worktreePath is required" };
    if (fs.existsSync(worktreePath)) {
      return { ok: false, status: 409, error: `worktreePath '${worktreePath}' already exists` };
    }
    return null;
  }

  /** Whether the thread a worker is being made or restored for has been
   *  archived. */
  private ownerArchived(ownerThreadId: string | null | undefined): boolean {
    if (!ownerThreadId || !this.deps.agentStore) return false;
    return this.deps.agentStore.getThreadById(ownerThreadId)?.archivedAt != null;
  }

  private giveOpenOwner(workerId: string, openOwner: OpenOwner | undefined): void {
    if (!openOwner || !this.deps.agentStore) return;
    ensureOpenOwner({ workersStore: this.deps.workers, agentStore: this.deps.agentStore }, workerId, openOwner.preferred ?? null);
  }

  private archiveFailedCreate(workerId: string) {
    const thread = this.deps.agentStore?.getThreadByScope("worker", workerId);
    if (thread) this.deps.agentStore?.archiveThread(thread.id);
    this.deps.workers.archive(workerId);
  }

  private gitClient(): GitClient {
    return this.deps.gitClient ?? DEFAULT_GIT;
  }

  /** The branch, base and worktree a new worker of this mode works in, each
   *  checked against the repository; or why the request cannot be one. */
  private async createLayout(
    project: { workingDir: string; tmuxSessionName: string },
    mode: WorkerMode,
    input: { branch?: string; baseRef?: string; worktreePath?: string },
    gitClient: GitClient
  ): Promise<{ branch: string | null; baseRef: string | null; worktreePath: string | null } | { error: string }> {
    const branchInput = (input.branch ?? "").trim();
    const baseRefInput = (input.baseRef ?? "").trim();
    const worktreePathInput = (input.worktreePath ?? "").trim();
    if (mode === "shared-cwd") return { branch: null, baseRef: null, worktreePath: null };
    if (!branchInput) return { error: "branch is required" };
    if (mode === "new-branch-new-worktree") {
      if (await gitBranchExists(project.workingDir, branchInput, gitClient)) {
        return { error: `branch '${branchInput}' already exists` };
      }
      const baseRef = baseRefInput || await gitResolveDefaultBaseRef(project.workingDir, gitClient);
      if (!baseRef) return { error: "baseRef could not be resolved" };
      if (!await gitRefExists(project.workingDir, baseRef, gitClient)) {
        return { error: `baseRef '${baseRef}' does not resolve to a commit` };
      }
      return { branch: branchInput, baseRef, worktreePath: this.worktreePathForProject(project, branchInput) };
    }
    if (mode === "existing-branch-new-worktree") {
      if (!await gitBranchExists(project.workingDir, branchInput, gitClient)) {
        return { error: `branch '${branchInput}' does not exist` };
      }
      return { branch: branchInput, baseRef: null, worktreePath: this.worktreePathForProject(project, branchInput) };
    }
    if (!worktreePathInput) return { error: "worktreePath is required" };
    if (!fs.existsSync(worktreePathInput)) return { error: "worktreePath does not exist" };
    return { branch: branchInput, baseRef: null, worktreePath: worktreePathInput };
  }

  private worktreePathForProject(project: { tmuxSessionName: string }, branch: string): string {
    const sanitizedBranch = sanitizeWorkerName(branch);
    return worktreePathFor(project.tmuxSessionName, sanitizedBranch);
  }
}

export async function createWorkerWithMaterialization(
  input: CreateWorkerInput,
  deps: WorkerServiceDeps
): Promise<CreateWorkerResult> {
  return new WorkerService(deps).create(input);
}

export async function archiveWorkerCascade(
  input: ArchiveWorkerInput,
  deps: WorkerServiceDeps
): Promise<ArchiveWorkerResult> {
  return new WorkerService(deps).archive(input);
}

export async function restoreWorkerMaterialization(
  input: RestoreWorkerInput,
  deps: WorkerServiceDeps
): Promise<RestoreWorkerResult> {
  return new WorkerService(deps).restore(input);
}

export function workerRowToDto(row: WorkerRow): WorkerDto {
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

function isWorkerMode(value: unknown): value is WorkerMode {
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

function normalizeRestoreBranch(mode: WorkerMode, value: string | null): string | null {
  return mode === "shared-cwd" ? null : value;
}

function normalizeRestoreWorktreePath(input: {
  mode: WorkerMode;
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
function makesWorktree(mode: WorkerMode): boolean {
  return mode === "new-branch-new-worktree" || mode === "existing-branch-new-worktree";
}

async function addWorktree(
  projectDir: string,
  mode: WorkerMode,
  worktreePath: string,
  branch: string,
  baseRef: string | null,
  gitClient: GitClient
): Promise<void> {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await gitWorktreeAdd(projectDir, worktreePath, branch, {
    newBranch: mode === "new-branch-new-worktree",
    baseRef
  }, gitClient);
}

/** Best-effort rollback of addWorktree: the worktree, and the branch it made
 *  — or adding it again fails on "already exists". */
async function removeAddedWorktree(projectDir: string, mode: WorkerMode, worktreePath: string, branch: string | null, gitClient: GitClient): Promise<void> {
  try { await gitWorktreeRemove(worktreePath, projectDir, { force: true }, gitClient); }
  catch { /* best-effort rollback */ }
  if (mode === "new-branch-new-worktree" && branch) {
    try { await gitBranchDelete(projectDir, branch, { force: true }, gitClient); }
    catch { /* best-effort rollback */ }
  }
}

/** What archiving a worker removes: the cleanup asked for, else the
 *  defaults for how the worker was made (its own worktree, its own branch). */
export function resolveArchiveWorkerCleanup(
  worker: WorkerRow,
  input: { cleanup?: ArchiveWorkerCleanupOptions }
): Required<ArchiveWorkerCleanupOptions> {
  const createdWorktree = makesWorktree(worker.mode);
  const createdBranch = worker.mode === "new-branch-new-worktree";
  return {
    removeWorktree: input.cleanup?.removeWorktree ?? createdWorktree,
    forceRemoveWorktree: input.cleanup?.forceRemoveWorktree ?? false,
    deleteBranch: input.cleanup?.deleteBranch ?? createdBranch,
    forceDeleteBranch: input.cleanup?.forceDeleteBranch ?? false
  };
}

const OWNER_ARCHIVED = "the thread that asked for this worker has been archived";

class OwnerArchivedError extends Error {
  constructor() { super(OWNER_ARCHIVED); }
}

class WorkerGoneError extends Error {
  constructor() { super("worker not found"); }
}

function errorMessage(error: unknown, fallback = "operation failed"): string {
  return error instanceof Error ? error.message : String(error || fallback);
}
