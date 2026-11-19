import { expect, test } from "bun:test";
import { AgentHistoryStore, runSearchReads, scoreThreads } from "../src/server/modules/agent/history-store.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { newId } from "../src/server/platform/ids.js";
import { seedWorker, seedProject } from "./helpers/fixtures.js";
import { historyEnv } from "./helpers/history-env.js";
import { stub } from "./helpers/typed.js";
import { WorkerRecordStore } from "../src/server/modules/plans/record-store.js";

type Entry = { rank?: number | null; message_created_at: string };
/** The search row scoreThreads reads; these tests give it only a rank and a time. */
type SearchEntryRow = Parameters<typeof scoreThreads>[0][number]["entries"][number];

function group(id: string, entries: Entry[]) {
  return { id, entries: entries.map((entry) => stub<SearchEntryRow>(entry)) };
}

function order(groups: Array<{ id: string; entries: SearchEntryRow[] }>): string[] {
  const scores = scoreThreads(groups);
  return [...groups]
    .sort((a, b) => scores.get(b.id)! - scores.get(a.id)!)
    .map((g) => g.id);
}

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-06-01T00:00:00.000Z";

test("the best-matching thread leads even with the fewest hits", () => {
  // The earlier, inverted formula put `best` last: one hit and the largest |bm25|.
  const groups = [
    group("best", [{ rank: -12, message_created_at: T1 }]),
    group("most-hits", Array.from({ length: 6 }, () => ({ rank: -7, message_created_at: T2 }))),
    group("weakest", [{ rank: -6.5, message_created_at: T2 }])
  ];
  expect(order(groups)[0]).toBe("best");
});

test("a worthless match ranks below a strong one", () => {
  // bm25 0 is the weakest possible match; the inverted formula scored it the maximum.
  const groups = [
    group("worthless", [{ rank: 0, message_created_at: T2 }]),
    group("strong", [{ rank: -10, message_created_at: T2 }])
  ];
  expect(order(groups)).toEqual(["strong", "worthless"]);
});

test("hit count breaks a tie in match quality", () => {
  const groups = [
    group("few", [{ rank: -8, message_created_at: T2 }]),
    group("many", Array.from({ length: 4 }, () => ({ rank: -8, message_created_at: T2 })))
  ];
  expect(order(groups)).toEqual(["many", "few"]);
});

test("an unranked group sits between the best and worst ranked groups", () => {
  // Asserted on scores, not order: an order assertion would survive both
  // LIKE_MATCH_RELEVANCE = 1 and = 0, because each collapses into a tie that
  // a stable sort resolves the way the assertion already expects.
  const scores = scoreThreads([
    group("strong", [{ rank: -12, message_created_at: T2 }]),
    group("unranked", [{ rank: null, message_created_at: T2 }]),
    group("weak", [{ rank: -6, message_created_at: T2 }])
  ]);
  expect(scores.get("unranked")!).toBeLessThan(scores.get("strong")!);
  expect(scores.get("unranked")!).toBeGreaterThan(scores.get("weak")!);
});

test("a lone ranked group does not win on a bm25 nothing can be compared against", () => {
  // The shape a mixed search often takes: a manager's long thread is the
  // one ranked group of a project-LIKE + outside-the-projects-FTS set.
  // One quality value is not a span -- there is no second bm25 to place it
  // against, and a bm25 is not commensurable with a substring match -- so quality
  // is inert for the whole set and hits decide. Without that guard the lone
  // ranked group took the degenerate span's ceiling of 1 against the unranked
  // group's midpoint and led 0.72 + 0.08 to 0.36 + 0.2 + 0.08 on a bm25 of -1e-6.
  const groups = [
    group("barely-matched", [{ rank: -0.000001, message_created_at: T2 }]),
    group("unranked", Array.from({ length: 3 }, () => ({ rank: null, message_created_at: T2 })))
  ];
  expect(order(groups)).toEqual(["unranked", "barely-matched"]);
});

test("two ranked qualities still separate, even against a fatter unranked group", () => {
  // The guard against over-correcting the above: neutralizing quality outright
  // would let the unranked group's four hits carry it past both ranked groups.
  // Here quality has a real span (|-12| against |-1|), so it stays live: strong
  // leads at 0.72 + 0.08, unranked sits at its midpoint 0.36 + 0.2 + 0.08, and
  // weak trails at 0.08. Ordered, not scored, because the point is the ordering.
  const groups = [
    group("strong", [{ rank: -12, message_created_at: T2 }]),
    group("unranked", Array.from({ length: 4 }, () => ({ rank: null, message_created_at: T2 }))),
    group("weak", [{ rank: -1, message_created_at: T2 }])
  ];
  expect(order(groups)).toEqual(["strong", "unranked", "weak"]);
});

test("an all-unranked set is ordered by hits, and passes today's saturation point", () => {
  // The hit boost used to saturate at 6.25 hits, so 8 and 20 tied and recency decided.
  const groups = [
    group("eight", Array.from({ length: 8 }, () => ({ rank: null, message_created_at: T2 }))),
    group("twenty", Array.from({ length: 20 }, () => ({ rank: null, message_created_at: T1 })))
  ];
  expect(order(groups)).toEqual(["twenty", "eight"]);
});

test("a single group scores 1 and does not divide by zero", () => {
  const scores = scoreThreads([group("only", [{ rank: -9, message_created_at: T1 }])]);
  // Not toBe(1): 0.72 + 0.2 + 0.08 is 0.9999999999999999 in IEEE doubles.
  expect(scores.get("only")!).toBeCloseTo(1, 10);
});

test("a group with an unusable signal costs only itself", () => {
  // Containment, not validation: NaN spreads through Math.min/Math.max and then
  // through every comparison, so without a guard one bad timestamp would score
  // the whole set NaN and leave the caller's sort with an arbitrary order.
  const wellFormed = [
    group("strong", [{ rank: -12, message_created_at: T2 }]),
    group("weak", [{ rank: -6, message_created_at: T1 }])
  ];
  const withUndated = [
    ...wellFormed,
    group("undated", [{ rank: -9, message_created_at: "not a timestamp" }])
  ];

  for (const [, score] of scoreThreads(withUndated)) {
    expect(Number.isFinite(score)).toBe(true);
  }
  // The well-formed groups keep the order they had without it.
  expect(order(withUndated).filter((id) => id !== "undated")).toEqual(order(wellFormed));
});

test("an unusable signal does not move the other groups' scores", () => {
  // Containment specifically, not just finiteness. `undated` is deliberately
  // non-extremal on the two signals it can still be scored on -- same rank and
  // same hit count as `early` -- so it cannot legitimately move anyone's quality
  // or hits term, and only the recency span is left to be affected. The
  // well-formed groups must then come out identical to a set that never
  // contained it. Collapsing the recency span to () => 1 on encountering the bad
  // value, rather than containing it, would change `early` -- that is exactly the
  // difference between an early return and containment, and the reason for the
  // shape of the guard.
  const early = group("early", [
    { rank: -10, message_created_at: T1 },
    { rank: -10, message_created_at: T1 }
  ]);
  const late = group("late", [
    { rank: -4, message_created_at: T2 },
    { rank: -4, message_created_at: T2 }
  ]);
  const undated = group("undated", [
    { rank: -10, message_created_at: "not a timestamp" },
    { rank: -10, message_created_at: "not a timestamp" }
  ]);

  const alone = scoreThreads([early, late]);
  const alongside = scoreThreads([early, late, undated]);
  expect(alongside.get("early")!).toBeCloseTo(alone.get("early")!, 10);
  expect(alongside.get("late")!).toBeCloseTo(alone.get("late")!, 10);
});

test("a group's quality is its best hit, not its worst", () => {
  // `spread` straddles the set: its best rank is the strongest in play and its
  // worst is the weakest, so reading the wrong end of the group flips which
  // group wins on quality. It also has more hits, which keeps the two readings
  // apart rather than letting the hits term rescue the wrong one. Taking the
  // best rank: qualities are 12 and 6, so spread normalizes to 1 and steady to
  // 0, and spread leads 1.0 to 0.08. Taking the worst: qualities become 1 and
  // 6, and steady leads 0.8 to 0.28 despite the thinner match.
  const groups = [
    group("spread", [
      { rank: -12, message_created_at: T2 },
      { rank: -1, message_created_at: T2 }
    ]),
    group("steady", [{ rank: -6, message_created_at: T2 }])
  ];
  // One timestamp across the set, so recency is degenerate and cannot decide it.
  expect(order(groups)).toEqual(["spread", "steady"]);
});

// A subagent searches as the thread that started it, under its own id: a
// worker's subagent within the worker's project, a manager's naming the
// project, one whose parent is gone as nobody.
test("a subagent searches history as the thread that started it", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  const tasks = new BackgroundTaskStore(env.store.db);
  const subagentOf = (parentThreadId: string) => {
    const taskId = newId("task");
    const child = env.agentStore.createSubagentThread(taskId);
    tasks.create({ id: taskId, parentThreadId, childThreadId: child.id, type: "general", title: "Retry notes", task: "Find the retry notes." });
    return child;
  };
  const otherProjectId = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
  const otherThread = env.agentStore.getOrCreateThread("worker", seedWorker(env.workers, otherProjectId, { name: "Billing", tmuxWindowName: "billing" }));
  env.agentStore.appendMessage({ threadId: otherThread.id, role: "user", source: "user", content: { type: "text", text: "billing retry needle" } });
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "login retry needle" } });

  // A worker's: its own project, which holds the worker's own thread; no other.
  const ofWorker = subagentOf(env.thread.id);
  expect(() => history.search({ callerThreadId: ofWorker.id, projectId: otherProjectId, query: "retry needle" })).toThrow(/project_out_of_scope/);
  const own = history.search({ callerThreadId: ofWorker.id, query: "retry needle" });
  expect([own.project?.id, own.threads.map((result) => result.id)]).toEqual([env.projectId, [env.thread.id]]);
  // A manager's: the project is named, as its manager names it.
  const ofManager = subagentOf(env.caller.id);
  // Without a project it searches every project's task records and the threads outside the projects.
  expect(history.search({ callerThreadId: ofManager.id, query: "retry needle" }).project).toBeNull();
  expect(history.search({ callerThreadId: ofManager.id, projectId: otherProjectId, query: "retry needle" }).threads.map((result) => result.id))
    .toEqual([otherThread.id]);
  // One whose task is gone searches as nobody.
  const orphan = env.agentStore.createSubagentThread("task_without_row");
  expect(() => history.search({ callerThreadId: orphan.id, query: "retry needle" })).toThrow(/caller_thread_not_found/);
});

test("with no project named, projectLifetime does not narrow the time range", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.caller.id, role: "user", source: "user",
    content: { type: "text", text: "lifetime probe" }
  });

  const result = history.search({
    callerThreadId: env.caller.id,
    query: "lifetime probe",
    timeRange: { preset: "projectLifetime" },
    includeOwnThread: true
  });

  expect(result.project).toBeNull();
  expect(result.timeRange.since).toBeNull();
  expect(result.threads.map((thread) => thread.id)).toEqual([env.caller.id]);
});

test("a manager may name a thread outside the projects, with or without a project", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.caller.id, role: "user", source: "user",
    content: { type: "text", text: "manager thread filter probe" }
  });

  const result = history.search({
    callerThreadId: env.caller.id,
    query: "manager thread filter probe",
    threadId: env.caller.id,
    includeOwnThread: true
  });

  expect(result.threads).toHaveLength(1);
  expect(result.threads[0]!.id).toBe(env.caller.id);

  // This is what the call site's `caller.scope === "manager"` buys: naming
  // a manager's thread while searching a real project is answered, not
  // rejected. A worker doing this is refused -- see "a worker cannot name a
  // manager's thread" below. The answer is that thread's own hits, because a
  // manager's search reaches the threads outside the projects alongside the
  // project it named.
  const scoped = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "manager thread filter probe",
    threadId: env.caller.id,
    includeOwnThread: true
  });

  expect(scoped.threads).toHaveLength(1);
  expect(scoped.threads[0]!.id).toBe(env.caller.id);
  expect(scoped.threads[0]!.kind).toBe("manager");
});

test("scope isolation: a worker cannot search outside its project", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.caller.id, role: "user", source: "user",
    content: { type: "text", text: "manager only isolation marker" }
  });
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "manager only isolation marker in a worker thread" }
  });

  // A worker may not name a project id at all...
  expect(() => history.search({
    callerThreadId: env.thread.id,
    projectId: "proj_other",
    query: "manager only isolation"
  })).toThrow(/project_out_of_scope/);

  // ...and its own project never holds a manager's thread: it finds its
  // own thread's hit, and only that one.
  const own = history.search({
    callerThreadId: env.thread.id,
    query: "manager only isolation",
    includeOwnThread: true
  });
  expect(own.project?.id).toBe(env.projectId);
  expect(own.threads.map((r) => r.id)).toEqual([env.thread.id]);
});

test("search: a manager sees a project's hits and the conversations outside the projects", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "shared marker in a worker thread" }
  });
  env.agentStore.appendMessage({
    threadId: env.caller.id, role: "user", source: "user",
    content: { type: "text", text: "shared marker in the manager's thread" }
  });

  const result = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "shared marker",
    includeOwnThread: true
  });

  const scopes = result.threads.map((r) => r.kind).sort();
  expect(scopes).toEqual(["manager", "worker"]);
  const managerHit = result.threads.find((r) => r.kind === "manager")!;
  expect(managerHit.id).toBe(env.caller.id);
  expect(managerHit).not.toHaveProperty("worker");
});

test("search: narrowing to a workerId excludes the threads outside the projects", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.caller.id, role: "user", source: "user",
    content: { type: "text", text: "narrow marker in the manager's thread" }
  });
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "narrow marker in a worker thread" }
  });

  const result = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    workerId: env.workerId,
    query: "narrow marker",
    includeOwnThread: true
  });

  // Narrowing to a worker means asking not to see the conversations
  // outside the projects: that query is not run at all.
  expect(result.threads).toHaveLength(1);
  expect(result.threads[0]!.kind).toBe("worker");
});

test("search: a worker thread whose worker is gone is not surfaced", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "orphan marker with a dangling worker" }
  });
  // Where an entry is comes from its thread: a worker thread whose worker
  // row is gone is in no project, and only a manager's or the personal
  // agent's thread may be in none.
  env.store.db.prepare("update agent_threads set scope_id = ? where id = ?").run("wkr_does_not_exist", env.thread.id);

  const result = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "orphan marker",
    includeOwnThread: true
  });

  expect(result.threads).toHaveLength(0);
});

test("search: a worker thread whose project is gone is not surfaced", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "dangling marker" }
  });
  // Point the thread's worker at a project that does not exist: the entry
  // is read through it, and must be dropped.
  env.store.db.exec("pragma foreign_keys = off");
  env.store.db.prepare("update workers set project_id = ? where id = ?").run("proj_does_not_exist", env.workerId);
  env.store.db.exec("pragma foreign_keys = on");

  // search() rejects an unknown projectId before it ever runs a query, so the
  // row filter is the only thing that can drop this entry. Drive the query
  // directly to see it do that.
  const rows = runSearchReads(env.store.db, { records: null, rows: [{
    query: "dangling marker",
    projectId: "proj_does_not_exist",
    workerId: null,
    threadId: null,
    timeRange: { preset: "all", since: null, until: null },
    includeArchived: false,
    excludedThreads: new Set<string>(),
    limit: 25
  }] }).rows;
  expect(rows).toHaveLength(0);

  // The public path refuses the id outright, before any row is considered.
  expect(() => history.search({
    callerThreadId: env.caller.id,
    projectId: "proj_does_not_exist",
    query: "dangling marker"
  })).toThrow(/project_not_found/);
});

test("search: the LIKE fallback also returns hits outside the projects", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "worker thread arrow --> marker" }
  });
  env.agentStore.appendMessage({
    threadId: env.caller.id, role: "user", source: "user",
    content: { type: "text", text: "manager thread arrow --> marker" }
  });

  // A query with no letters or digits leaves buildFtsQuery with nothing to
  // match on, so searchRows falls through to the LIKE query. That path is
  // reachable in production -- FTS also yields nothing when it matches no row
  // or when searchRowsFts swallows a query it cannot parse.
  const result = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "-->"
  });

  const scopes = result.threads.map((r) => r.kind).sort();
  expect(scopes).toEqual(["manager", "worker"]);
});

test("search: a saturated row budget still returns the project's own threads", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  // Four worker threads in the requested project, each with a few hits.
  const workerThreads = [env.thread.id];
  for (const name of ["Billing", "Search", "Deploy"]) {
    const workerId = seedWorker(env.workers, env.projectId, {
      name,
      tmuxWindowName: name.toLowerCase()
    });
    workerThreads.push(env.agentStore.getOrCreateThread("worker", workerId).id);
  }
  for (const threadId of workerThreads) {
    for (let i = 0; i < 3; i += 1) {
      env.agentStore.appendMessage({
        threadId, role: "user", source: "user",
        content: { type: "text", text: `budget saturation marker ${i}` }
      });
    }
  }
  // A manager's thread holds far more indexed entries than any worker's. Give it more hits than the row budget
  // (limit * snippetsPerThread * 3 = 30) so it can eat the whole window on
  // its own -- and append it last so recency ties break in its favour.
  for (let i = 0; i < 40; i += 1) {
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: `budget saturation marker ${i}` }
    });
  }

  const result = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "budget saturation marker"
  });

  // One ranked query over both scopes returns a single group here: all 30 rows
  // come from the manager's thread, and the project's own threads never make it
  // into the window at all.
  const workerResults = result.threads.filter((r) => r.kind === "worker");
  expect(workerResults.map((r) => r.id).sort()).toEqual(workerThreads.slice().sort());
  expect(result.threads.some((r) => r.kind === "manager")).toBe(true);
});

test("search: the LIKE fallback is decided per scope, not once for both", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  // The worker rows carry `aturationtoken` as a whole token, so the FTS
  // prefix query `aturationtoken*` matches them. The manager's rows carry it
  // only inside `saturationtoken`, which no prefix query can reach -- but LIKE
  // can. So the project answers from FTS while the threads outside the
  // projects have to fall back on their own.
  for (let i = 0; i < 3; i += 1) {
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: `aturationtoken in a worker thread ${i}` }
    });
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: `saturationtoken in the manager's thread ${i}` }
    });
  }

  const result = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "aturationtoken"
  });

  const scopes = result.threads.map((r) => r.kind).sort();
  expect(scopes).toEqual(["manager", "worker"]);
});

test("search: with no project named the threads outside the projects are read once", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  for (let i = 0; i < 3; i += 1) {
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: `sentinel double query marker ${i}` }
    });
  }

  const pinned: Array<string | null> = [];
  const original = (history as any).planSearch.bind(history);
  (history as any).planSearch = (input: any) => {
    const plan = original(input);
    pinned.push(...plan.reads.rows.map((row: { projectId: string | null }) => row.projectId));
    return plan;
  };

  // The search with no project already reads the threads outside the
  // projects; reading them again would return every row twice.
  const result = history.search({
    callerThreadId: env.caller.id,
    query: "sentinel double query marker"
  });

  expect(pinned).toStrictEqual([null]);
  expect(result.threads).toHaveLength(1);
  expect(result.threads[0]!.hitCount).toBe(3);
  const ids = result.threads[0]!.hits.map((hit) => hit.messageId);
  expect(new Set(ids).size).toBe(ids.length);
});

// Scoring fixtures: two threads whose entries differ only in the fields under
// test, so a score difference can only come from the term being probed.
// message_created_at defaults to one pinned value, which makes the recency term
// equal unless a block overrides it.
// scoreThreads normalizes each signal onto [0, 1] across the whole result set:
// |bm25| and hit count each map the set's low to 0 and its high to 1, and a
// signal with only one distinct value maps to 1 for every group. Relevance is
// LIKE_MATCH_RELEVANCE (0.5) for an unranked group, and for *every* group in a
// mixed set whose ranked groups hold fewer than two distinct qualities.
// Weights: relevance 0.72, hits 0.2, recency 0.08.
function scoringEnv() {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  const secondWorker = seedWorker(env.workers, env.projectId, {
    name: "Payments",
    tmuxWindowName: "payments"
  });
  const second = env.agentStore.getOrCreateThread("worker", secondWorker);
  const pinnedAt = "2026-06-01T00:00:00.000Z";
  const rows = (threadId: string, count: number, rank: number | null, createdAt = pinnedAt) => {
    const built: any[] = [];
    for (let i = 0; i < count; i += 1) {
      const message = env.agentStore.appendMessage({
        threadId, role: "user", source: "user",
        content: { type: "text", text: `scoring fixture row ${threadId} ${i}` }
      });
      env.store.db.prepare(
        "update agent_message_search_entries set message_created_at = ? where message_id = ?"
      ).run(createdAt, message.id);
      const row = env.store.db.prepare<Record<string, unknown>, [string]>(
        "select * from agent_message_search_entries where message_id = ?"
      ).get(message.id);
      built.push({ ...row, rank });
    }
    return built;
  };
  const group = (input: any[]) => (history as any).groupSearchRows(input, {
    projectId: env.projectId,
    includeArchived: false,
    limit: 5,
    snippetsPerThread: 2,
    allowOutsideProjects: true
  });
  const scoreOf = (results: any[], threadId: string) =>
    results.find((r: any) => r.id === threadId)!.score;
  return { env, history, second, rows, group, scoreOf };
}

test("scoring: the LIKE query reports no rank rather than a perfect one", () => {
  const { env, history, group } = scoringEnv();
  const message = env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "unranked path arrow --> marker" }
  });
  // No letters or digits, so buildFtsQuery has nothing to match on and the
  // search is answered entirely by searchRowsLike.
  const real = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "-->"
  });
  expect(real.threads).toHaveLength(1);

  // Score the very same indexed entry by hand, once as the LIKE path reports
  // it and once as it used to. The real search must match the first and not the
  // second: what the LIKE query selects is what decides which branch of
  // scoreThreads runs.
  const row = env.store.db.prepare<Record<string, unknown>, [string]>(
    "select * from agent_message_search_entries where message_id = ?"
  ).get(message.id);
  const unranked = group([{ ...row, rank: null }]);
  const asPerfect = group([{ ...row, rank: 0 }]);

  expect(real.threads[0]!.score).toBeCloseTo(unranked[0].score, 10);
  expect(asPerfect[0].score - unranked[0].score).toBeCloseTo(0.72 * (1 - 0.5), 10);
});

test("scoring: an all-FTS search is unchanged by the LIKE relevance constant", () => {
  const { env, second, rows, group, scoreOf } = scoringEnv();
  // Both groups are ranked, so the unranked branch is never taken and neither
  // score can depend on LIKE_MATCH_RELEVANCE at all. FTS5 makes a better match
  // more negative, so bm25 -7 is the better match of the two and it leads.
  const results = group([
    ...rows(env.thread.id, 1, -1),
    ...rows(second.id, 1, -7)
  ]);

  expect(results.map((r: any) => r.id)).toEqual([second.id, env.thread.id]);
  // The qualities are |-7| = 7 and |-1| = 1, which are this set's high and low,
  // so they normalize to 1 and 0 and the entire relevance weight separates
  // them. Every other term is equal here by construction.
  expect(scoreOf(results, second.id) - scoreOf(results, env.thread.id))
    .toBeCloseTo(0.72, 10);
});

test("scoring: an all-LIKE search keeps its order whatever the constant is", () => {
  const { env, second, rows, group, scoreOf } = scoringEnv();
  // Every group is unranked, so every group gets the same relevance and the
  // relevance term cancels out of every comparison. What is left is hits and
  // recency -- so the order of a homogeneous LIKE search cannot depend on the
  // constant's value at all.
  const results = group([
    ...rows(env.thread.id, 3, null),
    ...rows(second.id, 1, null)
  ]);

  expect(results.map((r: any) => r.id)).toEqual([env.thread.id, second.id]);
  // Hits are now normalized across the set rather than boosted by a saturating
  // min(0.25, n * 0.04): 3 is this set's high and 1 its low, so they map to 1
  // and 0 and the difference is the whole 0.2 weight.
  expect(scoreOf(results, env.thread.id) - scoreOf(results, second.id))
    .toBeCloseTo(0.2, 10);
});

test("scoring: a mixed search treats its LIKE half as neutral", () => {
  const { env, second, rows, group, scoreOf } = scoringEnv();
  // The LIKE path used to select `0 as rank`, which 1 / (1 + |rank|) read as a
  // flawless match: relevance 1.0, the ceiling, so the LIKE group outranked
  // every ranked group no matter how well it matched. Which retrieval path
  // answered is not a quality signal, so a LIKE group is now worth the midpoint
  // of the scale the ranked groups normalize onto -- neither the ceiling it used
  // to take nor the floor -- and where the set leaves a lone bm25 nothing to be
  // placed against, every group is worth that midpoint.
  const managerRows = rows(env.caller.id, 1, null);

  // Exactly one ranked group is the shape a mixed search almost always takes,
  // because a manager's thread is usually alone in its half: whichever fell back to
  // LIKE, the other half is usually one group. A single bm25 is not a span --
  // nothing in the set is commensurable with it -- so quality is inert for
  // every group here and the ordering falls to hits and recency. Equal hits, so
  // it falls all the way to recency and the gap is exactly that weight.
  const better = group([
    ...rows(env.thread.id, 1, -1, "2026-05-01T00:00:00.000Z"),
    ...managerRows
  ]);
  expect(better.map((r: any) => r.id)).toEqual([env.caller.id, env.thread.id]);
  expect(scoreOf(better, env.caller.id) - scoreOf(better, env.thread.id))
    .toBeCloseTo(0.08, 10);

  // Inert means inert at either end of the scale: a strong bm25 buys the lone
  // ranked group nothing either, so the unranked group's extra hits carry it.
  // This is where the old formula was backwards -- a bm25 of -7 scored *below*
  // one of -1 there -- and where the fix for that overshot: a degenerate span
  // handed the lone ranked group the ceiling of 1 against the midpoint, so it
  // led on quality alone whatever its bm25.
  const strong = group([...rows(second.id, 1, -7), ...rows(env.caller.id, 3, null)]);
  expect(strong.map((r: any) => r.id)).toEqual([env.caller.id, second.id]);
  expect(scoreOf(strong, env.caller.id) - scoreOf(strong, second.id))
    .toBeCloseTo(0.2, 10);
  // Neutral means neither end, which only two ranked groups can show: that the
  // LIKE group lands between them is scoreThreads' own test.
});

test("search: an archived worker still hides its history by default", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "archived worker owner marker" }
  });
  // The thread itself stays live, so the LEFT JOINed workers row is the only
  // thing that can hide this entry -- exactly as the INNER JOIN did.
  env.store.db.prepare("update workers set archived_at = ? where id = ?")
    .run(new Date().toISOString(), env.workerId);

  const hidden = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "archived worker owner marker"
  });
  expect(hidden.threads).toHaveLength(0);

  const included = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "archived worker owner marker",
    includeArchived: true
  });
  expect(included.threads).toHaveLength(1);
  expect(included.threads[0]!.kind).toBe("worker");
});

test("search: an archived project still hides its history by default", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.thread.id, role: "user", source: "user",
    content: { type: "text", text: "archived project owner marker" }
  });
  env.store.db.prepare("update projects set archived_at = ? where id = ?")
    .run(new Date().toISOString(), env.projectId);

  // The public path never reaches the row filter here: getProject rejects an
  // archived project outright.
  expect(() => history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "archived project owner marker"
  })).toThrow(/project_not_found/);

  // So drive the filter directly to see it drop the row on its own, which is
  // what the INNER JOIN's `p.archived_at is null` used to guarantee.
  const rows = runSearchReads(env.store.db, { records: null, rows: [{
    query: "archived project owner marker",
    projectId: env.projectId,
    workerId: null,
    threadId: null,
    timeRange: { preset: "all", since: null, until: null },
    includeArchived: false,
    excludedThreads: new Set<string>(),
    limit: 25
  }] }).rows;
  expect(rows).toHaveLength(0);

  const included = history.search({
    callerThreadId: env.caller.id,
    projectId: env.projectId,
    query: "archived project owner marker",
    includeArchived: true
  });
  expect(included.threads).toHaveLength(1);
});

test("search: an archived manager thread stays hidden by default", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.caller.id, role: "user", source: "user",
    content: { type: "text", text: "archived manager owner marker" }
  });
  // Archiving the manager's thread and taking a fresh one gives the shape
  // a database has: many archived manager threads, a few live.
  env.agentStore.archiveThread(env.caller.id);
  const live = env.agentStore.getOrCreateThread("manager", null);
  expect(live.id).not.toBe(env.caller.id);

  // A manager's thread has no worker or project to be archived, so the
  // thread's own archived_at is the only thing that can hide it.
  const hidden = history.search({
    callerThreadId: live.id,
    projectId: env.projectId,
    query: "archived manager owner marker"
  });
  expect(hidden.threads).toHaveLength(0);

  const included = history.search({
    callerThreadId: live.id,
    projectId: env.projectId,
    query: "archived manager owner marker",
    includeArchived: true
  });
  expect(included.threads).toHaveLength(1);
  expect(included.threads[0]!.kind).toBe("manager");
  expect(included.threads[0]!.archivedAt).toBeTruthy();
});

test("scope isolation: a worker cannot name a manager's thread", () => {
  const env = historyEnv();
  const history = new AgentHistoryStore(env.store.db);
  env.agentStore.appendMessage({
    threadId: env.caller.id, role: "user", source: "user",
    content: { type: "text", text: "manager thread filter probe" }
  });

  expect(() => history.search({
    callerThreadId: env.thread.id,
    query: "manager thread filter probe",
    threadId: env.caller.id
  })).toThrow(/thread_out_of_scope/);
});

// ---- The records lane: workers' task records, found by their words ----

/** Alpha (the env's project, its worker "Login" the caller's thread) plus
 *  workers with task records; records written a day apart, oldest first. */
function recordsEnv() {
  const env = historyEnv();
  let day = 0;
  const base = Date.now() - 30 * 86_400_000;
  const records = new WorkerRecordStore(env.store.db, () => new Date(base + 86_400_000 * day++).toISOString());
  const worker = (projectId: string, name: string, content: string) => {
    const workerId = seedWorker(env.workers, projectId, { name, tmuxWindowName: name });
    return { workerId, record: records.write({ workerId, projectId, content}).record };
  };
  const history = new AgentHistoryStore(env.store.db);
  const ids = (result: { records: Array<{ id: string }> }) => result.records.map((r) => r.id).sort();
  return { ...env, records, worker, history, ids };
}

test("a worker's search returns its project's records, archived workers' included, not its own", () => {
  const env = recordsEnv();
  const own = env.records.write({ workerId: env.workerId, projectId: env.projectId, content: "Login retry needle work"}).record;
  const done = env.worker(env.projectId, "export", "Export retry needle: shipped\nkept the retry needle in the queue");
  env.workers.archive(done.workerId);
  const beta = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
  env.worker(beta, "billing", "Billing retry needle");
  const result = env.history.search({ callerThreadId: env.thread.id, query: "retry needle" });
  expect(result.records).toEqual([{
    id: done.record.id, worker: "export", project: "Alpha", updated: done.record.updatedAt.slice(0, 10),
    firstLine: "Export retry needle: shipped", lines: ["Export retry needle: shipped", "kept the retry needle in the queue"]
  }]);
  const withOwn = env.history.search({ callerThreadId: env.thread.id, query: "retry needle", includeOwnThread: true });
  expect(env.ids(withOwn)).toEqual([done.record.id, own.id].sort());
});

test("a manager's search with projectId returns that project's records", () => {
  const env = recordsEnv();
  const alpha = env.worker(env.projectId, "export", "Export retry needle");
  const beta = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
  env.worker(beta, "billing", "Billing retry needle");
  expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "retry needle" }))).toEqual([alpha.record.id]);
});

test("a manager's search without projectId returns every active project's records and the conversations outside the projects", () => {
  const env = recordsEnv();
  const alpha = env.worker(env.projectId, "export", "Export retry needle");
  const beta = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
  const billing = env.worker(beta, "billing", "Billing retry needle");
  const gamma = seedProject(env.projects, { name: "Gamma", workingDir: "/gamma", tmuxSessionName: "gamma" });
  const old = env.worker(gamma, "legacy", "Legacy retry needle");
  env.projects.archive(gamma);
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "retry needle in a worker thread" } });
  env.agentStore.appendMessage({ threadId: env.caller.id, role: "user", source: "user", content: { type: "text", text: "retry needle in the manager's thread" } });
  const result = env.history.search({ callerThreadId: env.caller.id, query: "retry needle" });
  expect(result.project).toBeNull();
  expect(result.threads.map((r) => r.id)).toEqual([env.caller.id]);
  expect(env.ids(result)).toEqual([alpha.record.id, billing.record.id].sort());
  expect(result.records.find((r) => r.id === billing.record.id)!.project).toBe("Beta");
  const archived = env.history.search({ callerThreadId: env.caller.id, query: "retry needle", includeArchived: true });
  expect(env.ids(archived)).toEqual([alpha.record.id, billing.record.id, old.record.id].sort());
});

test("the records lane ignores the default time preset and applies explicit since/until", () => {
  const env = recordsEnv();
  const at = new Date(Date.now() - 200 * 86_400_000).toISOString();
  const records = new WorkerRecordStore(env.store.db, () => at);
  const workerId = seedWorker(env.workers, env.projectId, { name: "old-work", tmuxWindowName: "old-work" });
  const record = records.write({ workerId, projectId: env.projectId, content: "Migration needle from long ago"}).record;
  expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle" }))).toEqual([record.id]);
  expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle", timeRange: { preset: "last7d" } }))).toEqual([record.id]);
  const after = new Date(Date.now() - 100 * 86_400_000).toISOString();
  expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle", timeRange: { preset: "all", since: after } }))).toEqual([]);
  expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle", timeRange: { preset: "all", until: after } }))).toEqual([record.id]);
});

test("workerId narrows records to that worker; threadId skips the lane", () => {
  const env = recordsEnv();
  const a = env.worker(env.projectId, "export", "Export retry needle");
  env.worker(env.projectId, "import", "Import retry needle");
  expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, workerId: a.workerId, query: "retry needle" }))).toEqual([a.record.id]);
  expect(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, threadId: env.thread.id, query: "retry needle" }).records).toEqual([]);
});

test("records count against the payload cap and are at most 5", () => {
  const env = recordsEnv();
  // Records big enough that the room they take changes how many chats fit.
  for (let i = 0; i < 7; i++) env.worker(env.projectId, `worker-${i}-${"long-name-".repeat(15)}`, `${"cache needle ".repeat(30)}\n${"cache needle again ".repeat(30)}`);
  // Ten worker threads with long hits, enough to fill the cap on their own.
  for (let i = 0; i < 10; i++) {
    const thread = env.agentStore.getOrCreateThread("worker", seedWorker(env.workers, env.projectId, { name: `talk-${i}`, tmuxWindowName: `talk-${i}` }));
    for (let j = 0; j < 5; j++) env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: `cache needle ${i}-${j} ${"filler words ".repeat(120)}` } });
  }
  const result = env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "cache needle", limit: 10, snippetsPerThread: 5 });
  expect(result.records).toHaveLength(5);
  expect(result.caps.truncated).toBe(true);
  expect(JSON.stringify(result.threads).length + JSON.stringify(result.records).length).toBeLessThanOrEqual(result.caps.maxPayloadChars);
});

// The records lane is not held to the chats' rules.
test("an until older than the default window still finds records; the chats come back empty", () => {
  const env = recordsEnv();
  const at = new Date(Date.now() - 200 * 86_400_000).toISOString();
  const workerId = seedWorker(env.workers, env.projectId, { name: "old-work", tmuxWindowName: "old-work" });
  const record = new WorkerRecordStore(env.store.db, () => at).write({ workerId, projectId: env.projectId, content: "Migration needle from long ago"}).record;
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "migration needle today" } });
  const until = new Date(Date.now() - 150 * 86_400_000).toISOString();
  const result = env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle", timeRange: { until } });
  expect(env.ids(result)).toEqual([record.id]);
  expect(result.threads).toEqual([]);
  // Said, not left to read as "nothing was said".
  expect(result.chatsNotSearched).toBe("The until is before this time range's start, so no chats were searched: for older chats, pass preset \"projectLifetime\" or \"all\".");
  expect(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle" }).chatsNotSearched).toBeUndefined();
  // A range the caller set backwards is still refused.
  expect(() => env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle", timeRange: { since: until, until: at } })).toThrow(/time_range_invalid/);
});

test("a manager naming a worker without a project searches that worker's project, chats and record", () => {
  const env = recordsEnv();
  const beta = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
  const billing = env.worker(beta, "billing", "Billing retry needle");
  env.worker(beta, "invoices", "Invoices retry needle");
  const billingThread = env.agentStore.getOrCreateThread("worker", billing.workerId);
  env.agentStore.appendMessage({ threadId: billingThread.id, role: "user", source: "user", content: { type: "text", text: "retry needle in billing's chat" } });
  const result = env.history.search({ callerThreadId: env.caller.id, workerId: billing.workerId, query: "retry needle" });
  expect(result.project?.id).toBe(beta);
  expect(env.ids(result)).toEqual([billing.record.id]);
  expect(result.threads.map((r) => r.id)).toEqual([billingThread.id]);
  expect(result.chatsNotSearched).toBeUndefined();
  expect(() => env.history.search({ callerThreadId: env.caller.id, workerId: "wkr_missing", query: "retry needle" })).toThrow(/worker_not_found/);
});

test("narrowing to an archived worker finds its record without includeArchived; its chats stay out", () => {
  const env = recordsEnv();
  const done = env.worker(env.projectId, "export", "Export retry needle");
  const thread = env.agentStore.getOrCreateThread("worker", done.workerId);
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "retry needle in export's chat" } });
  env.workers.archive(done.workerId);
  const result = env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, workerId: done.workerId, query: "retry needle" });
  expect(env.ids(result)).toEqual([done.record.id]);
  expect(result.threads).toEqual([]);
  expect(result.chatsNotSearched).toBe("This worker is archived: its chats are searched with includeArchived: true.");
  const withArchived = env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, workerId: done.workerId, query: "retry needle", includeArchived: true });
  expect(withArchived.threads.map((r) => r.id)).toEqual([thread.id]);
  expect(withArchived.chatsNotSearched).toBeUndefined();
});
