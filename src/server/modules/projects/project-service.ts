import * as fs from "node:fs";
import * as path from "node:path";
import { CommandDidNotAnswerError } from "../../platform/process/command-runner.js";
import type { ProjectsStore, ProjectRow } from "./projects-store.js";
import type { ProjectDto } from "../../../shared/api-contracts.js";
import type { FeaturesStore } from "../features/features-store.js";
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
  tmuxHasSession,
  tmuxKillSession,
  tmuxListSessions,
  tmuxListSessionsWithWindows
} from "../../platform/tmux/tmux.js";
import { reconcileProject, type ReconcileResult } from "./project-reconcile.js";
import type { AgentStore } from "../agent/agent-store.js";
import { tmuxReconcileAdapter } from "./tmux-reconcile-adapter.js";

interface ProjectServiceDeps {
  projects: ProjectsStore;
  features: FeaturesStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  sessionDataDir?: string;
  /** Opens the thread that owns an adopted project's workers. */
  agentStore?: Pick<AgentStore, "createManagerThread">;
}

type CreateProjectResult =
  | { ok: true; project: ProjectRow }
  | { ok: false; status: number; error: string };

type AdoptProjectResult =
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

    const runtime = this.localRuntime();
    const dir = this.ensureWorkingDir(runtime, workingDir);
    if (!dir.ok) return dir;

    const { isGit, gitRemote } = gitDetectRepository(workingDir, runtime.gitClient);

    const taken = new Set([
      ...this.deps.projects.takenTmuxSessionNames(),
      ...tmuxListSessions(runtime.tmuxClient)
    ]);

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

    try {
      const row = this.deps.projects.getById(id)!;
      reconcileProject(row, [], tmuxReconcileAdapter(runtime.tmuxClient));
    } catch (err: unknown) {
      this.deps.projects.archive(id);
      if (err instanceof CommandDidNotAnswerError) throw err;
      return {
        ok: false,
        status: 500,
        error: `tmux session create failed: ${errorMessage(err)}`
      };
    }

    return { ok: true, project: this.deps.projects.getById(id)! };
  }

  adopt(input: {
    sessionName: string;
    projectName: string;
    workingDir: string;
  }): AdoptProjectResult {
    const sessionName = input.sessionName.trim();
    const projectName = input.projectName.trim();
    const workingDir = input.workingDir.trim();

    if (!sessionName) return { ok: false, status: 400, error: "sessionName is required" };
    if (!projectName) return { ok: false, status: 400, error: "projectName is required" };
    if (!workingDir) return { ok: false, status: 400, error: "workingDir is required" };

    const runtime = this.localRuntime();
    if (!runtime.directoryExists(workingDir)) return { ok: false, status: 400, error: "workingDir not found" };

    if (!tmuxHasSession(sessionName, runtime.tmuxClient)) {
      return { ok: false, status: 400, error: `tmux session '${sessionName}' does not exist` };
    }

    if (this.deps.projects.takenTmuxSessionNames().has(sessionName)) {
      return {
        ok: false,
        status: 400,
        error: `session '${sessionName}' is already managed by an active project`
      };
    }

    const { isGit, gitRemote } = gitDetectRepository(workingDir, runtime.gitClient);
    // Read before anything is written: a session list tmux did not answer
    // stops here, rather than leaving a project registered without its workers.
    const sessions = tmuxListSessionsWithWindows(runtime.tmuxClient);

    let id: string;
    try {
      id = this.deps.projects.insert({
        name: projectName,
        workingDir,
        isGit,
        gitRemote,
        tmuxSessionName: sessionName,
        ownership: "adopted"
      });
    } catch (err: unknown) {
      return { ok: false, status: 400, error: errorMessage(err, "insert failed") };
    }

    const session = sessions.find((s) => s.name === sessionName);
    const adopted: string[] = [];
    if (session) {
      for (const windowName of session.windows) {
        try {
          adopted.push(this.deps.features.insert({
            projectId: id,
            name: windowName,
            mode: "shared-cwd",
            branch: null,
            worktreePath: null,
            tmuxWindowName: windowName,
            ownership: "adopted"
          }));
        } catch {
          // Skip duplicate window names; tmux should not emit them, but this
          // keeps adoption idempotent if the source session is unusual.
        }
      }
    }
    // Every active worker has an owner: an adopted
    // project's windows become workers of one thread named after it.
    if (adopted.length > 0 && this.deps.agentStore) {
      const thread = this.deps.agentStore.createManagerThread(projectName);
      for (const featureId of adopted) this.deps.features.setOwner(featureId, thread.id);
    }

    return { ok: true, project: this.deps.projects.getById(id)! };
  }

  /** Points a project at another directory, keeping the project itself (its
   *  memories, threads and workers). A worker in its own worktree must still
   *  be in the same repository afterwards: a worktree belongs to the
   *  repository that made it, and one elsewhere refuses the change until it
   *  is archived. A worktree whose link a move broke belongs to the new
   *  directory's repository only when that repository still lists it as its
   *  own; it is linked again once the change is let through, never before. */
  changeWorkingDir(input: { id: string; workingDir: string }): ChangeWorkingDirResult {
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
    const { isGit, gitRemote } = gitDetectRepository(workingDir, git);
    const withWorktrees = this.deps.features.listActiveByProject(project.id)
      .filter((feature) => feature.mode !== "shared-cwd" && feature.worktreePath && statKind(feature.worktreePath) === "directory");
    if (withWorktrees.length > 0) {
      const repository = isGit ? gitCommonDir(workingDir, git) : null;
      const listed = repository ? gitWorktreePaths(workingDir, git) : [];
      const broken: string[] = [];
      const belongs = (worktreePath: string) => {
        if (!repository) return false;
        const own = gitCommonDir(worktreePath, git);
        if (own) return sameDirectory(own, repository);
        if (!listed.some((listedPath) => sameDirectory(listedPath, worktreePath))) return false;
        broken.push(worktreePath);
        return true;
      };
      const elsewhere = withWorktrees.filter((feature) => !belongs(feature.worktreePath!));
      if (elsewhere.length > 0) {
        return {
          ok: false,
          status: 409,
          error: `These workers' worktrees belong to another repository than ${workingDir}: ${elsewhere.map((f) => f.name).join(", ")}. Archive them first.`,
          workers: elsewhere.map((feature) => ({ id: feature.id, name: feature.name }))
        };
      }
      if (broken.length > 0) gitWorktreeRepair(workingDir, broken, git);
    }

    this.deps.projects.updateWorkingDir(project.id, { workingDir, isGit, gitRemote });
    return { ok: true, project: this.deps.projects.getById(project.id)!, from: project.workingDir, changed: true };
  }

  reconcile(id: string): ReconcileProjectServiceResult {
    const project = this.deps.projects.getById(id);
    if (!project) return { ok: false, status: 404, error: "project not found" };

    const adapter = tmuxReconcileAdapter(this.deps.tmuxClient);
    const activeFeatures = this.deps.features.listActiveByProject(id);
    return { ok: true, result: reconcileProject(project, activeFeatures, adapter) };
  }

  async archive(input: {
    id: string;
    killTmux?: boolean;
  }): Promise<ArchiveProjectResult> {
    const row = this.deps.projects.getById(input.id);
    if (!row) return { ok: false, status: 404, error: "project not found" };

    // One write: a project archived without its workers, or workers archived
    // under a project still active, if the second half failed. Their change
    // events go out as the workers' half finishes, so a rollback after it
    // leaves pages refetching rows that did not change.
    this.deps.projects.transaction(() => {
      this.deps.features.archiveByProjectId(input.id);
      this.deps.projects.archive(input.id);
    });

    if (input.killTmux && this.shouldKillTmuxSession(row)) {
      tmuxKillSession(row.tmuxSessionName, this.deps.tmuxClient);
    }

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

  private localRuntime(): ProjectHostRuntime {
    return {
      tmuxClient: this.deps.tmuxClient,
      gitClient: this.gitClient(),
      directoryExists: (dir) => {
        try { return fs.statSync(dir).isDirectory(); }
        catch { return false; }
      },
      ensureDirectory: (dir) => {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(dir);
        } catch {
          try {
            fs.mkdirSync(dir, { recursive: true });
            stat = fs.statSync(dir);
          } catch (err: unknown) {
            return {
              ok: false,
              status: 400 as const,
              error: `workingDir could not be created: ${errorMessage(err)}`
            };
          }
        }
        if (!stat.isDirectory()) {
          return { ok: false, status: 400 as const, error: "workingDir is not a directory" };
        }
        return { ok: true as const };
      }
    };
  }

  private ensureWorkingDir(runtime: ProjectHostRuntime, workingDir: string): { ok: true } | {
    ok: false;
    status: 400;
    error: string;
  } {
    return runtime.ensureDirectory(workingDir);
  }
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

interface ProjectHostRuntime {
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  directoryExists(dir: string): boolean;
  ensureDirectory(dir: string): { ok: true } | { ok: false; status: 400; error: string };
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
