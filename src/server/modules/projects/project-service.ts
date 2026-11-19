import * as fs from "node:fs";
import * as path from "node:path";
import { CommandDidNotAnswerError } from "../../platform/process/command-runner.js";
import type { ProjectsStore, ProjectRow } from "./projects-store.js";
import type { ProjectDto } from "../../../shared/api-contracts.js";
import type { WorkersStore } from "../workers/workers-store.js";
import {
  DEFAULT_GIT,
  gitCommonDir,
  gitDetectRepository,
  gitWorktreePaths,
  gitWorktreeRepair,
  type GitClient
} from "../../platform/git/git.js";
import {
  isCurrentProjectSessionName,
  resolveProjectSessionNameCollision
} from "../../platform/naming/names.js";
import {
  type TmuxClient,
  tmuxKillSession,
  tmuxListSessions
} from "../../platform/tmux/tmux.js";
import { reconcileProject, type ReconcileResult } from "./project-reconcile.js";
import { tmuxReconcileAdapter } from "./tmux-reconcile-adapter.js";
import { projectWork, sessionWork } from "./project-work.js";

interface ProjectServiceDeps {
  projects: ProjectsStore;
  workers: WorkersStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  sessionDataDir?: string;
}

type CreateProjectResult =
  | { ok: true; project: ProjectRow }
  | { ok: false; status: number; error: string };

type ArchiveProjectResult =
  | { ok: true; project: ProjectRow }
  | { ok: false; status: number; error: string };

type ChangeWorkingDirResult =
  | { ok: true; project: ProjectRow; from: string; changed: boolean }
  | { ok: false; status: number; error: string; workers?: Array<{ id: string; name: string }> };

type ReconcileProjectServiceResult =
  | { ok: true; result: ReconcileResult }
  | { ok: false; status: number; error: string };

export class ProjectService {
  constructor(private deps: ProjectServiceDeps) {}

  async create(input: {
    name: string;
    workingDir: string;
  }): Promise<CreateProjectResult> {
    const name = input.name.trim();
    const workingDir = input.workingDir.trim();

    if (!name) return { ok: false, status: 400, error: "name is required" };
    if (!workingDir) return { ok: false, status: 400, error: "workingDir is required" };

    const dir = ensureWorkingDir(workingDir);
    if (!dir.ok) return dir;

    const tmuxClient = this.deps.tmuxClient;
    const { isGit, gitRemote } = await gitDetectRepository(workingDir, this.gitClient());
    const sessions = await tmuxListSessions(tmuxClient);

    // The names taken are read after tmux answered, with nothing waiting from
    // here to the record: another project made meanwhile is counted.
    const taken = new Set([...this.deps.projects.takenTmuxSessionNames(), ...sessions]);

    let tmuxSessionName: string;
    try {
      tmuxSessionName = resolveProjectSessionNameCollision(
        name,
        (n) => taken.has(n),
        { dataDir: this.deps.sessionDataDir }
      );
    } catch (err: unknown) {
      return { ok: false, status: 400, error: errorMessage(err, "name sanitization failed") };
    }

    let id: string;
    try {
      id = this.deps.projects.insert({
        name,
        workingDir,
        isGit,
        gitRemote,
        tmuxSessionName,
        ownership: "app"
      });
    } catch (err: unknown) {
      return { ok: false, status: 400, error: errorMessage(err, "insert failed") };
    }

    // In the project's turn: a worker made in it at once rebuilds the same
    // session, and one queued behind a failed session finds the project
    // archived, not active.
    const failure = await projectWork.run(id, async (): Promise<{ error: unknown } | null> => {
      try {
        await reconcileProject(this.deps.projects.getById(id)!, [], tmuxReconcileAdapter(tmuxClient));
        return null;
      } catch (error: unknown) {
        this.deps.projects.archive(id);
        return { error };
      }
    });
    if (failure) {
      if (failure.error instanceof CommandDidNotAnswerError) throw failure.error;
      return {
        ok: false,
        status: 500,
        error: `tmux session create failed: ${errorMessage(failure.error)}`
      };
    }

    return { ok: true, project: this.deps.projects.getById(id)! };
  }

  /** Points a project at another directory, keeping the project itself (its
   *  memories, threads and workers). A worker in its own worktree must still
   *  be in the same repository afterwards: a worktree belongs to the
   *  repository that made it, and one elsewhere refuses the change until it
   *  is archived. A worktree whose link a move broke belongs to the new
   *  directory's repository only when that repository still lists it as its
   *  own; it is linked again once the change is let through, never before.
   *  One at a time with the project's other work: a worker made meanwhile is
   *  weighed too. */
  changeWorkingDir(input: { id: string; workingDir: string }): Promise<ChangeWorkingDirResult> {
    return projectWork.run(input.id, () => this.changeWorkingDirAlone(input));
  }

  private async changeWorkingDirAlone(input: { id: string; workingDir: string }): Promise<ChangeWorkingDirResult> {
    const project = this.deps.projects.getById(input.id);
    if (!project || project.archivedAt) return { ok: false, status: 404, error: "project not found" };
    const raw = input.workingDir.trim();
    if (!raw) return { ok: false, status: 400, error: "workingDir is required" };
    if (!path.isAbsolute(raw)) return { ok: false, status: 400, error: "Give the directory as an absolute path." };
    const workingDir = withoutTrailingSlash(raw);
    if (workingDir === withoutTrailingSlash(project.workingDir)) return { ok: true, project, from: project.workingDir, changed: false };
    const kind = statKind(workingDir);
    if (kind === "missing") return { ok: false, status: 400, error: "That directory does not exist." };
    if (kind === "file") return { ok: false, status: 400, error: "That is a file, not a directory." };

    const git = this.gitClient();
    const { isGit, gitRemote } = await gitDetectRepository(workingDir, git);
    const withWorktrees = this.deps.workers.listActiveByProject(project.id)
      .filter((worker) => worker.mode !== "shared-cwd" && worker.worktreePath && statKind(worker.worktreePath) === "directory");
    if (withWorktrees.length > 0) {
      const repository = isGit ? await gitCommonDir(workingDir, git) : null;
      const listed = repository ? await gitWorktreePaths(workingDir, git) : [];
      const broken: string[] = [];
      const belongs = async (worktreePath: string) => {
        if (!repository) return false;
        const own = await gitCommonDir(worktreePath, git);
        if (own) return sameDirectory(own, repository);
        if (!listed.some((listedPath) => sameDirectory(listedPath, worktreePath))) return false;
        broken.push(worktreePath);
        return true;
      };
      const elsewhere: typeof withWorktrees = [];
      for (const worker of withWorktrees) if (!await belongs(worker.worktreePath!)) elsewhere.push(worker);
      if (elsewhere.length > 0) {
        return {
          ok: false,
          status: 409,
          error: `These workers' worktrees belong to another repository than ${workingDir}: ${elsewhere.map((w) => w.name).join(", ")}. Archive them first.`,
          workers: elsewhere.map((worker) => ({ id: worker.id, name: worker.name }))
        };
      }
      if (broken.length > 0) await gitWorktreeRepair(workingDir, broken, git);
    }

    this.deps.projects.updateWorkingDir(project.id, { workingDir, isGit, gitRemote });
    return { ok: true, project: this.deps.projects.getById(project.id)!, from: project.workingDir, changed: true };
  }

  /** In the project's turn: it checks tmux and then rebuilds. */
  reconcile(id: string): Promise<ReconcileProjectServiceResult> {
    return projectWork.run(id, async () => {
      // Read in turn: an archive before it would leave a rebuilt session no project owns.
      const project = this.deps.projects.getById(id);
      if (!project || project.archivedAt) return { ok: false, status: 404, error: "project not found" };

      const adapter = tmuxReconcileAdapter(this.deps.tmuxClient);
      const activeWorkers = this.deps.workers.listActiveByProject(id);
      return { ok: true, result: await reconcileProject(project, activeWorkers, adapter) };
    });
  }

  /** One at a time with the project's other work: a worker being made or
   *  restored is done first, and archived with the rest. */
  archive(input: { id: string; killTmux?: boolean }): Promise<ArchiveProjectResult> {
    return projectWork.run(input.id, () => this.archiveAlone(input));
  }

  private async archiveAlone(input: { id: string; killTmux?: boolean }): Promise<ArchiveProjectResult> {
    const row = this.deps.projects.getById(input.id);
    if (!row) return { ok: false, status: 404, error: "project not found" };

    // In the session's turn. The session goes first: until the project is
    // archived it counts as managed.
    await sessionWork.run(row.tmuxSessionName, async () => {
      if (input.killTmux && this.shouldKillTmuxSession(row)) {
        await tmuxKillSession(row.tmuxSessionName, this.deps.tmuxClient);
      }

      // One write: a project archived without its workers, or workers archived
      // under a project still active, if the second half failed. Their change
      // events go out as the workers' half finishes, so a rollback after it
      // leaves pages refetching rows that did not change.
      this.deps.projects.transaction(() => {
        this.deps.workers.archiveByProjectId(input.id);
        this.deps.projects.archive(input.id);
      });
    });

    return { ok: true, project: row };
  }

  private shouldKillTmuxSession(row: ProjectRow): boolean {
    if (row.ownership === "adopted") return true;
    return isCurrentProjectSessionName(row.tmuxSessionName, {
      dataDir: this.deps.sessionDataDir
    });
  }

  private gitClient(): GitClient {
    return this.deps.gitClient ?? DEFAULT_GIT;
  }

}

/** A new project's working directory: made when missing; refused when it
 *  cannot be made or is a file. */
function ensureWorkingDir(dir: string): { ok: true } | { ok: false; status: 400; error: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    try {
      fs.mkdirSync(dir, { recursive: true });
      stat = fs.statSync(dir);
    } catch (err: unknown) {
      return { ok: false, status: 400, error: `workingDir could not be created: ${errorMessage(err)}` };
    }
  }
  if (!stat.isDirectory()) return { ok: false, status: 400, error: "workingDir is not a directory" };
  return { ok: true };
}

/** A directory as it was named, less its trailing slashes. Not resolved by
 *  name: a ".." after a link is the filesystem's to follow. */
function withoutTrailingSlash(dir: string): string {
  return dir.replace(/\/+$/, "") || "/";
}

function statKind(dir: string): "directory" | "file" | "missing" {
  try { return fs.statSync(dir).isDirectory() ? "directory" : "file"; }
  catch { return "missing"; }
}

/** Two paths of one directory, as the system finds them: a link (macOS's
 *  /tmp, say) or a ".." after one does not tell them apart. Paths not on
 *  disk compare by name. */
function sameDirectory(a: string, b: string): boolean {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export async function createProjectWithMaterialization(
  input: { name: string; workingDir: string },
  deps: ProjectServiceDeps
): Promise<CreateProjectResult> {
  return new ProjectService(deps).create(input);
}

export async function archiveProjectCascade(
  input: { id: string; killTmux?: boolean },
  deps: ProjectServiceDeps
): Promise<ArchiveProjectResult> {
  return new ProjectService(deps).archive(input);
}

export function projectRowToDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    workingDir: row.workingDir,
    isGit: row.isGit,
    gitRemote: row.gitRemote,
    tmuxSessionName: row.tmuxSessionName,
    ownership: row.ownership,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt
  };
}

function errorMessage(error: unknown, fallback = "operation failed"): string {
  return error instanceof Error ? error.message : String(error || fallback);
}
