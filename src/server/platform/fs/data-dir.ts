import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_DATA_DIR = ".mandate";

export function resolveDataDir(): string {
  const raw = process.env.MANDATE_DATA_DIR;
  if (raw) return expandHome(raw);
  return path.join(os.homedir(), DEFAULT_DATA_DIR);
}

/** A path written from the home directory (`~/…`) as the full path; any
 *  other as written. */
export function expandHome(raw: string): string {
  return raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
}

/** Where Mandate makes workers' worktrees. */
export function worktreesRoot(dataDir = resolveDataDir()): string {
  return path.join(dataDir, "worktrees");
}

export function worktreePathFor(projectTmuxSessionName: string, sanitizedBranch: string): string {
  return path.join(worktreesRoot(), projectTmuxSessionName, sanitizedBranch);
}
