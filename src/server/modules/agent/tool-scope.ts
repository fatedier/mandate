import * as os from "node:os";
import * as path from "node:path";
import { resolveDataDir } from "../../platform/fs/data-dir.js";

export type AgentScope =
  | {
      kind: "worker";
      feature: { workingDir?: string | null };
      project: { workingDir: string };
    }
  | {
      /** A manager or the global agent: no roots, any path is read and written. */
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

function featureRoots(scope: Extract<AgentScope, { kind: "worker" }>): string[] {
  const roots = [scope.project.workingDir];
  if (scope.feature.workingDir && scope.feature.workingDir !== scope.project.workingDir) {
    roots.push(scope.feature.workingDir);
  }
  return roots;
}

export function readScopeRoots(scope: Extract<AgentScope, { kind: "worker" }>): string[] {
  return uniqueRoots([...featureRoots(scope), ...scratchRoots(), ...mandateDataRoots()]);
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
    return path.resolve(scope.feature.workingDir || scope.project.workingDir);
  }
  return path.resolve(scope.managerDir);
}

export function assertWriteInScope(targetPath: string, scope: AgentScope): string {
  const abs = path.resolve(targetPath);
  if (scope.kind === "manager") return abs;

  const roots = [...featureRoots(scope), ...scratchRoots(), ...mandateDataRoots()];
  if (isInsideAny(abs, roots)) return abs;
  throw new Error(
    `path is outside worker scope (allowed roots: ${roots.join(", ")})`
  );
}
