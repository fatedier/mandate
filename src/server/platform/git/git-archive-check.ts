import {
  DEFAULT_GIT,
  gitCommand,
  gitLastRebaseTarget,
  gitOriginHeadRef,
  gitRefExists,
  gitResolveDefaultBaseRef,
  type GitClient
} from "./git.js";
import type { ArchiveCheckDto } from "../../../shared/api/features.js";

const TIMEOUT_MS = 15_000;

/** The base a feature's branch is measured against — the same one the
 *  Changes tab uses: what git last rebased it onto, else the ref it was
 *  created from, else the project's default. */
export function resolveFeatureBaseRef(
  input: { repoDir: string; workingDir: string; baseRefHint: string | null },
  client: GitClient = DEFAULT_GIT
): string | null {
  const rebasedOnto = gitLastRebaseTarget(input.repoDir, client);
  if (rebasedOnto && gitRefExists(input.repoDir, rebasedOnto, client)) return rebasedOnto;
  return input.baseRefHint ?? gitResolveDefaultBaseRef(input.workingDir, client);
}

function git(client: GitClient, repoDir: string, args: string[]) {
  return gitCommand(client, ["-C", repoDir, ...args], { encoding: "utf8", timeout: TIMEOUT_MS });
}

/**
 * What archiving this worker would lose. Only a worker
 * with its own worktree is checked for uncommitted files, and only one with a
 * branch for unmerged work. A branch counts as merged when its tip is in the
 * base, or when every file it changed since the merge base already matches the
 * base — the second test is what lets squash and rebase merges through. No
 * fetch: a stale base only costs one extra question.
 */
export function gitArchiveCheck(
  input: { worktreePath: string | null; repoDir: string; workingDir: string; branch: string | null; baseRefHint: string | null },
  client: GitClient = DEFAULT_GIT
): ArchiveCheckDto {
  const findings: string[] = [];
  let dirtyFiles: number | null = null;
  if (input.worktreePath) {
    // Untracked files count whatever status.showUntrackedFiles says. Ignored
    // files are not asked about:
    // removing the worktree takes them, as archiving always has. -z: paths
    // come unquoted, NUL-separated. Submodules count whatever their ignore
    // setting says.
    const r = git(client, input.worktreePath, [
      "status", "--porcelain", "-z", "--untracked-files=normal", "--ignore-submodules=none"
    ]);
    if (r.status !== 0) findings.push("Could not read the worktree's status.");
    else {
      dirtyFiles = porcelainEntries(r.stdout).length;
      if (dirtyFiles > 0) findings.push(`${dirtyFiles} uncommitted file${dirtyFiles === 1 ? "" : "s"} in the worktree.`);
    }
  }

  let unmergedCommits: number | null = null;
  let baseRef: string | null = null;
  if (input.branch) {
    baseRef = resolveFeatureBaseRef({ repoDir: input.repoDir, workingDir: input.workingDir, baseRefHint: input.baseRefHint }, client);
    // A base relative to HEAD ("HEAD", "@", "HEAD~1") was the project's
    // checkout when the worker was made; read in the worktree, HEAD is the
    // branch itself and every commit would look merged.
    if (baseRef && /^(HEAD|@)/.test(baseRef)) baseRef = resolveInCheckout(client, input.workingDir, baseRef);
    // A base that is the branch itself proves nothing: a rebase a shared
    // checkout remembers onto it, or, with no remote default, the default
    // for a checkout attached as a worker (its current branch). Try the
    // remote's default; failing that, ask.
    if (baseRef === input.branch) baseRef = gitOriginHeadRef(input.workingDir, client);
    if (baseRef === input.branch) baseRef = null;
    if (!baseRef) findings.push(`Could not tell which branch "${input.branch}" merges into.`);
    else {
      const count = git(client, input.repoDir, ["rev-list", "--count", `${baseRef}..${input.branch}`]);
      const ahead = count.status === 0 ? Number.parseInt(count.stdout.trim(), 10) : Number.NaN;
      if (!Number.isFinite(ahead)) findings.push(`Could not compare "${input.branch}" with ${baseRef}.`);
      else if (ahead === 0 || contentInBase(client, input.repoDir, baseRef, input.branch)) unmergedCommits = 0;
      else {
        unmergedCommits = ahead;
        findings.push(`Branch "${input.branch}" has ${ahead} commit${ahead === 1 ? "" : "s"} not in ${baseRef}.`);
      }
    }
  }
  return { dirtyFiles, unmergedCommits, branch: input.branch, baseRef, findings };
}

/** A HEAD-relative ref as the project's checkout reads it: its branch when it
 *  names one, else the commit; null when it does not resolve. */
function resolveInCheckout(client: GitClient, workingDir: string, ref: string): string | null {
  const name = git(client, workingDir, ["rev-parse", "--abbrev-ref", ref]);
  const branch = name.status === 0 ? name.stdout.trim() : "";
  if (branch && !/^(HEAD|@)/.test(branch)) return branch;
  const commit = git(client, workingDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return commit.status === 0 ? commit.stdout.trim() || null : null;
}

/** `git status --porcelain -z` entries. A rename or copy is followed by its
 *  source path as an entry of its own, which is skipped. */
function porcelainEntries(stdout: string): Array<{ code: string; path: string }> {
  const fields = stdout.split("\0");
  const entries: Array<{ code: string; path: string }> = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    if (code.includes("R") || code.includes("C")) i++;
  }
  return entries;
}

function contentInBase(client: GitClient, repoDir: string, baseRef: string, branch: string): boolean {
  const mb = git(client, repoDir, ["merge-base", baseRef, branch]);
  if (mb.status !== 0) return false;
  // No rename detection: a rename must list its old path too, or a base that
  // gained the new path but kept the old one would pass.
  // Submodule commits count whatever diff.ignoreSubmodules says.
  const changed = git(client, repoDir, ["diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", mb.stdout.trim(), branch]);
  if (changed.status !== 0) return false;
  const paths = changed.stdout.split("\0").filter((p) => p.length > 0);
  if (paths.length === 0) return true;
  const same = git(client, repoDir, ["diff", "--quiet", "--ignore-submodules=none", baseRef, branch, "--", ...paths.map((p) => `:(literal)${p}`)]);
  return same.status === 0;
}
