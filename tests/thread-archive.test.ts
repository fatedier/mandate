import { afterEach, expect, test } from "bun:test";
import { freshProjectEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { ThreadArchive, type ThreadArchiveDeps } from "../src/server/modules/agent/thread-archive.js";
import { ManagerThreadService } from "../src/server/modules/agent/manager-threads.js";

// A thread that still had workers refused to archive, and each worker had to
// be archived from its own dialog first. The thread's archive takes its
// workers with it now: every worker is checked first, nothing is changed
// while a check finds something the user has not confirmed, and then the
// workers go, and the thread after them.

let env: ReturnType<typeof freshProjectEnv> | null = null;
afterEach(() => { env?.cleanup(); env = null; });

type Archived = { id: string; confirmed?: boolean; cleanup?: { removeWorktree?: boolean; deleteBranch?: boolean } };

/** A thread with workers, and a recorder for everything the archive does.
 *  `findings` are what each worker's check finds; `foundLate` a worker whose
 *  own archive refuses although its check passed (it kept working). */
function setup(options: {
  workers?: string[]; findings?: Record<string, string[]>; foundLate?: Record<string, string[]>; throws?: Record<string, string>; running?: string[];
  /** While this worker is archived, the thread's manager starts another (its call was already under way). */
  starts?: Record<string, string>;
  /** Archiving this worker wakes the thread's manager again (the worker's stop is reported to it). */
  wakesManager?: string[];
  /** Workers whose archive says it went through and leaves them active. */
  stays?: string[];
  /** What each worker's check waits for before it answers (git, slow). */
  checkGate?: Promise<void>;
  /** What each worker's archive waits for before it goes (git, slow). */
  archiveGate?: Promise<void>;
  /** While this worker is archived, that one goes to the other thread, and its turn starts there. */
  handsOver?: Record<string, string>;
} = {}) {
  // A test may set up again: the env before goes first, or its folder is left behind.
  env?.cleanup();
  env = freshProjectEnv("md-thread-archive-");
  const { agentStore, workers, projects } = env;
  const projectId = seedProject(projects);
  const thread = agentStore.createManagerThread("project-1 cache expiry");
  const other = agentStore.createManagerThread("Sidebar");
  const ids: Record<string, string> = {};
  const start = (name: string) => {
    ids[name] = seedWorker(workers, projectId, { name, tmuxWindowName: name });
    workers.setOwner(ids[name]!, thread.id);
    agentStore.getOrCreateThread("worker", ids[name]!);
  };
  for (const name of options.workers ?? []) start(name);
  const elsewhere = seedWorker(workers, projectId, { name: "Elsewhere", tmuxWindowName: "elsewhere" });
  workers.setOwner(elsewhere, other.id);
  const nameOf = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
  const log: string[] = [];
  const archivedWith: Archived[] = [];
  const running = new Set((options.running ?? []).map((who) => who === "manager" ? thread.id : agentStore.getThreadByScope("worker", ids[who]!)!.id));
  const deps: ThreadArchiveDeps = {
    agentStore, workerStore: workers,
    workers: {
      archiveCheck: async (id) => {
        await options.checkGate;
        return { findings: options.findings?.[nameOf(id)] ?? [] };
      },
      archive: async (input) => {
        await options.archiveGate;
        const name = nameOf(input.id);
        // As the service: a worker is archived for the thread that owns it only.
        if (input.by && workers.getById(input.id)?.ownerThreadId !== input.by) {
          log.push(`refused ${name}: not its owner`);
          return { ok: false, error: "owned by another thread" };
        }
        if (options.throws?.[name]) {
          log.push(`threw ${name}`);
          throw new Error(options.throws[name]);
        }
        const late = options.foundLate?.[name];
        if (late && !input.confirmed) {
          log.push(`refused ${name}`);
          return { ok: false, error: late.join(" "), check: { findings: late } };
        }
        archivedWith.push({ id: name, confirmed: input.confirmed, cleanup: input.cleanup });
        if (!options.stays?.includes(name)) workers.archive(input.id);
        log.push(`archived ${name}`);
        if (options.starts?.[name]) start(options.starts[name]);
        const handed = options.handsOver?.[name];
        if (handed) {
          workers.setOwner(ids[handed]!, other.id);
          running.add(agentStore.getThreadByScope("worker", ids[handed]!)!.id);
        }
        if (options.wakesManager?.includes(name)) running.add(thread.id);
        return { ok: true, worker: { projectId }, cleanupFailures: name === "Second" || name === "Messy" ? [{ kind: "branch", branch: name.toLowerCase(), error: "not fully merged" }] : [] };
      }
    },
    wakes: {
      getRunningWakeForThread: (threadId) => running.has(threadId) ? { id: `wake-of-${threadId}` } : null,
      cancelWake: (wakeId) => {
        const threadId = wakeId.replace("wake-of-", "");
        const owner = threadId === thread.id ? "manager" : nameOf(agentStore.getThreadById(threadId)!.scopeId!);
        log.push(`stopped ${owner}`);
        running.delete(threadId);
      }
    },
    releaseThreadResources: (threadId) => { log.push(`released ${threadId === thread.id ? "thread" : threadId}`); },
    // Its memory is taken from the conversation while it is still there.
    beforeThreadArchive: (threadId) => { log.push(agentStore.getThreadById(threadId)!.archivedAt === null ? `remembered ${threadId === thread.id ? "thread" : threadId}` : "remembered too late"); },
    broadcast: (event) => { log.push(`${event.type} ${nameOf((event.data as { id: string }).id)}`); },
    publishThread: (threadId) => { log.push("published"); return new ManagerThreadService({ agentStore }).dto(threadId); }
  };
  const open = () => ({
    thread: agentStore.getThreadById(thread.id)!.archivedAt === null,
    workers: workers.listActiveOwnedBy(thread.id).map((f) => f.name),
    elsewhere: workers.getById(elsewhere)!.archivedAt === null
  });
  return { archive: new ThreadArchive(deps), thread, other, ids, log, archivedWith, open, projectId };
}

test("a thread with no workers archives as it did: its turn stopped, what it held released, its memory taken, and the change published", async () => {
  const t = setup({ running: ["manager"] });
  const result = await t.archive.archive({ threadId: t.thread.id });
  expect(result).toMatchObject({ ok: true, workers: [], cleanupFailures: [] });
  expect(result.ok && result.thread.archivedAt !== null).toBe(true);
  expect(t.log).toStrictEqual(["stopped manager", "released thread", "remembered thread", "published"]);
  expect(t.open()).toEqual({ thread: false, workers: [], elsewhere: true });
});

test("its workers are archived with it, each first, and every page is told of each", async () => {
  const t = setup({ workers: ["First", "Second"] });
  const result = await t.archive.archive({ threadId: t.thread.id });
  expect(result).toMatchObject({
    ok: true,
    workers: [{ id: t.ids.First, name: "First" }, { id: t.ids.Second, name: "Second" }],
    // What a worker's cleanup could not do is passed on.
    cleanupFailures: [{ kind: "branch", branch: "second", error: "not fully merged" }]
  });
  expect(t.log).toStrictEqual([
    "archived First", "workerArchived First", "archived Second", "workerArchived Second",
    "released thread", "remembered thread", "published"
  ]);
  // Only its own workers: another thread's stays.
  expect(t.open()).toEqual({ thread: false, workers: [], elsewhere: true });
});

test("a worker whose check finds something refuses the whole archive, and nothing is changed", async () => {
  const t = setup({ workers: ["First", "Second", "Third"], findings: { Second: ["3 uncommitted files in the worktree.", "2 commits are not in main."], Third: ["Could not read the worktree's status."] }, running: ["manager", "First"] });
  const result = await t.archive.archive({ threadId: t.thread.id });
  expect(result).toEqual({
    ok: false, status: 409,
    error: "Archiving would lose work in: Second, Third.",
    // Only the workers something was found in, each with what was found.
    workers: [
      { id: t.ids.Second!, name: "Second", findings: ["3 uncommitted files in the worktree.", "2 commits are not in main."] },
      { id: t.ids.Third!, name: "Third", findings: ["Could not read the worktree's status."] }
    ],
    archived: [],
    cleanupFailures: []
  });
  // Not the clean worker either, no turn stopped, nothing released.
  expect(t.log).toStrictEqual([]);
  expect(t.open()).toEqual({ thread: true, workers: ["First", "Second", "Third"], elsewhere: true });
});

test("confirmed for the worker something was found in, the same archive goes ahead, and that worker alone is archived as confirmed", async () => {
  const t = setup({ workers: ["First", "Second"], findings: { Second: ["3 uncommitted files in the worktree."] } });
  const result = await t.archive.archive({ threadId: t.thread.id, confirmed: [t.ids.Second!] });
  expect(result.ok).toBe(true);
  expect(t.archivedWith.map((a) => [a.id, a.confirmed])).toStrictEqual([["First", false], ["Second", true]]);
  expect(t.open()).toEqual({ thread: false, workers: [], elsewhere: true });
});

test("the confirmation is for the workers it names: another worker something is found in refuses still, and nothing is changed", async () => {
  // A second worker, started or dirtied after the user was shown the first.
  const t = setup({ workers: ["First", "Second", "Third"], findings: { Second: ["3 uncommitted files in the worktree."], Third: ["1 uncommitted file in the worktree."] } });
  expect(await t.archive.archive({ threadId: t.thread.id, confirmed: [t.ids.Second!] })).toEqual({
    ok: false, status: 409,
    error: "Archiving would lose work in: Third.",
    // What was confirmed is not asked again; what was not is shown.
    workers: [{ id: t.ids.Third!, name: "Third", findings: ["1 uncommitted file in the worktree."] }],
    archived: [],
    cleanupFailures: []
  });
  expect(t.log).toStrictEqual([]);
  expect(t.open()).toEqual({ thread: true, workers: ["First", "Second", "Third"], elsewhere: true });
  // An id that is no worker of this thread confirms nothing.
  expect((await t.archive.archive({ threadId: t.thread.id, confirmed: ["wkr_unknown", t.ids.Second!] })).ok).toBe(false);
  expect((await t.archive.archive({ threadId: t.thread.id, confirmed: [t.ids.Second!, t.ids.Third!] })).ok).toBe(true);
});

test("the cleanup choices can only hold a worker's own cleanup back", async () => {
  // Left alone, each worker cleans up what its own kind of workspace calls
  // for: nothing is ordered, which would take a worktree it only borrowed.
  const left = setup({ workers: ["First"] });
  await left.archive.archive({ threadId: left.thread.id });
  expect(left.archivedWith[0]!.cleanup).toEqual({ removeWorktree: undefined, deleteBranch: undefined });
  // Each can be held back by itself.
  const worktrees = setup({ workers: ["First"] });
  await worktrees.archive.archive({ threadId: worktrees.thread.id, keepWorktrees: true });
  expect(worktrees.archivedWith[0]!.cleanup).toEqual({ removeWorktree: false, deleteBranch: undefined });
  const branches = setup({ workers: ["First"] });
  await branches.archive.archive({ threadId: branches.thread.id, keepBranches: true });
  expect(branches.archivedWith[0]!.cleanup).toEqual({ removeWorktree: undefined, deleteBranch: false });
});

test("the thread's own turn is stopped before any worker goes, and a worker's before that worker", async () => {
  // Left running, the manager could start another worker while these go.
  const t = setup({ workers: ["First", "Second"], running: ["Second", "manager"] });
  await t.archive.archive({ threadId: t.thread.id });
  expect(t.log).toStrictEqual([
    "stopped manager",
    "archived First", "workerArchived First",
    "stopped Second", "archived Second", "workerArchived Second",
    "released thread", "remembered thread", "published"
  ]);
});

test("a worker that went to another thread while an earlier one was archived keeps its new turn and is left to that thread", async () => {
  // The workers go one by one, each waiting on git: by the time this one's
  // comes, it may have been handed to another manager and be at work there.
  const t = setup({ workers: ["First", "Second"], handsOver: { First: "Second" } });
  const result = await t.archive.archive({ threadId: t.thread.id });
  expect(result).toMatchObject({ ok: true, workers: [{ id: t.ids.First, name: "First" }] });
  expect(t.log).toStrictEqual(["archived First", "workerArchived First", "released thread", "remembered thread", "published"]);
  expect(env!.workers.getById(t.ids.Second!)).toMatchObject({ archivedAt: null, ownerThreadId: t.other.id });
});

test("a turn the thread began while its workers went is stopped too, before the thread is archived", async () => {
  // A worker's stop is reported to its thread, which wakes it.
  const t = setup({ workers: ["First"], wakesManager: ["First"] });
  await t.archive.archive({ threadId: t.thread.id });
  expect(t.log).toStrictEqual(["archived First", "workerArchived First", "stopped manager", "released thread", "remembered thread", "published"]);
});

test("a worker the manager started while the others went goes too, on its own check, before the thread does", async () => {
  const t = setup({ workers: ["First"], starts: { First: "Late" } });
  const result = await t.archive.archive({ threadId: t.thread.id });
  expect(result).toMatchObject({ ok: true, workers: [{ id: t.ids.First, name: "First" }, { id: t.ids.Late, name: "Late" }] });
  expect(t.log).toStrictEqual(["archived First", "workerArchived First", "archived Late", "workerArchived Late", "released thread", "remembered thread", "published"]);
  expect(t.open()).toEqual({ thread: false, workers: [], elsewhere: true });

  // The user's confirmation covers the workers that were there when it was
  // given: one that appeared since is checked, and what it has stops the archive.
  const confirmed = setup({ workers: ["First"], starts: { First: "Late" }, foundLate: { Late: ["1 uncommitted file in the worktree."] } });
  expect(await confirmed.archive.archive({ threadId: confirmed.thread.id, confirmed: [confirmed.ids.First!] })).toEqual({
    ok: false, status: 409,
    error: "Archiving would lose work in: Late.",
    workers: [{ id: confirmed.ids.Late!, name: "Late", findings: ["1 uncommitted file in the worktree."] }],
    archived: [{ id: confirmed.ids.First!, name: "First" }],
    cleanupFailures: []
  });
  expect(confirmed.archivedWith.map((a) => [a.id, a.confirmed])).toStrictEqual([["First", true]]);
  expect(confirmed.open()).toEqual({ thread: true, workers: ["Late"], elsewhere: true });
});

test("a worker still active after its archive said it went stops the archive, where it would otherwise never end", async () => {
  const t = setup({ workers: ["First", "Stuck"], stays: ["Stuck"] });
  expect(await t.archive.archive({ threadId: t.thread.id })).toEqual({
    ok: false, status: 409,
    error: "Archiving would lose work in: Stuck.",
    workers: [{ id: t.ids.Stuck!, name: "Stuck", findings: ["It is still active after its archive."] }],
    archived: [{ id: t.ids.First!, name: "First" }, { id: t.ids.Stuck!, name: "Stuck" }],
    cleanupFailures: []
  });
  expect(t.open()).toEqual({ thread: true, workers: ["Stuck"], elsewhere: true });
});

test("a worker that picked up work after its check stops the archive there: the thread stays, and the answer says who had gone", async () => {
  const t = setup({ workers: ["First", "Second", "Third"], foundLate: { Second: ["1 uncommitted file in the worktree.", "2 commits are not in main."] } });
  const result = await t.archive.archive({ threadId: t.thread.id });
  expect(result).toEqual({
    ok: false, status: 409,
    error: "Archiving would lose work in: Second.",
    // Each thing found, as the worker's own check lists them.
    workers: [{ id: t.ids.Second!, name: "Second", findings: ["1 uncommitted file in the worktree.", "2 commits are not in main."] }],
    archived: [{ id: t.ids.First!, name: "First" }],
    cleanupFailures: []
  });
  expect(t.log).toStrictEqual(["archived First", "workerArchived First", "refused Second"]);
  expect(t.open()).toEqual({ thread: true, workers: ["Second", "Third"], elsewhere: true });
  // Asked again with that worker confirmed, the rest goes.
  expect((await t.archive.archive({ threadId: t.thread.id, confirmed: [t.ids.Second!] })).ok).toBe(true);
  expect(t.open()).toEqual({ thread: false, workers: [], elsewhere: true });
});

test("a worker whose archive fails outright stops it the same way: the answer says why, who had gone, and what their cleanup could not do", async () => {
  // Git not answering while the worker is checked again, say.
  const t = setup({ workers: ["Messy", "Second", "Third"], throws: { Second: "git did not answer in 15s" } });
  const result = await t.archive.archive({ threadId: t.thread.id });
  expect(result).toEqual({
    ok: false, status: 409,
    error: "Archiving would lose work in: Second.",
    workers: [{ id: t.ids.Second!, name: "Second", findings: ["git did not answer in 15s"] }],
    archived: [{ id: t.ids.Messy!, name: "Messy" }],
    // The worker that went left a branch behind: still said, though the archive stopped.
    cleanupFailures: [{ kind: "branch", branch: "messy", error: "not fully merged" }]
  });
  expect(t.log).toStrictEqual(["archived Messy", "workerArchived Messy", "threw Second"]);
  expect(t.open()).toEqual({ thread: true, workers: ["Second", "Third"], elsewhere: true });
});

test("only an open manager thread is archived this way", async () => {
  const t = setup({ workers: ["First"] });
  const workerThread = env!.agentStore.getThreadByScope("worker", t.ids.First!)!;
  for (const threadId of ["thr_missing", workerThread.id]) {
    expect(await t.archive.archive({ threadId })).toEqual({ ok: false, status: 404, error: "thread not found" });
  }
  await t.archive.archive({ threadId: t.thread.id });
  expect(await t.archive.archive({ threadId: t.thread.id })).toEqual({ ok: false, status: 404, error: "thread not found" });
  expect(t.log.filter((line) => line === "published")).toHaveLength(1);
});

test("a thread archived by another request while its workers' checks ran is answered as gone, and nothing more is done", async () => {
  let answer!: () => void;
  // Its check would have found something: still the answer is that it is gone.
  const t = setup({ workers: ["First"], findings: { First: ["1 uncommitted file in the worktree."] }, checkGate: new Promise<void>((resolve) => { answer = resolve; }) });
  const result = t.archive.archive({ threadId: t.thread.id });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Another archive of the thread, confirmed, went through meanwhile.
  env!.workers.archive(t.ids.First!);
  env!.agentStore.archiveThread(t.thread.id);
  answer();
  expect(await result).toMatchObject({ ok: false, status: 404 });
  expect(t.log).toStrictEqual([]);
});

test("a thread deleted while its workers were being archived is answered as gone, and is not archived after them", async () => {
  let answer!: () => void;
  const t = setup({ workers: ["First"], archiveGate: new Promise<void>((resolve) => { answer = resolve; }) });
  const result = t.archive.archive({ threadId: t.thread.id });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  env!.store.db.prepare("delete from agent_threads where id = ?").run(t.thread.id);
  answer();
  expect(await result).toMatchObject({ ok: false, status: 404 });
  expect(t.log).not.toContain("published");
});
