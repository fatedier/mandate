import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../../config.js";
import { resolveDataDir } from "../../platform/fs/data-dir.js";
import { personalAgentDir, managerResourcesDir } from "../../platform/fs/resources.js";
import { logError } from "../../platform/logger.js";
import { checkReadOnlyBash } from "../../platform/shell/read-only-command.js";
import type { AgentStore } from "../agent/agent-store.js";
import { allowedWriteRoots, isInsideAny, primaryWorkspaceRoot, type AgentScope } from "../agent/tool-scope.js";
import type { ToolCallReview, ToolCallSpec } from "../agent/wake-loop.js";
import { resolveArchiveWorkerCleanup } from "../workers/worker-service.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { HandoffStore } from "../personal/handoff-store.js";
import type { JudgementCandidate } from "../manager-checks/judge.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { buildReviewContext, type HeldCall } from "./context.js";
import { REVIEW_UNAVAILABLE, reviewCalls, type ReviewedCall } from "./reviewer.js";
import type { ToolReviewStreaks } from "./streak-store.js";

/**
 * The tool-call review's gate: which of a step's calls are reviewed, and
 * the review of them, before the wake loop runs the step. What is reviewed
 * follows what each tool can do: bash unless the fast path recognises the
 * line, keys typed into a pane, a monitor's command, a write outside the
 * scope's own roots or to a file something runs, and an archive that
 * deletes a worktree, a branch or a tmux session. The rest is not.
 */
export type ReviewKind = { kind: "skip" } | { kind: "review"; fastPath?: string };

export interface ReviewKindDeps {
  /** The thread's own scope ("subagent": its conversation's scope is given). */
  thread: "personal" | "manager" | "worker" | "subagent";
  registeredRepos: readonly string[];
  workers: WorkersStore;
  home?: string;
  dataDir?: string;
  /** The scratch roots every scope may write in (tests give their own). */
  scratch?: readonly string[];
}

/** What the agent reads in place of a held call's result. */
export function heldText(reason: string): string {
  return `Held back by the tool-call review; this is not a failure. ${reason} Go on with the work this does not touch. If this step is needed, get the user's word for exactly this step the way your instructions say, then try again. Do not reach the same effect another way.`;
}

export async function reviewKind(call: ToolCallSpec, scope: AgentScope, deps: ReviewKindDeps): Promise<ReviewKind> {
  const args = isObject(call.args) ? call.args : {};
  switch (call.toolName) {
    case "bash": {
      if (typeof args.command !== "string") return { kind: "review" };
      // As the handler takes it: an explicit cwd against the server's own
      // working directory, else the scope's workspace.
      const cwd = typeof args.cwd === "string" ? path.resolve(args.cwd) : primaryWorkspaceRoot(scope);
      // Mandate's own settings hold provider keys: a line that reads them is reviewed.
      const data = deps.dataDir ?? resolveDataDir();
      const verdict = await checkReadOnlyBash(args.command, {
        cwd, registeredRepos: deps.registeredRepos, secretFiles: [path.join(data, "config.json"), path.join(data, "auth.json")]
      });
      return verdict.skip ? { kind: "skip" } : { kind: "review", fastPath: verdict.reason };
    }
    case "send_keys":
      return { kind: "review" };
    case "monitor":
      return args.command === undefined || args.command === null ? { kind: "skip" } : { kind: "review" };
    // A schedule's check runs on its own later, unattended: as a monitor's
    // command, it is reviewed when it is written (create, update). Running a
    // saved check again (run_now, a reset) runs what was reviewed then.
    case "manage_schedule":
      return typeof args.check === "string" && args.check.trim() !== "" ? { kind: "review" } : { kind: "skip" };
    case "write":
    case "edit": {
      if (typeof args.path !== "string") return { kind: "review" };
      // Judged both as written and where it lands (a link to .git, say).
      const target = path.resolve(args.path);
      const landed = landsAt(target);
      // A link whose destination is missing lands where the write would create it: not known here.
      if (landed === null) return { kind: "review" };
      const roots = allowedWriteRoots(scope, { projects: deps.thread !== "personal", ...(deps.scratch ? { scratch: deps.scratch } : {}) });
      const inside = isInsideAny(target, roots) && isInsideAny(landed, roots.map((root) => landsAt(root) ?? root));
      const worktrees = deps.workers.listAllActive().flatMap((worker) => (worker.worktreePath ? [worker.worktreePath] : []));
      const data = deps.dataDir ?? resolveDataDir();
      const agentFolders = [personalAgentDir(data), managerResourcesDir(data)];
      const seen = { ...deps, registeredRepos: [...deps.registeredRepos, ...scopeFolders(scope), ...agentFolders, ...worktrees] };
      // The folders a path is read inside of: a worktree that lives under a
      // `.claude` folder is a place to work, its own `.claude` is not.
      const homes = [...roots, ...seen.registeredRepos];
      return inside && !executedFile(target, seen, homes) && !executedFile(landed, seen, homes) ? { kind: "skip" } : { kind: "review" };
    }
    case "archive_worker": {
      const worker = typeof args.workerId === "string" ? deps.workers.getById(args.workerId) : null;
      if (!worker) return { kind: "skip" };
      const cleanup = resolveArchiveWorkerCleanup(worker, { cleanup: args });
      const deletes = cleanup.removeWorktree || cleanup.deleteBranch || cleanup.forceRemoveWorktree || cleanup.forceDeleteBranch;
      return deletes ? { kind: "review" } : { kind: "skip" };
    }
    case "archive_thread": {
      // A thread is archived with its workers, each with its default cleanup.
      const owned = typeof args.threadId === "string" ? deps.workers.listActiveOwnedBy(args.threadId) : [];
      const deletes = owned.some((worker) => {
        const cleanup = resolveArchiveWorkerCleanup(worker, {});
        return cleanup.removeWorktree || cleanup.deleteBranch;
      });
      return deletes ? { kind: "review" } : { kind: "skip" };
    }
    case "archive_project":
      return args.killTmux === true ? { kind: "review" } : { kind: "skip" };
    default:
      return { kind: "skip" };
  }
}

/** A file something runs or reads as settings: git's config and hooks, the
 *  shell's start-up files and the snapshot of them Mandate sources before
 *  every command, the agent CLIs' settings, Mandate's own database, settings
 *  and skills. A write to one is reviewed wherever it is. Compared in any
 *  case: macOS's file system ignores it. */
function executedFile(target: string, deps: ReviewKindDeps, homes: readonly string[] = []): boolean {
  const lower = (p: string) => p.toLowerCase();
  const file = lower(target);
  // Named folders and files are read below the innermost folder the path is
  // in (as given and as it lands), so the folders around it do not count.
  const within = (() => {
    let inner = "";
    for (const home of homes.flatMap((h) => [path.resolve(h), landsAt(path.resolve(h)) ?? path.resolve(h)]).map(lower)) {
      if ((file === home || file.startsWith(home + "/")) && home.length > inner.length) inner = home;
    }
    return inner ? file.slice(inner.length) : file;
  })();
  if (/(^|\/)\.git\/(.*\/)?(config|config\.worktree)$|(^|\/)\.git\/(.*\/)?hooks\//.test(within)) return true;
  if (/(^|\/)config\.worktree$/.test(within)) return true;
  if (/(^|\/)\.(claude|codex)\//.test(within)) return true;
  // A `.git` file points a checkout's git at another folder of metadata.
  if (/(^|\/)\.git$/.test(within)) return true;
  // A protected folder covers what is in it, except a working folder that
  // lives inside it (a worktree in a project's `.claude`), whose own named
  // folders are read above.
  const folders = homes.flatMap((h) => [path.resolve(h), landsAt(path.resolve(h)) ?? path.resolve(h)]).map(lower);
  const covers = (dir: string) => isInsideAny(file, [dir]) && !folders.some((home) => home.startsWith(dir + "/") && isInsideAny(file, [home]));
  // Home and Mandate's data by the names given and by their real paths.
  const named = (p: string) => [...new Set([path.resolve(p), landsAt(path.resolve(p)) ?? path.resolve(p)].map(lower))];
  for (const home of named(deps.home ?? os.homedir())) {
    if (file === path.join(home, ".gitconfig") || covers(path.join(home, ".config", "git"))) return true;
    if (path.dirname(file) === home && SHELL_START_UP.has(path.basename(file))) return true;
  }
  for (const data of named(deps.dataDir ?? resolveDataDir())) {
    if (path.dirname(file) === data && /^(mandate\.db.*|config\.json)$/.test(path.basename(file))) return true;
    if (covers(path.join(data, "skills")) || covers(path.join(data, "shell-snapshots"))) return true;
  }
  // A protected entry that is itself a link protects where it leads.
  const entries = protectedEntries(deps);
  return entries.files.includes(file) || entries.dirs.some(covers);
}

/** The protected entries that exist, by where they lead: the home's
 *  start-up files, git config and agent CLI settings, Mandate's database,
 *  settings, skills and shell snapshots, and each registered repository's
 *  git config and hooks and agent CLI settings; inside a protected folder,
 *  each link too. */
function protectedEntries(deps: ReviewKindDeps): { files: string[]; dirs: string[] } {
  const home = path.resolve(deps.home ?? os.homedir());
  const data = path.resolve(deps.dataDir ?? resolveDataDir());
  // Each repository once: a worker's project comes both registered and as
  // its scope's folder, and every folder's links are resolved one by one.
  const repos = [...new Set(deps.registeredRepos)];
  const files = [...SHELL_START_UP].map((name) => path.join(home, name))
    .concat(path.join(home, ".gitconfig"), path.join(data, "config.json"), path.join(data, "mandate.db"))
    .concat(repos.flatMap((repo) => [path.join(repo, ".git", "config"), path.join(repo, ".git", "config.worktree")]));
  const folders = [path.join(home, ".config", "git"), path.join(home, ".claude"), path.join(home, ".codex"), path.join(data, "skills"), path.join(data, "shell-snapshots")]
    .concat(repos.flatMap((repo) => [path.join(repo, ".git", "hooks"), path.join(repo, ".claude"), path.join(repo, ".codex")]));
  // The links inside a protected folder lead to what the folder protects.
  const dirs = [...folders, ...folders.flatMap((folder) => linksIn(folder))];
  const real = (entry: string) => {
    try {
      return fs.realpathSync.native(entry).toLowerCase();
    } catch {
      // A link to what does not exist yet: it protects the place it names.
      try {
        if (!fs.lstatSync(entry).isSymbolicLink()) return null;
        return landsAt(path.resolve(path.dirname(entry), fs.readlinkSync(entry)))?.toLowerCase() ?? null;
      } catch {
        return null;
      }
    }
  };
  return {
    files: files.map(real).filter((entry): entry is string => entry !== null),
    dirs: dirs.map(real).filter((entry): entry is string => entry !== null)
  };
}

/** Where a path lands on disk: its nearest existing ancestor's real path,
 *  with the rest as written (a new file under a link lands past the link).
 *  Null when a link on the way leads nowhere yet: its destination decides. */
function landsAt(target: string): string | null {
  const rest: string[] = [];
  for (let dir = target; ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest);
    } catch {
      try {
        if (fs.lstatSync(dir).isSymbolicLink()) return null;
      } catch {
        // Not there at all: look one level up.
      }
      if (path.dirname(dir) === dir) return target;
      rest.unshift(path.basename(dir));
    }
  }
}

/** The scope's own folders, searched for protected entries as a registered
 *  repository is: a manager's or the personal agent's directory, a worker's
 *  checkouts. Every active worker's worktree, the personal agent's and the
 *  managers' directories are searched too, whoever writes. */
function scopeFolders(scope: AgentScope): string[] {
  return scope.kind === "worker"
    ? [scope.project.workingDir, ...(scope.worker.workingDir ? [scope.worker.workingDir] : [])]
    : [scope.managerDir, ...scope.projectWorkingDirs];
}

/** Every link in a folder and in the folders directly inside it (a
 *  skill's or a command's folder): each listing is read whole, by the
 *  types it gives, so a large one is still cheap. Deeper links are the
 *  file system's layout, not followed. */
function linksIn(folder: string, depth = 2): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const links: string[] = [];
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) links.push(full);
    else if (entry.isDirectory() && depth > 1) links.push(...linksIn(full, depth - 1));
  }
  return links;
}

const SHELL_START_UP = new Set([".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bash_logout"]);

const CHANGES_SCOPES = /^(create|restore|archive)_(worker|project|thread)$/;

/** A write that makes or changes what git takes for a repository: one
 *  whose path, as given or where it lands, has a `.git`, or a bare one's
 *  HEAD, objects or refs, anywhere in it (the folders it creates on the way
 *  count too). */
function writesRepositoryMarker(call: ToolCallSpec): boolean {
  if (call.toolName !== "write" && call.toolName !== "edit") return false;
  if (!isObject(call.args) || typeof call.args.path !== "string") return false;
  const target = path.resolve(call.args.path);
  return [target, landsAt(target) ?? target].some((p) => p.toLowerCase().split("/").some((segment) => REPOSITORY_MARKERS.has(segment)));
}

const REPOSITORY_MARKERS = new Set([".git", "head", "objects", "refs"]);
/** The calls judged by scopes, repositories or cleanups a change could move. */
const STATE_DEPENDENT = new Set(["bash", "write", "edit", "archive_worker", "archive_thread", "archive_project"]);

/** How many holds a thread keeps for the next review's context. */
const HOLDS_KEPT = 10;

export interface ToolReviewGateDeps {
  config: () => Config;
  /** Whether the review has a second look to run on (toolReviewAvailable). */
  available: (config: Config) => boolean;
  agentStore: AgentStore;
  workers: WorkersStore;
  projects: ProjectsStore;
  handoffs: HandoffStore;
  scopeOf: (threadId: string) => AgentScope;
  /** The models now: the screen's, the second look's, the thread's own. */
  models: (threadId: string) => { screen: JudgementCandidate[]; secondLook: JudgementCandidate[]; own: JudgementCandidate | null };
  paneFacts: (paneId: string) => Promise<{ program: string | null; lastLines: string } | null>;
  parentThreadOf?: (threadId: string) => string | null;
  savedQuotes?: (call: ToolCallSpec, projectId: string | null) => Promise<string[]>;
  /** The scratch roots every scope may write in (tests give their own). */
  scratch?: readonly string[];
  /** Each conversation's run of holds; absent, none is kept. */
  streaks?: Pick<ToolReviewStreaks, "hold" | "clear">;
  /** A run of holds moved: what shows the mark reads it again. */
  onStreakChanged?: () => void;
}

/** A run of holds the review could not run for, as the user reads it: the
 *  agent's text tells it what to do instead. */
const UNAVAILABLE_STREAK_REASON = "The tool-call review could not run.";

export class ToolReviewGate implements ToolCallReview {
  /** Each thread's last holds, for the next review's context. Kept by the
   *  running server, as the repeat stop keeps its streaks. */
  private readonly holds = new Map<string, HeldCall[]>();

  constructor(private readonly deps: ToolReviewGateDeps) {}

  async reviewStep(
    threadId: string,
    wakeId: string,
    calls: ToolCallSpec[],
    signal?: AbortSignal,
    opts: { beforeReview?: () => Promise<void> } = {}
  ): Promise<ReadonlyMap<string, string>> {
    try {
      return await this.review(threadId, wakeId, calls, signal, opts);
    } catch (err) {
      // The review never stops a step: what it could not check is held as
      // not checked, and the step goes on.
      logError(`tool-call review for thread ${threadId}`, err);
      return new Map(calls.map((call) => [call.toolCallId, REVIEW_UNAVAILABLE]));
    }
  }

  private async review(
    threadId: string,
    _wakeId: string,
    calls: ToolCallSpec[],
    signal: AbortSignal | undefined,
    opts: { beforeReview?: () => Promise<void> }
  ): Promise<ReadonlyMap<string, string>> {
    const held = new Map<string, string>();
    const config = this.deps.config();
    // Stopped already: the step's calls are cancelled, not reviewed.
    if (!config.agent.toolReviewEnabled || !this.deps.available(config) || calls.length === 0 || signal?.aborted) return held;
    const scope = this.deps.scopeOf(threadId);
    // A subagent judges as the conversation it works for; a side chat as the
    // personal agent, whose conversation it is.
    const thread = this.deps.agentStore.getThreadById(this.deps.parentThreadOf?.(threadId) ?? threadId);
    const kindDeps: ReviewKindDeps = {
      thread: thread?.scope === "side_chat" ? "personal" : thread?.scope ?? "worker",
      registeredRepos: this.registeredRepos(threadId),
      workers: this.deps.workers,
      ...(this.deps.scratch ? { scratch: this.deps.scratch } : {})
    };
    const kinds: Array<{ call: ToolCallSpec; fastPath?: string }> = [];
    for (const [i, call] of calls.entries()) {
      // A call earlier in the step that creates, restores or archives a
      // project, a worker or a thread changes the scopes and cleanups the
      // later calls were judged by: those are reviewed.
      // So does a reviewed call before it: a bash that made a link, say,
      // moves where a later write lands.
      // A repository marker written before a bash moves where its git reads.
      const changedEarlier = STATE_DEPENDENT.has(call.toolName)
        && (kinds.length > 0
          || calls.slice(0, i).some((earlier) => CHANGES_SCOPES.test(earlier.toolName))
          || calls.slice(0, i).some(writesRepositoryMarker));
      const kind: ReviewKind = changedEarlier ? { kind: "review" } : await reviewKind(call, scope, kindDeps);
      if (kind.kind === "skip") continue;
      kinds.push({ call, ...(kind.fastPath ? { fastPath: kind.fastPath } : {}) });
    }
    if (kinds.length === 0) return held;
    await opts.beforeReview?.();
    // What was stored by now is read: words that came in while it waited
    // too, those of this very millisecond included (the reads are strictly
    // before the cut-off).
    const at = new Date(Date.now() + 1).toISOString();
    const reviewed: ReviewedCall[] = [];
    // Stopped while the contexts are built: nothing more is looked up, and
    // the calls (cancelled by the step) are held, neither remembered nor counted.
    const stoppedHolds = () => new Map(kinds.map(({ call }) => [call.toolCallId, REVIEW_UNAVAILABLE] as const));
    for (const { call, fastPath } of kinds) {
      if (signal?.aborted) return stoppedHolds();
      const building = buildReviewContext({ threadId, scope, call, stepCalls: calls, at }, {
        agentStore: this.deps.agentStore,
        workers: this.deps.workers,
        handoffs: this.deps.handoffs,
        config: () => config,
        paneFacts: this.deps.paneFacts,
        recentHolds: async (id) => this.recentHolds(id),
        ...(this.deps.savedQuotes ? { savedQuotes: this.deps.savedQuotes } : {}),
        ...(this.deps.parentThreadOf ? { parentThreadOf: this.deps.parentThreadOf } : {})
      });
      const context = await untilAborted(building, signal);
      if (context === null) return stoppedHolds();
      reviewed.push({ call, context, ...(fastPath ? { fastPath } : {}) });
    }
    const models = this.deps.models(threadId);
    const verdicts = await reviewCalls({ threadId, calls: reviewed, ownModel: models.own, ...(signal ? { signal } : {}) }, { screen: models.screen, secondLook: models.secondLook });
    // Cut short by a stop, its holds are the stop's, not the review's: none
    // is remembered or counted (the step's calls are cancelled anyway).
    if (signal?.aborted) {
      for (const item of reviewed) held.set(item.call.toolCallId, REVIEW_UNAVAILABLE);
      return held;
    }
    // A subagent's holds count for the conversation it works for.
    const conversation = this.deps.parentThreadOf?.(threadId) ?? threadId;
    for (const item of reviewed) {
      const verdict = verdicts.get(item.call.toolCallId);
      if (!verdict?.held) {
        this.deps.streaks?.clear(conversation);
        continue;
      }
      held.set(item.call.toolCallId, verdict.unavailable ? verdict.reason : heldText(verdict.reason));
      this.remember(threadId, { call: item.call, reason: verdict.reason, at: new Date().toISOString() });
      this.deps.streaks?.hold(conversation, verdict.unavailable ? UNAVAILABLE_STREAK_REASON : verdict.reason);
    }
    this.deps.onStreakChanged?.();
    return held;
  }

  /** The thread's last holds, oldest first. */
  recentHolds(threadId: string): HeldCall[] {
    return [...(this.holds.get(threadId) ?? [])];
  }

  private remember(threadId: string, hold: HeldCall): void {
    const kept = [...(this.holds.get(threadId) ?? []), hold].slice(-HOLDS_KEPT);
    this.holds.set(threadId, kept);
  }

  /** The repositories git may read in without a review: every active
   *  project's checkout, and the thread's own worktree. */
  private registeredRepos(threadId: string): string[] {
    const repos = this.deps.projects.listActive().map((project) => project.workingDir);
    try {
      const thread = this.deps.agentStore.getThreadById(this.deps.parentThreadOf?.(threadId) ?? threadId);
      const worker = thread?.scope === "worker" && thread.scopeId ? this.deps.workers.getById(thread.scopeId) : null;
      if (worker?.worktreePath) repos.push(worker.worktreePath);
    } catch (err) {
      logError(`tool-call review: the worktree of thread ${threadId}`, err);
    }
    return repos;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the promise gives, or null as soon as the signal is aborted. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const stopped = () => resolve(null);
    signal.addEventListener("abort", stopped, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", stopped); resolve(value); },
      (err: unknown) => { signal.removeEventListener("abort", stopped); reject(err); }
    );
  });
}
