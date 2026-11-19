import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  commandDidNotAnswer,
  CommandDidNotAnswerError,
  commandFailureMessage,
  nodeCommandRunner,
  type CommandResult,
  type CommandRunner,
  type CommandRunOptions
} from "../process/command-runner.js";

export interface GitClient {
  runner?: CommandRunner;
}

export const DEFAULT_GIT: GitClient = {};

/** git without holding the server's thread while it runs. A command that
 *  meets the lock another git holds on the repository (a commit, a fetch, a
 *  status refreshing the index) is asked again, up to ten more times, a
 *  little later each time (attempt² × 50 ms); one still locked after that answers as git did. */
export async function gitCommand(client: GitClient, args: string[], options?: CommandRunOptions): Promise<CommandResult> {
  const runner = client.runner ?? nodeCommandRunner;
  for (let attempt = 1; ; attempt++) {
    const r = await runner.run("git", args, options);
    if (attempt > LOCK_RETRIES || !repositoryLocked(r)) return r;
    await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 50));
  }
}

const LOCK_RETRIES = 10;

/** git's own words for a lock another git holds. */
function repositoryLocked(r: CommandResult): boolean {
  return r.status !== 0 && typeof r.stderr === "string"
    && /Another git process seems to be running in this repository|If no other git process is currently running/.test(r.stderr);
}

/** What `dir` is to git: inside a work tree, a bare repository (its
 *  branches readable, no files checked out), or neither. An unanswered
 *  probe says neither. */
export async function gitRepositoryKind(dir: string, client: GitClient = DEFAULT_GIT): Promise<"work-tree" | "bare" | null> {
  const r = await gitCommand(client, ["-C", dir, "rev-parse", "--is-bare-repository", "--is-inside-work-tree"], { encoding: "utf8", timeout: 1500 });
  if (r.status !== 0) return null;
  const [bare, inside] = r.stdout.trim().split("\n").map((line) => line.trim());
  if (inside === "true") return "work-tree";
  return bare === "true" ? "bare" : null;
}

/** The full ref a symbolic ref names (`refs/remotes/origin/HEAD` →
 *  `refs/remotes/origin/main`), or null. */
export async function gitSymbolicRef(repoDir: string, name: string, client: GitClient = DEFAULT_GIT): Promise<string | null> {
  const r = await gitCommand(client, ["-C", repoDir, "symbolic-ref", "--quiet", name], { encoding: "utf8", timeout: 1500 });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/** Of these full refs (`refs/heads/…`, `refs/remotes/…`), the ones that
 *  exist, each with the ref it is (itself, or what a symbolic one such as
 *  origin/HEAD points to), that ref's shortest unambiguous name (`heads/x`
 *  when a tag is also called x) and the day of its tip's commit. One git
 *  call; empty when git does not answer. */
export async function gitRefTips(repoDir: string, refs: readonly string[], client: GitClient = DEFAULT_GIT): Promise<Map<string, { ref: string; short: string; day: string }>> {
  const tips = new Map<string, { ref: string; short: string; day: string }>();
  const wanted = new Set(refs.filter((ref) => ref.startsWith("refs/")));
  if (wanted.size === 0) return tips;
  const r = await gitCommand(
    client,
    ["-C", repoDir, "for-each-ref", "--format=%(refname)%00%(refname:short)%00%(committerdate:short)%00%(symref)%00%(symref:short)", ...wanted],
    { encoding: "utf8", timeout: 5000 }
  );
  if (r.status !== 0) return tips;
  for (const line of r.stdout.split("\n")) {
    const [ref, short, day, target, targetShort] = line.split("\0");
    // A pattern also matches the refs under it (refs/heads/dev/x): only exact ones.
    if (ref && short && wanted.has(ref)) tips.set(ref, target ? { ref: target, short: targetShort || target, day: day ?? "" } : { ref, short, day: day ?? "" });
  }
  return tips;
}

/** The day of `ref`'s last commit (YYYY-MM-DD, the committer's), or null. */
export async function gitLastCommitDay(repoDir: string, ref: string, client: GitClient = DEFAULT_GIT): Promise<string | null> {
  // --no-show-signature: log.showSignature would print a signed commit's check first.
  const r = await gitCommand(client, ["-C", repoDir, "log", "-1", "--no-show-signature", "--format=%cs", "--end-of-options", ref, "--"], { encoding: "utf8", timeout: 1500 });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export async function gitBranchExists(repoDir: string, name: string, client: GitClient = DEFAULT_GIT): Promise<boolean> {
  const r = await gitCommand(
    client,
    ["-C", repoDir, "show-ref", "--verify", `refs/heads/${name}`],
    { encoding: "utf8", timeout: 1500 }
  );
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("git show-ref");
  return r.status === 0;
}

/** One reflog entry: the commit it points at, when (whole seconds), and
 *  what wrote it ("checkout: moving from a to b", "branch: Created from …"). */
export interface ReflogEntry { commit: string; at: string; subject: string }

async function reflogOf(dir: string, ref: string, client: GitClient): Promise<ReflogEntry[]> {
  const r = await gitCommand(
    client,
    ["-C", dir, "reflog", "show", "--date=unix", "--format=%H%x09%gd%x09%gs", ref, "--"],
    { encoding: "utf8", timeout: 3000 }
  );
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  return r.stdout.split("\n").flatMap((line) => {
    const [commit, selector, ...subject] = line.split("\t");
    const at = /@\{(\d+)\}$/.exec(selector ?? "")?.[1];
    return commit && at ? [{ commit, at, subject: subject.join("\t") }] : [];
  });
}

/** A branch made in a worktree, with its reflog as it was read then
 *  (newest first), to check again before a delete. */
export interface WorktreeBranch { name: string; reflog: ReflogEntry[] }

/** Whether this folder is the root of a linked worktree (`git worktree
 *  add`), not a main checkout nor a folder inside one: only then is the HEAD
 *  record read there that worktree's own. */
async function isLinkedWorktreeRoot(dir: string, client: GitClient): Promise<boolean> {
  const r = await gitCommand(client, ["-C", dir, "rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], {
    encoding: "utf8",
    timeout: 3000
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return false;
  const [top, gitDir, common] = r.stdout.replace(/\r?\n$/, "").split("\n");
  if (!top || !gitDir || !common) return false;
  try {
    const real = (p: string) => realpathSync(path.resolve(dir, p));
    return real(gitDir) !== real(common) && real(top) === realpathSync(dir);
  } catch {
    return false;
  }
}

/** Reflog entries older than this (unix seconds) an ordinary `git gc` may
 *  already have cleared: the latest of the 30 days git clears unreachable
 *  entries after by default and every expiry set for this repository, as
 *  each of its worktrees reads its settings (a worktree can have its own, and
 *  a gc there clears the shared branch reflogs too). Each is read through
 *  git's own folder for that worktree ($GIT_COMMON_DIR/worktrees/<id>), as a
 *  gc there reads it: a worktree moved with a plain `mv` keeps that folder,
 *  though git lists it at its old path. Null when git cannot say. */
async function reflogClearedBefore(dir: string, client: GitClient): Promise<number | null> {
  let common: string | null;
  try {
    common = await gitCommonDir(dir, client);
  } catch {
    return null;
  }
  if (!common) return null;
  let gitDirs = [common];
  try {
    const own = path.join(common, "worktrees");
    gitDirs = gitDirs.concat(readdirSync(own).map((id) => path.join(own, id)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; // none made yet is fine
  }
  let cutoff = Math.floor(Date.now() / 1000) - 30 * 86_400;
  for (const gitDir of gitDirs) {
    const r = await gitCommand(
      client,
      ["--git-dir", gitDir, "config", "--type=expiry-date", "--get-regexp", "^gc\\.(.+\\.)?reflogexpire(unreachable)?$"],
      { encoding: "utf8", timeout: 3000 }
    );
    if (r.status === 1 && !r.stdout) continue; // none set
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const at = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (!Number.isFinite(at)) return null;
      cutoff = Math.max(cutoff, at);
    }
  }
  return cutoff;
}

/** Whether the disk keeps another branch in this one's files: names it
 *  takes for one (letter case, ẞ and ss on macOS) share one ref file and
 *  one reflog, so deleting one deletes the other. Asked of the disk itself,
 *  by comparing files; unsure counts as shared. */
async function sharesFiles(dir: string, name: string, others: string[], client: GitClient): Promise<boolean> {
  const r = await gitCommand(client, ["-C", dir, "rev-parse", "--git-path", "refs/heads", "--git-path", "logs/refs/heads"], {
    encoding: "utf8",
    timeout: 3000
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return true;
  const roots = r.stdout.replace(/\r?\n$/, "").split("\n").map((root) => path.resolve(dir, root));
  if (roots.length !== 2) return true;
  const fileOf = (file: string) => {
    try {
      const stat = statSync(file);
      return stat.isFile() ? `${stat.dev}:${stat.ino}` : null;
    } catch {
      return null;
    }
  };
  const filesOf = (branch: string) => roots.map((root) => fileOf(path.join(root, branch))).filter((file) => file !== null);
  const own = new Set(filesOf(name));
  return others.some((other) => other !== name && filesOf(other).some((file) => own.has(file)));
}

/** This branch's reflog (newest first), when it shows plainly where the
 *  branch came from: the oldest entry says "Created from", no rename or copy
 *  carried another branch's history in, and the disk keeps no other branch
 *  in its files. */
async function plainReflogOf(dir: string, name: string, client: GitClient): Promise<ReflogEntry[] | null> {
  const refs = await gitCommand(client, ["-C", dir, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"], {
    encoding: "utf8",
    timeout: 3000
  });
  if (refs.status !== 0 || typeof refs.stdout !== "string") return null;
  const names = refs.stdout.split("\n").filter(Boolean);
  if (!names.includes(name) || await sharesFiles(dir, name, names, client)) return null;
  const entries = await reflogOf(dir, `refs/heads/${name}`, client);
  if (entries.some((entry) => /^Branch: (renamed|copied) /.test(entry.subject))) return null;
  return entries.at(-1)?.subject.startsWith("branch: Created from ") ? entries : null;
}

/**
 * The branches made inside this worktree, by git's own records only: a
 * branch counts when its first reflog entry ("branch: Created from …") and a
 * checkout of this worktree onto it are one moment, the same second and the
 * same commit — what `git checkout -b` and `git switch -c` write together —
 * it was made after the worktree's own first moment, and every later entry
 * of its reflog was written by this worktree too (git writes a commit, an
 * amend, a rebase or a reset into both records at once). A branch made
 * anywhere else and checked out here does not count, nor one changed from
 * anywhere else (a reset, a copy put over it), nor the branch the worktree
 * was made on. A gc can clear such a change's entry (with an entry's earlier
 * commit gone, git drops it), so only a branch made since gc could last have
 * cleared anything counts. Unsure is not counted: missing one is fine,
 * naming one that was not made here is not.
 */
export async function gitBranchesCreatedInWorktree(worktreePath: string, client: GitClient = DEFAULT_GIT): Promise<WorktreeBranch[]> {
  if (!await isLinkedWorktreeRoot(worktreePath, client)) return [];
  const clearedBefore = await reflogClearedBefore(worktreePath, client);
  if (clearedBefore === null) return [];
  const head = await reflogOf(worktreePath, "HEAD", client);
  const started = head.at(-1)?.at;
  if (started === undefined) return [];
  const checkouts = head.flatMap((entry) => {
    const to = /^checkout: moving from \S+ to (\S+)$/.exec(entry.subject)?.[1];
    return to ? [{ ...entry, to }] : [];
  });
  const writtenHere = (entry: ReflogEntry) => head.some((own) => own.at === entry.at && own.commit === entry.commit);
  const made: WorktreeBranch[] = [];
  for (const name of new Set(checkouts.map((c) => c.to))) {
    const reflog = await plainReflogOf(worktreePath, name, client);
    const first = reflog?.at(-1);
    // Made before gc could have cleared an entry (a rename, a copy, a change
    // from elsewhere): not sure.
    if (!reflog || !first || Number(first.at) <= Number(started) || Number(first.at) <= clearedBefore) continue;
    if (!checkouts.some((c) => c.to === name && c.at === first.at && c.commit === first.commit)) continue;
    if (reflog.every(writtenHere)) made.push({ name, reflog });
  }
  return made;
}

/** Whether the branch under this name is still the one found made in the
 *  worktree: its reflog is still exactly as it was read then, and still made
 *  after anything gc may have cleared by now. */
export async function gitBranchIsStill(repoDir: string, branch: WorktreeBranch, client: GitClient = DEFAULT_GIT): Promise<boolean> {
  const reflog = await plainReflogOf(repoDir, branch.name, client);
  const clearedBefore = await reflogClearedBefore(repoDir, client);
  if (reflog === null || clearedBefore === null || Number(reflog.at(-1)!.at) <= clearedBefore) return false;
  const lines = (entries: ReflogEntry[]) => entries.map((entry) => `${entry.commit} ${entry.at} ${entry.subject}`).join("\n");
  return lines(reflog) === lines(branch.reflog);
}

export async function gitCurrentBranch(repoDir: string, client: GitClient = DEFAULT_GIT): Promise<string | null> {
  const r = await gitCommand(client, ["-C", repoDir, "branch", "--show-current"], {
    encoding: "utf8",
    timeout: 1500
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export async function gitOriginHeadRef(repoDir: string, client: GitClient = DEFAULT_GIT): Promise<string | null> {
  const r = await gitCommand(client, ["-C", repoDir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    encoding: "utf8",
    timeout: 1500
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export async function gitHeadCommit(repoDir: string, client: GitClient = DEFAULT_GIT): Promise<string | null> {
  const r = await gitCommand(client, ["-C", repoDir, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", timeout: 1500 });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * What this branch was last rebased onto, as the ref the rebase was given.
 *
 * `base_ref` is recorded when Mandate creates the worker and never again, so a
 * rebase performed by an agent in a shell leaves it pointing at the old fork.
 * The old ref usually stays an ancestor, so `merge-base` still resolves — just
 * far behind the real one, and the diff then lists far more
 * changed files than the work touched.
 *
 * git already recorded the answer. `rebase (start): checkout <ref>` in HEAD's
 * reflog holds the ref verbatim, so this reads an intention rather than
 * guessing one from topology.
 *
 * Null when there is nothing to say — no rebase, no reflog, or a message this
 * does not recognise. **Callers keep their recorded base in that case**, which
 * is what makes an unparsed message harmless rather than destructive.
 *
 * Bounded by reflog expiry (90 days by default) and local to this clone. Both
 * are acceptable here: Mandate owns these worktrees, and a worker rarely
 * lives that long.
 */
export async function gitLastRebaseTarget(repoDir: string, client: GitClient = DEFAULT_GIT): Promise<string | null> {
  const r = await gitCommand(client, ["-C", repoDir, "reflog", "show", "--no-abbrev", "HEAD"], {
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

/** The base a new branch starts from when none is named: the remote's
 *  default branch, not whatever the project's checkout is on. A repository
 *  with no remote default (or one naming a branch since pruned) falls back to
 *  its checkout's branch, then commit. */
export async function gitResolveDefaultBaseRef(repoDir: string, client: GitClient = DEFAULT_GIT): Promise<string | null> {
  const remoteDefault = await gitOriginHeadRef(repoDir, client);
  if (remoteDefault && await gitRefExists(repoDir, remoteDefault, client)) return remoteDefault;
  return await gitCurrentBranch(repoDir, client) ?? await gitHeadCommit(repoDir, client);
}

export async function gitRefExists(repoDir: string, ref: string, client: GitClient = DEFAULT_GIT): Promise<boolean> {
  const r = await gitCommand(client, ["-C", repoDir, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
    timeout: 1500
  });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("git rev-parse");
  return r.status === 0;
}

export async function gitDetectRepository(workingDir: string, client: GitClient = DEFAULT_GIT): Promise<{
  isGit: boolean;
  gitRemote: string | null;
}> {
  const probe = await gitCommand(client, ["-C", workingDir, "rev-parse", "--git-dir"], {
    encoding: "utf8",
    timeout: 1500
  });
  // Recorded on the project row for good: an unanswered probe must not become "not a repository".
  if (commandDidNotAnswer(probe)) throw new CommandDidNotAnswerError("git rev-parse");
  if (probe.status !== 0) return { isGit: false, gitRemote: null };
  const remote = await gitCommand(client, ["-C", workingDir, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    timeout: 1500
  });
  if (commandDidNotAnswer(remote)) throw new CommandDidNotAnswerError("git config");
  const gitRemote = remote.status === 0 ? remote.stdout.trim() || null : null;
  return { isGit: true, gitRemote };
}

/** The repository a checkout belongs to: its common git directory, absolute.
 *  Every worktree of one repository answers the same; null for none. */
export async function gitCommonDir(dir: string, client: GitClient = DEFAULT_GIT): Promise<string | null> {
  // Without --path-format (git 2.31+): an older git prints it back as output.
  const r = await gitCommand(client, ["-C", dir, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    timeout: 1500
  });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("git rev-parse");
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  // Only git's own line end: a directory's name may end in a space.
  const common = r.stdout.replace(/\r?\n$/, "");
  if (!common) return null;
  const absolute = path.resolve(dir, common);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** The worktrees a repository lists as its own, by path, its main one
 *  first: after the repository moved, still the ones it made. -z: a path may
 *  hold a line break, never a NUL. */
export async function gitWorktreePaths(repoDir: string, client: GitClient = DEFAULT_GIT): Promise<string[]> {
  const r = await gitCommand(client, ["-C", repoDir, "worktree", "list", "--porcelain", "-z"], {
    encoding: "utf8",
    timeout: 1500
  });
  if (commandDidNotAnswer(r)) throw new CommandDidNotAnswerError("git worktree list");
  if (r.status !== 0) return [];
  return r.stdout.split("\0").flatMap((field) => (field.startsWith("worktree ") ? [field.slice("worktree ".length)] : []));
}

/** Links worktrees to their repository again after it moved on disk, as far
 *  as git gets: one it cannot link, or does not reach in time, stays as the
 *  move left it. */
export async function gitWorktreeRepair(repoDir: string, worktreePaths: readonly string[], client: GitClient = DEFAULT_GIT): Promise<void> {
  await gitCommand(client, ["-C", repoDir, "worktree", "repair", ...worktreePaths], {
    encoding: "utf8",
    timeout: 15_000
  });
}

interface GitWorktreeAddOptions {
  newBranch: boolean;
  baseRef?: string | null;
}

export async function gitWorktreeAdd(
  repoDir: string,
  worktreePath: string,
  branch: string,
  opts: GitWorktreeAddOptions,
  client: GitClient = DEFAULT_GIT
): Promise<void> {
  const args = ["-C", repoDir, "worktree", "add"];
  if (opts.newBranch) {
    args.push("-b", branch, worktreePath);
    if (opts.baseRef) args.push(opts.baseRef);
  }
  else args.push(worktreePath, branch);
  const r = await gitCommand(client, args, { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) {
    throw new Error(`git worktree add failed: ${commandFailureMessage(r, "unknown")}`);
  }
}

interface GitWorktreeRemoveOptions {
  force?: boolean;
}

const GIT_WORKTREE_REMOVE_TIMEOUT_MS = 60_000;

export async function gitWorktreeRemove(
  worktreePath: string,
  repoDir?: string,
  opts: GitWorktreeRemoveOptions = {},
  client: GitClient = DEFAULT_GIT
): Promise<void> {
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
    const r = await gitCommand(client, attempt.args, { encoding: "utf8", timeout: GIT_WORKTREE_REMOVE_TIMEOUT_MS });
    if (r.status === 0) return;
    errors.push(`${attempt.label}: ${commandFailureMessage(r, "unknown")}`);
  }

  throw new Error(`git worktree remove failed: ${errors.join("; ")}`);
}

interface GitBranchDeleteOptions {
  force?: boolean;
}

export async function gitBranchDelete(
  repoDir: string,
  branch: string,
  opts: GitBranchDeleteOptions = {},
  client: GitClient = DEFAULT_GIT
): Promise<void> {
  const flag = opts.force ? "-D" : "-d";
  const r = await gitCommand(
    client,
    ["-C", repoDir, "branch", flag, branch],
    { encoding: "utf8", timeout: 3000 }
  );
  if (r.status !== 0) {
    throw new Error(`git branch ${flag} failed: ${commandFailureMessage(r, "unknown")}`);
  }
}
