import * as fs from "node:fs";
import type { ProjectsStore, ProjectRow } from "./projects-store.js";
import type { ProjectDto } from "../../../shared/api-contracts.js";
import type { FeaturesStore } from "../features/features-store.js";
import {
  DEFAULT_GIT,
  gitDetectRepository,
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
import { tmuxReconcileAdapter } from "./tmux-reconcile-adapter.js";

export interface ProjectServiceDeps {
  projects: ProjectsStore;
  features: FeaturesStore;
  tmuxClient: TmuxClient;
  gitClient?: GitClient;
  sessionDataDir?: string;
}

export type CreateProjectResult =
  | { ok: true; project: ProjectRow }
  | { ok: false; status: number; error: string };

export type AdoptProjectResult =
  | { ok: true; project: ProjectRow }
  | { ok: false; status: number; error: string };

export type ArchiveProjectResult =
  | { ok: true; project: ProjectRow }
  | { ok: false; status: number; error: string };

export type ReconcileProjectServiceResult =
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

    const sessions = tmuxListSessionsWithWindows(runtime.tmuxClient);
    const session = sessions.find((s) => s.name === sessionName);
    if (session) {
      for (const windowName of session.windows) {
        try {
          this.deps.features.insert({
            projectId: id,
            name: windowName,
            mode: "shared-cwd",
            branch: null,
            worktreePath: null,
            tmuxWindowName: windowName,
            ownership: "adopted"
          });
        } catch {
          // Skip duplicate window names; tmux should not emit them, but this
          // keeps adoption idempotent if the source session is unusual.
        }
      }
    }

    return { ok: true, project: this.deps.projects.getById(id)! };
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

    this.deps.features.archiveByProjectId(input.id);
    this.deps.projects.archive(input.id);

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
