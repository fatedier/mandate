import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_DATA_DIR = ".mandate";

export function resolveDataDir(): string {
  const raw = process.env.MANDATE_DATA_DIR;
  if (raw) {
    if (raw.startsWith("~/")) {
      return path.join(os.homedir(), raw.slice(2));
    }
    return raw;
  }
  return path.join(os.homedir(), DEFAULT_DATA_DIR);
}

export function worktreesRoot(): string {
  return path.join(resolveDataDir(), "worktrees");
}

export function worktreePathFor(projectTmuxSessionName: string, sanitizedBranch: string): string {
  return path.join(worktreesRoot(), projectTmuxSessionName, sanitizedBranch);
}
