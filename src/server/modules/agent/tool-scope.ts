import * as os from "node:os";
import * as path from "node:path";
import { resolveDataDir } from "../../platform/fs/data-dir.js";

export type AgentScope =
  | {
      kind: "worker";
      worker: { workingDir?: string | null };
      project: { workingDir: string };
    }
  | {
      /** A manager or the personal agent: no roots, any path is read and written. */
      kind: "manager";
      managerDir: string;
      projectWorkingDirs: string[];
    };

export function isInsideAny(abs: string, roots: string[]): boolean {
  for (const root of roots) {
    const r = path.resolve(root);
    if (abs === r || abs.startsWith(r + path.sep)) return true;
  }
  return false;
}

export function uniqueRoots(roots: string[]): string[] {
  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

function scratchRoots(): string[] {
  return uniqueRoots([
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/tmp"
  ]);
}

function mandateDataRoots(): string[] {
  return uniqueRoots([resolveDataDir()]);
}

function workerRoots(scope: Extract<AgentScope, { kind: "worker" }>): string[] {
  const roots = [scope.project.workingDir];
  if (scope.worker.workingDir && scope.worker.workingDir !== scope.project.workingDir) {
    roots.push(scope.worker.workingDir);
  }
  return roots;
}

export function readScopeRoots(scope: Extract<AgentScope, { kind: "worker" }>): string[] {
  return uniqueRoots([...workerRoots(scope), ...scratchRoots(), ...mandateDataRoots()]);
}

export function assertReadInScope(targetPath: string, scope: AgentScope): string {
  const abs = path.resolve(targetPath);
  if (scope.kind === "manager") return abs;

  const roots = readScopeRoots(scope);
  if (isInsideAny(abs, roots)) return abs;
  throw new Error(
    `path is outside worker scope (allowed roots: ${roots.join(", ")})`
  );
}

export function primaryWorkspaceRoot(scope: AgentScope): string {
  if (scope.kind === "worker") {
    return path.resolve(scope.worker.workingDir || scope.project.workingDir);
  }
  return path.resolve(scope.managerDir);
}

/** Where a scope's writes stay inside its work: a worker's roots, a
 *  manager's directory and its projects, the personal agent's own directory (it has
 *  no projects of its own: `projects: false`), with scratch and Mandate's
 *  data for all. A worker's are the roots assertWriteInScope keeps it to. */
export function allowedWriteRoots(scope: AgentScope, opts: { projects?: boolean; scratch?: readonly string[] } = {}): string[] {
  const scratch = opts.scratch ?? scratchRoots();
  if (scope.kind === "worker") return uniqueRoots([...workerRoots(scope), ...scratch, ...mandateDataRoots()]);
  return uniqueRoots([scope.managerDir, ...(opts.projects === false ? [] : scope.projectWorkingDirs), ...scratch, ...mandateDataRoots()]);
}

export function assertWriteInScope(targetPath: string, scope: AgentScope): string {
  const abs = path.resolve(targetPath);
  if (scope.kind === "manager") return abs;

  const roots = [...workerRoots(scope), ...scratchRoots(), ...mandateDataRoots()];
  if (isInsideAny(abs, roots)) return abs;
  throw new Error(
    `path is outside worker scope (allowed roots: ${roots.join(", ")})`
  );
}
