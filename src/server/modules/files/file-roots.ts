import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDataDir, worktreesRoot } from "../../platform/fs/data-dir.js";
import { resourcesRoot } from "../../platform/fs/resources.js";
import type { FileErrorCode } from "../../../shared/api/files.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";

export interface FileRootsDeps {
  projects: Pick<ProjectsStore, "listActive">;
  workers: Pick<WorkersStore, "listAllActive">;
  /** The data folder; resolved per request unless a test's. */
  dataDir?: string;
  /** The temporary folders; the machine's unless a test's. */
  tmpRoots?: readonly string[];
}

export type Refusal = { status: 400 | 403 | 404 | 409 | 413; code: FileErrorCode; error: string };

/** The folders a linked file may be in: where the agents' work lives. Read
 *  per request, so a project added or a worktree made since counts. */
export function allowedRoots(deps: FileRootsDeps): string[] {
  const dataDir = deps.dataDir ?? resolveDataDir();
  return [
    ...deps.projects.listActive().map((p) => p.workingDir),
    worktreesRoot(dataDir),
    ...deps.workers.listAllActive().flatMap((w) => (w.worktreePath ? [w.worktreePath] : [])),
    resourcesRoot(dataDir),
    ...(deps.tmpRoots ?? [os.tmpdir(), "/tmp", "/private/tmp", "/var/tmp"])
  ];
}

/** The file a path names, on its real path, when it is inside an allowed
 *  folder (symlinks resolved on both sides, so a link inside a project cannot
 *  reach outside it). Inside the data folder only `resources/` and
 *  `worktrees/` count, even when an allowed folder holds the data folder:
 *  its config, credentials and database never open. */
export function resolveAllowed(raw: string, deps: FileRootsDeps): { requested: string; real: string; stat: fs.Stats } | Refusal {
  if (!raw || raw.includes("\0") || !path.isAbsolute(raw)) return { status: 400, code: "invalid", error: "the path must be absolute" };
  const requested = path.resolve(raw);
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(requested);
    stat = fs.statSync(real);
  } catch {
    return { status: 404, code: "missing", error: "file not found" };
  }
  const dataDir = deps.dataDir ?? resolveDataDir();
  const roots = realRoots(allowedRoots(deps));
  const realData = realOrNull(dataDir);
  const inData = realData !== null && isInside(real, realData);
  const dataOpen = realRoots([resourcesRoot(dataDir), worktreesRoot(dataDir)]);
  if (!roots.some((root) => isInside(real, root)) || (inData && !dataOpen.some((root) => isInside(real, root)))) {
    return { status: 403, code: "outside", error: "the file is outside the folders Mandate shows" };
  }
  if (stat.isDirectory()) return { status: 409, code: "folder", error: "a folder, not a file" };
  if (!stat.isFile()) return { status: 404, code: "missing", error: "file not found" };
  return { requested, real, stat };
}

function realRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map(realOrNull).filter((root): root is string => root !== null))];
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
