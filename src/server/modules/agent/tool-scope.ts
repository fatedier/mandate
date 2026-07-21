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
      kind: "manager";
      managerDir: string;
      projectWorkingDirs: string[];
    };

function isInsideAny(abs: string, roots: string[]): boolean {
  for (const root of roots) {
    const r = path.resolve(root);
    if (abs === r || abs.startsWith(r + path.sep)) return true;
  }
  return false;
}

function uniqueRoots(roots: string[]): string[] {
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

export function readScopeRoots(scope: AgentScope): string[] {
  if (scope.kind === "worker") {
    return uniqueRoots([...featureRoots(scope), ...scratchRoots(), ...mandateDataRoots()]);
  }
  return uniqueRoots([scope.managerDir, ...scope.projectWorkingDirs, ...scratchRoots(), ...mandateDataRoots()]);
}

export function assertReadInScope(targetPath: string, scope: AgentScope): string {
  const abs = path.resolve(targetPath);

  if (scope.kind === "worker") {
    const roots = readScopeRoots(scope);
    if (isInsideAny(abs, roots)) return abs;
    throw new Error(
      `path is outside worker scope (allowed roots: ${roots.join(", ")})`
    );
  }

  // manager: read = own dir + every project working dir
  const roots = readScopeRoots(scope);
  if (isInsideAny(abs, roots)) return abs;
  throw new Error(
    `path is outside manager read scope (allowed roots: ${roots.join(", ")})`
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

  if (scope.kind === "worker") {
    const roots = [...featureRoots(scope), ...scratchRoots(), ...mandateDataRoots()];
    if (isInsideAny(abs, roots)) return abs;
    throw new Error(
      `path is outside worker scope (allowed roots: ${roots.join(", ")})`
    );
  }

  // manager: write own dir, active project dirs, scratch roots, and Mandate's own data dir.
  const roots = [scope.managerDir, ...scope.projectWorkingDirs, ...scratchRoots(), ...mandateDataRoots()];
  if (isInsideAny(abs, roots)) return abs;
  throw new Error(
    `path is not writable in manager scope (writable roots: ${roots.join(", ")})`
  );
}
