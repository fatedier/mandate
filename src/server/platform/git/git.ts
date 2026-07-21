import {
  commandFailureMessage,
  nodeCommandRunner,
  type CommandResult,
  type CommandRunner,
  type CommandRunOptions
} from "../process/command-runner.js";

export interface GitClient {
  runner?: CommandRunner;
  binary?: string;
}

export const DEFAULT_GIT: GitClient = {};

export function gitCommand(client: GitClient, args: string[], options?: CommandRunOptions): CommandResult {
  return (client.runner ?? nodeCommandRunner).run(client.binary ?? "git", args, options);
}

export function gitListBranches(repoDir: string, client: GitClient = DEFAULT_GIT): string[] {
  const r = gitCommand(
    client,
    ["-C", repoDir, "branch", "-a", "--format=%(refname:short)"],
    { encoding: "utf8", timeout: 2000 }
  );
  if (r.status !== 0) return [];
  const seen = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes("->")) continue; // skip "origin/HEAD -> origin/main"
    // strip "origin/" prefix from remote-tracking refs so caller sees logical branch names
    const logical = trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
    seen.add(logical);
  }
  return [...seen].sort();
}

export function gitBranchExists(repoDir: string, name: string, client: GitClient = DEFAULT_GIT): boolean {
  const r = gitCommand(
    client,
    ["-C", repoDir, "show-ref", "--verify", `refs/heads/${name}`],
    { encoding: "utf8", timeout: 1500 }
  );
  return r.status === 0;
}

export function gitCurrentBranch(repoDir: string, client: GitClient = DEFAULT_GIT): string | null {
  const r = gitCommand(client, ["-C", repoDir, "branch", "--show-current"], {
    encoding: "utf8",
    timeout: 1500
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function gitOriginHeadRef(repoDir: string, client: GitClient = DEFAULT_GIT): string | null {
  const r = gitCommand(client, ["-C", repoDir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    encoding: "utf8",
    timeout: 1500
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export function gitHeadCommit(repoDir: string, client: GitClient = DEFAULT_GIT): string | null {
  const r = gitCommand(client, ["-C", repoDir, "rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    timeout: 1500
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * What this branch was last rebased onto, as the ref the rebase was given.
 *
 * `base_ref` is recorded when Mandate creates the feature and never again, so a
 * rebase performed by an agent in a shell leaves it pointing at the old fork.
 * The old ref usually stays an ancestor, so `merge-base` still resolves — just
 * far behind the real one. Measured on a real store: one feature listed 258
 * changed files where the work was 16.
 *
 * git already recorded the answer. `rebase (start): checkout <ref>` in HEAD's
 * reflog holds the ref verbatim, so this reads an intention rather than
 * guessing one from topology. Validated across six live features: it agreed
 * with the record on four and corrected the two that were stale, with no false
 * positives.
 *
 * Null when there is nothing to say — no rebase, no reflog, or a message this
 * does not recognise. **Callers keep their recorded base in that case**, which
 * is what makes an unparsed message harmless rather than destructive.
 *
 * Bounded by reflog expiry (90 days by default) and local to this clone. Both
 * are acceptable here: Mandate owns these worktrees, and a feature on this
 * store lives about a day.
 */
export function gitLastRebaseTarget(repoDir: string, client: GitClient = DEFAULT_GIT): string | null {
  const r = gitCommand(client, ["-C", repoDir, "reflog", "show", "--no-abbrev", "HEAD"], {
    encoding: "utf8",
    timeout: 1500
  });
  if (r.status !== 0) return null;
  // Reflog messages are written in English regardless of locale. Both the plain
  // and interactive forms are matched; `--onto` rebases record the resolved
  // target the same way.
  const match = /rebase(?: -i)? \((?:start|i \(start\))\): checkout (\S+)/.exec(r.stdout);
  return match?.[1] ?? null;
}

export function gitResolveDefaultBaseRef(repoDir: string, client: GitClient = DEFAULT_GIT): string | null {
  return gitCurrentBranch(repoDir, client) ?? gitOriginHeadRef(repoDir, client) ?? gitHeadCommit(repoDir, client);
}

export function gitRefExists(repoDir: string, ref: string, client: GitClient = DEFAULT_GIT): boolean {
  const r = gitCommand(client, ["-C", repoDir, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
    timeout: 1500
  });
  return r.status === 0;
}

export function gitDetectRepository(workingDir: string, client: GitClient = DEFAULT_GIT): {
  isGit: boolean;
  gitRemote: string | null;
} {
  const probe = gitCommand(client, ["-C", workingDir, "rev-parse", "--git-dir"], {
    encoding: "utf8",
    timeout: 1500
  });
  if (probe.status !== 0) return { isGit: false, gitRemote: null };
  const remote = gitCommand(client, ["-C", workingDir, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    timeout: 1500
  });
  const gitRemote = remote.status === 0 ? remote.stdout.trim() || null : null;
  return { isGit: true, gitRemote };
}

export interface GitWorktreeAddOptions {
  newBranch: boolean;
  baseRef?: string | null;
}

export function gitWorktreeAdd(
  repoDir: string,
  worktreePath: string,
  branch: string,
  opts: GitWorktreeAddOptions,
  client: GitClient = DEFAULT_GIT
): void {
  const args = ["-C", repoDir, "worktree", "add"];
  if (opts.newBranch) {
    args.push("-b", branch, worktreePath);
    if (opts.baseRef) args.push(opts.baseRef);
  }
  else args.push(worktreePath, branch);
  const r = gitCommand(client, args, { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) {
    throw new Error(`git worktree add failed: ${commandFailureMessage(r, "unknown")}`);
  }
}

export interface GitWorktreeRemoveOptions {
  force?: boolean;
}

const GIT_WORKTREE_REMOVE_TIMEOUT_MS = 60_000;

export function gitWorktreeRemove(
  worktreePath: string,
  repoDir?: string,
  opts: GitWorktreeRemoveOptions = {},
  client: GitClient = DEFAULT_GIT
): void {
  const removeArgs = opts.force
    ? ["worktree", "remove", "--force"]
    : ["worktree", "remove"];
  // Desktop sidecars do not reliably start with the project repository as cwd,
  // so prefer an explicit main repo when the caller has one.
  const attempts = repoDir
    ? [
        { label: `repo ${repoDir}`, args: ["-C", repoDir, ...removeArgs, worktreePath] },
        { label: `worktree ${worktreePath}`, args: ["-C", worktreePath, ...removeArgs, "."] }
      ]
    : [
        { label: "current directory", args: [...removeArgs, worktreePath] },
        { label: `worktree ${worktreePath}`, args: ["-C", worktreePath, ...removeArgs, "."] }
      ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    const r = gitCommand(client, attempt.args, { encoding: "utf8", timeout: GIT_WORKTREE_REMOVE_TIMEOUT_MS });
    if (r.status === 0) return;
    errors.push(`${attempt.label}: ${commandFailureMessage(r, "unknown")}`);
  }

  throw new Error(`git worktree remove failed: ${errors.join("; ")}`);
}

export interface GitBranchDeleteOptions {
  force?: boolean;
}

export function gitBranchDelete(
  repoDir: string,
  branch: string,
  opts: GitBranchDeleteOptions = {},
  client: GitClient = DEFAULT_GIT
): void {
  const flag = opts.force ? "-D" : "-d";
  const r = gitCommand(
    client,
    ["-C", repoDir, "branch", flag, branch],
    { encoding: "utf8", timeout: 3000 }
  );
  if (r.status !== 0) {
    throw new Error(`git branch ${flag} failed: ${commandFailureMessage(r, "unknown")}`);
  }
}
