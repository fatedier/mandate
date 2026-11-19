import type { WorkerRow } from "../workers/workers-store.js";
import type { ProjectRow } from "../projects/projects-store.js";
import {
  DEFAULT_GIT,
  gitCurrentBranch,
  gitHeadCommit,
  gitLastCommitDay,
  gitRefTips,
  gitRepositoryKind,
  gitSymbolicRef,
  type GitClient
} from "../../platform/git/git.js";

/** A worker archived longer ago than this no longer says where work is. */
const RECENT_MS = 30 * 86_400_000;
/** At most this many branches are listed; the folder always is. */
const MAX_BRANCHES = 10;

interface Place {
  label: string;
  roles: string[];
  day: string | null;
}

/** Where a project's work is on this machine, for a dream run checking its
 *  memories against the project's files: in a git repository, the default
 *  branch, the branches its recent workers start from, those workers' own
 *  branches, and the working directory (where workers without a branch
 *  work; a bare repository has none), each with the day of its last
 *  commit, newest first; otherwise the folder. Only branches are places:
 *  a base recorded as a commit or a tag is a point in time. Nothing is
 *  fetched: refs are as this clone has them. */
export async function whereWorkIs(input: {
  workingDir: string;
  workers: readonly WorkerRow[];
  now: number;
  git?: GitClient;
}): Promise<string> {
  const git = input.git ?? DEFAULT_GIT;
  const dir = input.workingDir;
  const kind = await gitRepositoryKind(dir, git);
  if (!kind) {
    return ["## Where the work is", `- the project's folder: ${dir} (not a git repository: one version only)`].join("\n");
  }
  // Each candidate is the full refs it may be, the first existing one wins.
  const candidates: Array<{ refs: string[]; role: string }> = [];
  const defaultRef = await gitSymbolicRef(dir, "refs/remotes/origin/HEAD", git) ?? (kind === "bare" ? await gitSymbolicRef(dir, "HEAD", git) : null);
  if (defaultRef) candidates.push({ refs: [defaultRef], role: "the default branch" });
  const recent = input.workers.filter((w) => w.archivedAt === null || input.now - Date.parse(w.archivedAt) <= RECENT_MS);
  for (const worker of recent) {
    if (worker.baseRef) candidates.push({ refs: branchRefs(worker.baseRef, "refs/remotes/"), role: "where this project's workers start their branches" });
  }
  for (const worker of recent) {
    if (!worker.branch) continue;
    const state = worker.archivedAt === null ? "active" : `archived ${worker.archivedAt.slice(0, 10)}`;
    candidates.push({ refs: branchRefs(worker.branch, "refs/remotes/origin/"), role: `worker "${worker.name}" (${state})` });
  }
  const tips = await gitRefTips(dir, candidates.flatMap((c) => c.refs), git);
  // By the branch itself, so one written two ways (or through an alias
  // such as origin/HEAD) is one place; an alias to anything else is none.
  const branches = new Map<string, Place>();
  for (const candidate of candidates) {
    const found = candidate.refs.find((r) => tips.has(r));
    if (!found) continue;
    const tip = tips.get(found)!;
    if (!tip.ref.startsWith("refs/heads/") && !tip.ref.startsWith("refs/remotes/")) continue;
    const place = branches.get(tip.ref);
    if (place) {
      if (!place.roles.includes(candidate.role)) place.roles.push(candidate.role);
      continue;
    }
    branches.set(tip.ref, { label: tip.short, roles: [candidate.role], day: tip.day || null });
  }
  const places = [...branches.values()].sort(newestFirst).slice(0, MAX_BRANCHES);
  if (kind === "work-tree") {
    const checkedOut = await gitCurrentBranch(dir, git);
    const at = checkedOut ? `on ${checkedOut}` : `at commit ${(await gitHeadCommit(dir, git) ?? "").slice(0, 8)}`;
    places.push({
      label: `the working directory (${dir}), ${at}`,
      roles: ["workers without a branch work here"],
      day: await gitLastCommitDay(dir, "HEAD", git)
    });
  }
  return [
    "## Where the work is (as it is on this machine; nothing is fetched)",
    "Look at the files in these places with the shell (git show, git grep, git log on the branch); go by the newest.",
    ...places.sort(newestFirst).map((p) => `- ${p.label}: ${p.roles.join("; ")}; ${p.day ? `last commit ${p.day}` : "no commits"}`)
  ].join("\n");
}

/** The full refs a recorded branch name may be: as written when it is a
 *  branch's full ref, else a local branch, else the remote one (`remote`
 *  is where a bare name is looked for). A full ref of anything else — a
 *  tag — is none. */
function branchRefs(name: string, remote: "refs/remotes/" | "refs/remotes/origin/"): string[] {
  if (name.startsWith("refs/")) return name.startsWith("refs/heads/") || name.startsWith("refs/remotes/") ? [name] : [];
  return [`refs/heads/${name}`, `${remote}${name}`];
}

/** For a run of the user's memories, which name things from any project. */
export function projectsFolders(projects: readonly Pick<ProjectRow, "name" | "workingDir">[]): string {
  return ["## The projects' folders", ...projects.map((p) => `- ${p.name}: ${p.workingDir}`)].join("\n");
}

/** The newest first; one with no day last; equals keep their order. */
function newestFirst(a: Place, b: Place): number {
  if (a.day === b.day) return 0;
  if (a.day === null) return 1;
  if (b.day === null) return -1;
  return a.day < b.day ? 1 : -1;
}
