import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GIT, gitCommand, gitHeadCommit, type GitClient } from "./git.js";

export type GitFileStatus = "A" | "M" | "D" | "R";

export interface GitChangedFile {
  path: string;
  oldPath: string | null;
  status: GitFileStatus;
  additions: number | null; // null for binary or uncounted
  deletions: number | null;
  binary: boolean;
  uncommitted: boolean;
  /** true when git does not track the file at all (needs a no-index diff) */
  untracked: boolean;
}

export interface GitDiffSummary {
  mergeBase: string;
  head: string;
  files: GitChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface GitFileDiff {
  patch: string;
  truncated: boolean;
  binary: boolean;
}

const DIFF_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_PATCH_BYTES = 200_000;
/** Bounds untracked-file line counting (in-process reads locally, one wc
 *  batch remotely) so a degenerate set — e.g. a stray node_modules that
 *  slipped past .gitignore — can't dominate a request. Files beyond the cap
 *  are still listed, just with unknown counts. */
export const MAX_COUNTED_UNTRACKED = 200;

export function gitMergeBase(repoDir: string, baseRef: string, client: GitClient = DEFAULT_GIT): string | null {
  const r = gitCommand(client, ["-C", repoDir, "merge-base", baseRef, "HEAD"], {
    encoding: "utf8",
    timeout: DIFF_TIMEOUT_MS
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export function gitDiffSummary(repoDir: string, mergeBase: string, client: GitClient = DEFAULT_GIT): GitDiffSummary | null {
  const head = gitHeadCommit(repoDir, client);
  if (!head) return null;

  // Working-tree form (single ref): committed + staged + unstaged vs merge base.
  const nameStatus = gitCommand(
    client,
    ["-C", repoDir, "diff", "--name-status", "-M", "-z", mergeBase],
    { encoding: "utf8", timeout: DIFF_TIMEOUT_MS }
  );
  const numstat = gitCommand(
    client,
    ["-C", repoDir, "diff", "--numstat", "-M", "-z", mergeBase],
    { encoding: "utf8", timeout: DIFF_TIMEOUT_MS }
  );
  if (nameStatus.status !== 0 || numstat.status !== 0) return null;

  const counts = parseNumstatZ(numstat.stdout);
  const dirty = statusPathSet(repoDir, client);
  const files: GitChangedFile[] = [];

  for (const entry of parseNameStatusZ(nameStatus.stdout)) {
    const count = counts.get(entry.path);
    files.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      additions: count?.binary ? null : count?.additions ?? 0,
      deletions: count?.binary ? null : count?.deletions ?? 0,
      binary: count?.binary ?? false,
      uncommitted: dirty.has(entry.path),
      untracked: false
    });
  }

  // Untracked files are invisible to `git diff <ref>`; list them, then count
  // lines without a subprocess per file (see countUntrackedFiles).
  const untracked = gitCommand(
    client,
    ["-C", repoDir, "ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", timeout: DIFF_TIMEOUT_MS }
  );
  if (untracked.status === 0) {
    const paths = untracked.stdout.split("\0").filter(Boolean);
    const counts = countUntrackedFiles(repoDir, paths.slice(0, MAX_COUNTED_UNTRACKED), client);
    for (const p of paths) {
      const c = counts.get(p) ?? null;
      files.push({
        path: p,
        oldPath: null,
        status: "A",
        additions: c === null || c.binary ? null : c.additions,
        deletions: c === null || c.binary ? null : 0,
        binary: c?.binary ?? false,
        uncommitted: true,
        untracked: true
      });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    mergeBase,
    head,
    files,
    totalAdditions: files.reduce((s, f) => s + (f.additions ?? 0), 0),
    totalDeletions: files.reduce((s, f) => s + (f.deletions ?? 0), 0)
  };
}

export interface GitChangedName {
  path: string;
  oldPath: string | null;
  status: GitFileStatus;
  untracked: boolean;
}

/** Names-only variant of gitDiffSummary for membership checks: two git
 *  invocations total (name-status + ls-files) — no numstat, no worktree
 *  status scan, no per-untracked counting. The per-file patch endpoint
 *  runs this on every fetch, so it must stay cheap: each spawn costs
 *  ~30ms and blocks the event loop. */
export function gitDiffNames(
  repoDir: string,
  mergeBase: string,
  client: GitClient = DEFAULT_GIT
): GitChangedName[] | null {
  const nameStatus = gitCommand(
    client,
    ["-C", repoDir, "diff", "--name-status", "-M", "-z", mergeBase],
    { encoding: "utf8", timeout: DIFF_TIMEOUT_MS }
  );
  if (nameStatus.status !== 0) return null;
  const names: GitChangedName[] = parseNameStatusZ(nameStatus.stdout).map((entry) => ({
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    untracked: false
  }));
  const tracked = new Set(names.map((n) => n.path));
  const untracked = gitCommand(
    client,
    ["-C", repoDir, "ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", timeout: DIFF_TIMEOUT_MS }
  );
  if (untracked.status === 0) {
    for (const p of untracked.stdout.split("\0")) {
      if (!p || tracked.has(p)) continue;
      names.push({ path: p, oldPath: null, status: "A", untracked: true });
    }
  }
  names.sort((a, b) => a.path.localeCompare(b.path));
  return names;
}

export function gitDiffFile(
  repoDir: string,
  mergeBase: string,
  filePath: string,
  opts: { untracked: boolean; maxBytes?: number; oldPath?: string | null },
  client: GitClient = DEFAULT_GIT
): GitFileDiff | null {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_PATCH_BYTES;
  // Renames need both paths in the pathspec: limiting to the new path alone
  // hides the old side, so git renders the file as a full-file addition.
  const args = opts.untracked
    ? ["-C", repoDir, "diff", "--no-index", "--", "/dev/null", filePath]
    : ["-C", repoDir, "diff", "-M", mergeBase, "--", ...(opts.oldPath ? [opts.oldPath] : []), filePath];
  const r = gitCommand(client, args, { encoding: "utf8", timeout: DIFF_TIMEOUT_MS });
  // --no-index exits 1 when the files differ; that is success for our purposes.
  if (r.status !== 0 && !(opts.untracked && r.status === 1)) return null;
  const binary = /^Binary files /m.test(r.stdout);
  const truncated = r.stdout.length > maxBytes;
  return {
    patch: truncated ? r.stdout.slice(0, maxBytes) : r.stdout,
    truncated,
    binary
  };
}

// --- parsing helpers (exported for direct unit testing if needed) ---

interface NameStatusEntry {
  status: GitFileStatus;
  path: string;
  oldPath: string | null;
}

/** -z framing: `<STATUS>\0<path>\0` per entry, except renames/copies:
 *  `R<score>\0<old>\0<new>\0`. */
export function parseNameStatusZ(raw: string): NameStatusEntry[] {
  const tokens = raw.split("\0");
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i] ?? "";
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      if (newPath) out.push({ status: "R", path: newPath, oldPath });
      i += 3;
    } else {
      const p = tokens[i + 1] ?? "";
      const s: GitFileStatus = status.startsWith("A") ? "A" : status.startsWith("D") ? "D" : "M";
      if (p) out.push({ status: s, path: p, oldPath: null });
      i += 2;
    }
  }
  return out;
}

interface NumstatCount {
  additions: number;
  deletions: number;
  binary: boolean;
}

/** -z framing: `<add>\t<del>\t<path>\0` per entry, except renames:
 *  `<add>\t<del>\t\0<old>\0<new>\0` (empty path field signals two-path form).
 *  Binary files report `-\t-`. */
export function parseNumstatZ(raw: string): Map<string, NumstatCount> {
  const tokens = raw.split("\0");
  const out = new Map<string, NumstatCount>();
  let i = 0;
  while (i < tokens.length) {
    const rec = tokens[i] ?? "";
    if (!rec) break;
    const parts = rec.split("\t");
    const addRaw = parts[0] ?? "";
    const delRaw = parts[1] ?? "";
    const inlinePath = parts[2] ?? "";
    const binary = addRaw === "-";
    const count: NumstatCount = {
      additions: binary ? 0 : Number.parseInt(addRaw, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(delRaw, 10) || 0,
      binary
    };
    if (inlinePath) {
      out.set(inlinePath, count);
      i += 1;
    } else {
      const newPath = tokens[i + 2] ?? ""; // tokens[i+1] is old path
      if (newPath) out.set(newPath, count);
      i += 3;
    }
  }
  return out;
}

/** Paths with any staged/unstaged/untracked state. Porcelain v1 -z rename
 *  entries are `XY <new>\0<old>\0`; we only need the new path. */
function statusPathSet(repoDir: string, client: GitClient): Set<string> {
  const r = gitCommand(client, ["-C", repoDir, "status", "--porcelain", "-z"], {
    encoding: "utf8",
    timeout: DIFF_TIMEOUT_MS
  });
  const set = new Set<string>();
  if (r.status !== 0) return set;
  const tokens = r.stdout.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const rec = tokens[i] ?? "";
    if (!rec) break;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (p) set.add(p);
    i += xy.includes("R") || xy.includes("C") ? 2 : 1; // skip old-path token for renames
  }
  return set;
}

const BINARY_SNIFF_BYTES = 8000; // git's own binary heuristic window
const IN_PROCESS_COUNT_BUDGET_BYTES = 50_000_000; // total read budget per summary

/** Count added lines for untracked files. Counting is display-only, so it
 *  must never dominate the request:
 *  - Local (default runner): read the files in-process — zero subprocesses.
 *    Line semantics match git numstat (a final line without a trailing
 *    newline counts); binary = NUL within the first 8000 bytes, like git.
 *  - Custom runner (injected test runners): the runtime cannot read those
 *    files directly, so run ONE batched `wc -l` instead of a spawn per
 *    file. wc undercounts a missing trailing newline by one — an accepted
 *    approximation, since this count is display-only.
 *  Files without a map entry render as additions: null ("count unknown"). */
function countUntrackedFiles(
  repoDir: string,
  paths: string[],
  client: GitClient
): Map<string, NumstatCount> {
  if (paths.length === 0) return new Map();
  return client.runner ? countViaWc(repoDir, paths, client) : countInProcess(repoDir, paths);
}

function countInProcess(repoDir: string, paths: string[]): Map<string, NumstatCount> {
  const out = new Map<string, NumstatCount>();
  let budget = IN_PROCESS_COUNT_BUDGET_BYTES;
  for (const p of paths) {
    try {
      const full = join(repoDir, p);
      const size = statSync(full).size;
      if (size > budget) continue; // oversize / budget exhausted → count unknown
      budget -= size;
      const buf = readFileSync(full);
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        out.set(p, { additions: 0, deletions: 0, binary: true });
        continue;
      }
      out.set(p, { additions: countLines(buf), deletions: 0, binary: false });
    } catch {
      // Vanished mid-scan (agent is working in this tree) → count unknown.
    }
  }
  return out;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let lines = 0;
  for (const byte of buf) if (byte === 10) lines += 1;
  if (buf[buf.length - 1] !== 10) lines += 1;
  return lines;
}

function countViaWc(repoDir: string, paths: string[], client: GitClient): Map<string, NumstatCount> {
  const out = new Map<string, NumstatCount>();
  const runner = client.runner;
  if (!runner) return out;
  const absolute = paths.map((p) => `${repoDir.replace(/\/$/, "")}/${p}`);
  const r = runner.run("wc", ["-l", ...absolute], { encoding: "utf8", timeout: DIFF_TIMEOUT_MS });
  if (r.status !== 0) return out; // any unreadable file misaligns order-based parsing
  const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  // wc prints one line per file in argument order, plus a "total" line when
  // given more than one file. Parse by ORDER, not by path text, so paths
  // containing spaces cannot confuse the mapping.
  const expected = paths.length + (paths.length > 1 ? 1 : 0);
  if (lines.length !== expected) return out;
  for (let i = 0; i < paths.length; i++) {
    const count = Number.parseInt(lines[i] ?? "", 10);
    if (!Number.isFinite(count)) continue;
    out.set(paths[i] ?? "", { additions: count, deletions: 0, binary: false });
  }
  return out;
}
