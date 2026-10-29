import { expect, test } from "bun:test";
import { AgentHistoryStore, GLOBAL_HISTORY_PROJECT, scoreThreads } from "../src/server/modules/agent/history-store.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { newId } from "../src/server/platform/ids.js";
import { seedFeature, seedProject } from "./helpers/fixtures.js";
import { historyEnv } from "./helpers/history-env.js";
import { stub } from "./helpers/typed.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";

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
  // The shape a mixed search almost always takes: the overview thread is a
  // singleton, so a project-LIKE + global-FTS set has exactly one ranked group.
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
  try {
    const history = new AgentHistoryStore(env.store.db);
    const tasks = new BackgroundTaskStore(env.store.db);
    const subagentOf = (parentThreadId: string) => {
      const taskId = newId("task");
      const child = env.agentStore.createSubagentThread(taskId);
      tasks.create({ id: taskId, parentThreadId, childThreadId: child.id, type: "general", title: "Retry notes", task: "Find the retry notes." });
      return child;
    };
    const otherProjectId = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
    const otherThread = env.agentStore.getOrCreateThread("worker", seedFeature(env.features, otherProjectId, { name: "Billing", tmuxWindowName: "billing" }));
    env.agentStore.appendMessage({ threadId: otherThread.id, role: "user", source: "user", content: { type: "text", text: "billing retry needle" } });
    env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "login retry needle" } });

    // A worker's: its own project, which holds the worker's own thread; no other.
    const ofWorker = subagentOf(env.thread.id);
    expect(() => history.search({ callerThreadId: ofWorker.id, projectId: otherProjectId, query: "retry needle" })).toThrow(/project_out_of_scope/);
    const own = history.search({ callerThreadId: ofWorker.id, query: "retry needle" });
    expect([own.project.id, own.results.map((result) => result.thread.id)]).toEqual([env.projectId, [env.thread.id]]);
    // A manager's: the project is named, as its manager names it.
    const ofManager = subagentOf(env.caller.id);
    // Without a project it searches every project's task records and the overview's own history.
    expect(history.search({ callerThreadId: ofManager.id, query: "retry needle" }).project.id).toBe(GLOBAL_HISTORY_PROJECT);
    expect(history.search({ callerThreadId: ofManager.id, projectId: otherProjectId, query: "retry needle" }).results.map((result) => result.thread.id))
      .toEqual([otherThread.id]);
    // One whose task is gone searches as nobody.
    const orphan = env.agentStore.createSubagentThread("task_without_row");
    expect(() => history.search({ callerThreadId: orphan.id, query: "retry needle" })).toThrow(/caller_thread_not_found/);
  } finally {
    env.cleanup();
  }
});

test("thread meta: the global scope resolves without a projects row", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "global project probe" }
    });

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: GLOBAL_HISTORY_PROJECT,
      query: "global project probe",
      timeRange: { preset: "projectLifetime" },
      includeCurrentLineage: true
    });

    expect(result.project.id).toBe(GLOBAL_HISTORY_PROJECT);
    expect(result.project.name).toBe("Overview");
    // The global scope has no creation date, so projectLifetime cannot narrow.
    expect(result.timeRange.since).toBe(new Date(0).toISOString());
  } finally {
    env.cleanup();
  }
});

test("thread meta: an overview agent may name an overview thread in the global scope", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "global thread filter probe" }
    });

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: GLOBAL_HISTORY_PROJECT,
      query: "global thread filter probe",
      threadId: env.caller.id,
      includeCurrentLineage: true
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.thread.id).toBe(env.caller.id);

    // This is what the call site's `caller.scope === "manager"` buys: naming
    // an overview thread while searching a real project is answered, not
    // rejected. A feature agent doing this is refused -- see "a feature agent
    // cannot name an overview thread" below. The answer is the overview
    // thread's own hits, because an overview agent's search reaches the global
    // scope alongside the project it named.
    const scoped = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "global thread filter probe",
      threadId: env.caller.id,
      includeCurrentLineage: true
    });

    expect(scoped.results).toHaveLength(1);
    expect(scoped.results[0]!.thread.id).toBe(env.caller.id);
    expect(scoped.results[0]!.thread.scope).toBe("manager");
  } finally {
    env.cleanup();
  }
});

test("scope isolation: a project-scoped handle cannot read an overview thread", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    const message = env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "project scoped handle probe" }
    });

    // A handle minted under a real project must not open an overview thread,
    // even for the overview agent that owns the handle. Only a handle that
    // records the global scope may.
    const handle = (history as any).createHandle({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      threadId: env.caller.id,
      messageId: message.id,
      seq: message.seq,
      timeRange: { preset: "all", since: null, until: null, reason: "project scoped handle unit test" },
      includeArchived: false
    }) as string;

    expect(() => history.read({ callerThreadId: env.caller.id, handle }))
      .toThrow(/thread_out_of_scope/);
  } finally {
    env.cleanup();
  }
});

test("scope isolation: a feature agent cannot search the global scope", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "overview only isolation marker" }
    });
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "overview only isolation marker in a feature thread" }
    });

    // A feature agent may not name another project id at all...
    expect(() => history.search({
      callerThreadId: env.thread.id,
      projectId: GLOBAL_HISTORY_PROJECT,
      query: "overview only isolation"
    })).toThrow(/project_out_of_scope/);

    // ...and its own project scope never matches a global entry: it finds its
    // own thread's hit, and only that one.
    const own = history.search({
      callerThreadId: env.thread.id,
      query: "overview only isolation",
      includeCurrentLineage: true
    });
    expect(own.project.id).toBe(env.projectId);
    expect(own.results.map((r) => r.thread.id)).toEqual([env.thread.id]);
  } finally {
    env.cleanup();
  }
});

test("search: an overview agent sees both project hits and global hits", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "shared marker in a feature thread" }
    });
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "shared marker in the overview thread" }
    });

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "shared marker",
      includeCurrentLineage: true
    });

    const scopes = result.results.map((r) => r.thread.scope).sort();
    expect(scopes).toEqual(["manager", "worker"]);
    const overviewHit = result.results.find((r) => r.thread.scope === "manager")!;
    expect(overviewHit.thread.id).toBe(env.caller.id);
    expect(overviewHit.thread.featureId).toBeNull();
    expect(overviewHit.thread.featureName).toBeNull();
  } finally {
    env.cleanup();
  }
});

test("search: narrowing to a featureId excludes global hits", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "narrow marker in the overview thread" }
    });
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "narrow marker in a feature thread" }
    });

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      featureId: env.featureId,
      query: "narrow marker",
      includeCurrentLineage: true
    });

    // Global entries have a null feature_id, so `and e.feature_id = ?` drops
    // them. Narrowing to a feature means asking not to see the overview.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.thread.scope).toBe("worker");
  } finally {
    env.cleanup();
  }
});

test("search: the LEFT JOIN does not surface an entry whose feature is missing", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    const dangling = env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "orphan marker with a dangling feature" }
    });
    const absent = env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "orphan marker with no feature at all" }
    });
    // An INNER JOIN on features dropped both: one names a feature that
    // does not exist, the other names none while claiming a real project.
    // Under the LEFT JOIN they must still be dropped -- only a
    // global entry is allowed to have no feature.
    env.store.db.prepare(
      "update agent_message_search_entries set feature_id = ? where message_id = ?"
    ).run("feat_does_not_exist", dangling.id);
    env.store.db.prepare(
      "update agent_message_search_entries set feature_id = null where message_id = ?"
    ).run(absent.id);

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "orphan marker",
      includeCurrentLineage: true
    });

    expect(result.results).toHaveLength(0);
  } finally {
    env.cleanup();
  }
});

test("search: the LEFT JOIN does not surface an entry whose project is missing", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    const message = env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "dangling marker" }
    });
    // Point the indexed entry at a project that does not exist. An INNER
    // JOIN dropped it; under the LEFT JOIN it must still be dropped.
    env.store.db.prepare(
      "update agent_message_search_entries set project_id = ? where message_id = ?"
    ).run("proj_does_not_exist", message.id);

    // search() rejects an unknown projectId before it ever runs a query, so the
    // row filter is the only thing that can drop this entry. Drive the query
    // directly to see it do that.
    const rows = (history as any).searchRows({
      query: "dangling marker",
      projectId: "proj_does_not_exist",
      featureId: null,
      threadId: null,
      timeRange: { preset: "all", since: null, until: null, reason: "dangling project unit test" },
      includeArchived: false,
      excludedThreads: new Set<string>(),
      limit: 25
    });
    expect(rows).toHaveLength(0);

    // The public path refuses the id outright, before any row is considered.
    expect(() => history.search({
      callerThreadId: env.caller.id,
      projectId: "proj_does_not_exist",
      query: "dangling marker"
    })).toThrow(/project_not_found/);
  } finally {
    env.cleanup();
  }
});

test("search: the LIKE fallback also returns global hits", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "feature thread arrow --> marker" }
    });
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "overview thread arrow --> marker" }
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

    const scopes = result.results.map((r) => r.thread.scope).sort();
    expect(scopes).toEqual(["manager", "worker"]);
  } finally {
    env.cleanup();
  }
});

test("search: a saturated row budget still returns the project's own threads", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    // Four feature threads in the requested project, each with a few hits.
    const featureThreads = [env.thread.id];
    for (const name of ["Billing", "Search", "Deploy"]) {
      const featureId = seedFeature(env.features, env.projectId, {
        name,
        tmuxWindowName: name.toLowerCase()
      });
      featureThreads.push(env.agentStore.getOrCreateThread("worker", featureId).id);
    }
    for (const threadId of featureThreads) {
      for (let i = 0; i < 3; i += 1) {
        env.agentStore.appendMessage({
          threadId, role: "user", source: "user",
          content: { type: "text", text: `budget saturation marker ${i}` }
        });
      }
    }
    // The live overview thread is a single thread holding far more indexed
    // entries than any other. Give it more hits than the row budget
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
    // come from the overview thread, and the project's own threads never make it
    // into the window at all.
    const featureResults = result.results.filter((r) => r.thread.scope === "worker");
    expect(featureResults.map((r) => r.thread.id).sort()).toEqual(featureThreads.slice().sort());
    expect(result.results.some((r) => r.thread.scope === "manager")).toBe(true);
  } finally {
    env.cleanup();
  }
});

test("search: the LIKE fallback is decided per scope, not once for both", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    // The feature rows carry `aturationtoken` as a whole token, so the FTS
    // prefix query `aturationtoken*` matches them. The overview rows carry it
    // only inside `saturationtoken`, which no prefix query can reach -- but LIKE
    // can. So the project scope answers from FTS while the global scope has to
    // fall back on its own.
    for (let i = 0; i < 3; i += 1) {
      env.agentStore.appendMessage({
        threadId: env.thread.id, role: "user", source: "user",
        content: { type: "text", text: `aturationtoken in a feature thread ${i}` }
      });
      env.agentStore.appendMessage({
        threadId: env.caller.id, role: "user", source: "user",
        content: { type: "text", text: `saturationtoken in the overview thread ${i}` }
      });
    }

    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "aturationtoken"
    });

    const scopes = result.results.map((r) => r.thread.scope).sort();
    expect(scopes).toEqual(["manager", "worker"]);
  } finally {
    env.cleanup();
  }
});

test("search: naming the global scope itself does not run the global query twice", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    for (let i = 0; i < 3; i += 1) {
      env.agentStore.appendMessage({
        threadId: env.caller.id, role: "user", source: "user",
        content: { type: "text", text: `sentinel double query marker ${i}` }
      });
    }

    const pinned: string[] = [];
    const original = (history as any).searchRows.bind(history);
    (history as any).searchRows = (input: any) => {
      pinned.push(input.projectId);
      return original(input);
    };

    // getProject accepts the sentinel, so an overview agent may ask for it by
    // name -- and the result echoes project "Overview" back to it, which invites
    // exactly this call. The project half has then already searched the global
    // scope, so running the global half too would return every row twice.
    const result = history.search({
      callerThreadId: env.caller.id,
      projectId: GLOBAL_HISTORY_PROJECT,
      query: "sentinel double query marker"
    });

    expect(pinned).toStrictEqual([GLOBAL_HISTORY_PROJECT]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.hitCount).toBe(3);
    const ids = result.results[0]!.hits.map((hit) => hit.messageId);
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    env.cleanup();
  }
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
  const secondFeature = seedFeature(env.features, env.projectId, {
    name: "Payments",
    tmuxWindowName: "payments"
  });
  const second = env.agentStore.getOrCreateThread("worker", secondFeature);
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
    timeRange: { preset: "all", since: null, until: null, reason: "scoring unit test" },
    includeArchived: false,
    callerThreadId: env.caller.id,
    limit: 5,
    snippetsPerThread: 2,
    allowGlobal: true
  });
  const scoreOf = (results: any[], threadId: string) =>
    results.find((r: any) => r.thread.id === threadId)!.score;
  return { env, history, second, rows, group, scoreOf };
}

test("scoring: the LIKE query reports no rank rather than a perfect one", () => {
  const { env, history, group } = scoringEnv();
  try {
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
    expect(real.results).toHaveLength(1);

    // Score the very same indexed entry by hand, once as the LIKE path reports
    // it and once as it used to. The real search must match the first and not the
    // second: what the LIKE query selects is what decides which branch of
    // scoreThreads runs.
    const row = env.store.db.prepare<Record<string, unknown>, [string]>(
      "select * from agent_message_search_entries where message_id = ?"
    ).get(message.id);
    const unranked = group([{ ...row, rank: null }]);
    const asPerfect = group([{ ...row, rank: 0 }]);

    expect(real.results[0]!.score).toBeCloseTo(unranked[0].score, 10);
    expect(asPerfect[0].score - unranked[0].score).toBeCloseTo(0.72 * (1 - 0.5), 10);
  } finally {
    env.cleanup();
  }
});

test("scoring: an all-FTS search is unchanged by the LIKE relevance constant", () => {
  const { env, second, rows, group, scoreOf } = scoringEnv();
  try {
    // Both groups are ranked, so the unranked branch is never taken and neither
    // score can depend on LIKE_MATCH_RELEVANCE at all. FTS5 makes a better match
    // more negative, so bm25 -7 is the better match of the two and it leads.
    const results = group([
      ...rows(env.thread.id, 1, -1),
      ...rows(second.id, 1, -7)
    ]);

    expect(results.map((r: any) => r.thread.id)).toEqual([second.id, env.thread.id]);
    // The qualities are |-7| = 7 and |-1| = 1, which are this set's high and low,
    // so they normalize to 1 and 0 and the entire relevance weight separates
    // them. Every other term is equal here by construction.
    expect(scoreOf(results, second.id) - scoreOf(results, env.thread.id))
      .toBeCloseTo(0.72, 10);
  } finally {
    env.cleanup();
  }
});

test("scoring: an all-LIKE search keeps its order whatever the constant is", () => {
  const { env, second, rows, group, scoreOf } = scoringEnv();
  try {
    // Every group is unranked, so every group gets the same relevance and the
    // relevance term cancels out of every comparison. What is left is hits and
    // recency -- so the order of a homogeneous LIKE search cannot depend on the
    // constant's value at all.
    const results = group([
      ...rows(env.thread.id, 3, null),
      ...rows(second.id, 1, null)
    ]);

    expect(results.map((r: any) => r.thread.id)).toEqual([env.thread.id, second.id]);
    // Hits are now normalized across the set rather than boosted by a saturating
    // min(0.25, n * 0.04): 3 is this set's high and 1 its low, so they map to 1
    // and 0 and the difference is the whole 0.2 weight.
    expect(scoreOf(results, env.thread.id) - scoreOf(results, second.id))
      .toBeCloseTo(0.2, 10);
  } finally {
    env.cleanup();
  }
});

test("scoring: a mixed search treats its LIKE half as neutral", () => {
  const { env, second, rows, group, scoreOf } = scoringEnv();
  try {
    // The LIKE path used to select `0 as rank`, which 1 / (1 + |rank|) read as a
    // flawless match: relevance 1.0, the ceiling, so the LIKE group outranked
    // every ranked group no matter how well it matched. Which retrieval path
    // answered is not a quality signal, so a LIKE group is now worth the midpoint
    // of the scale the ranked groups normalize onto -- neither the ceiling it used
    // to take nor the floor -- and where the set leaves a lone bm25 nothing to be
    // placed against, every group is worth that midpoint.
    const overview = rows(env.caller.id, 1, null);

    // Exactly one ranked group is the shape a mixed search almost always takes,
    // because the overview thread is a singleton: whichever half fell back to
    // LIKE, the other half is usually one group. A single bm25 is not a span --
    // nothing in the set is commensurable with it -- so quality is inert for
    // every group here and the ordering falls to hits and recency. Equal hits, so
    // it falls all the way to recency and the gap is exactly that weight.
    const better = group([
      ...rows(env.thread.id, 1, -1, "2026-05-01T00:00:00.000Z"),
      ...overview
    ]);
    expect(better.map((r: any) => r.thread.id)).toEqual([env.caller.id, env.thread.id]);
    expect(scoreOf(better, env.caller.id) - scoreOf(better, env.thread.id))
      .toBeCloseTo(0.08, 10);

    // Inert means inert at either end of the scale: a strong bm25 buys the lone
    // ranked group nothing either, so the unranked group's extra hits carry it.
    // This is where the old formula was backwards -- a bm25 of -7 scored *below*
    // one of -1 there -- and where the fix for that overshot: a degenerate span
    // handed the lone ranked group the ceiling of 1 against the midpoint, so it
    // led on quality alone whatever its bm25.
    const strong = group([...rows(second.id, 1, -7), ...rows(env.caller.id, 3, null)]);
    expect(strong.map((r: any) => r.thread.id)).toEqual([env.caller.id, second.id]);
    expect(scoreOf(strong, env.caller.id) - scoreOf(strong, second.id))
      .toBeCloseTo(0.2, 10);
    // Neutral means neither end, which only two ranked groups can show: that the
    // LIKE group lands between them is scoreThreads' own test.
  } finally {
    env.cleanup();
  }
});

test("search: an archived feature still hides its history by default", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.thread.id, role: "user", source: "user",
      content: { type: "text", text: "archived feature owner marker" }
    });
    // The thread itself stays live, so the LEFT JOINed features row is the only
    // thing that can hide this entry -- exactly as the INNER JOIN did.
    env.store.db.prepare("update features set archived_at = ? where id = ?")
      .run(new Date().toISOString(), env.featureId);

    const hidden = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "archived feature owner marker"
    });
    expect(hidden.results).toHaveLength(0);

    const included = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "archived feature owner marker",
      includeArchived: true
    });
    expect(included.results).toHaveLength(1);
    expect(included.results[0]!.thread.scope).toBe("worker");
  } finally {
    env.cleanup();
  }
});

test("search: an archived project still hides its history by default", () => {
  const env = historyEnv();
  try {
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
    const rows = (history as any).searchRows({
      query: "archived project owner marker",
      projectId: env.projectId,
      featureId: null,
      threadId: null,
      timeRange: { preset: "all", since: null, until: null, reason: "archived project unit test" },
      includeArchived: false,
      excludedThreads: new Set<string>(),
      limit: 25
    });
    expect(rows).toHaveLength(0);

    const included = history.search({
      callerThreadId: env.caller.id,
      projectId: env.projectId,
      query: "archived project owner marker",
      includeArchived: true
    });
    expect(included.results).toHaveLength(1);
  } finally {
    env.cleanup();
  }
});

test("search: an archived overview thread still hides its global history by default", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "archived overview owner marker" }
    });
    // Archiving the live overview thread and taking the fresh one gives the
    // shape an old database has: many archived overview threads, one live.
    env.agentStore.archiveThread(env.caller.id);
    const live = env.agentStore.getOrCreateThread("manager", null);
    expect(live.id).not.toBe(env.caller.id);

    // A global entry has no feature or project to be archived, so the thread's
    // own archived_at is the only thing that can hide it.
    const hidden = history.search({
      callerThreadId: live.id,
      projectId: env.projectId,
      query: "archived overview owner marker"
    });
    expect(hidden.results).toHaveLength(0);

    const included = history.search({
      callerThreadId: live.id,
      projectId: env.projectId,
      query: "archived overview owner marker",
      includeArchived: true
    });
    expect(included.results).toHaveLength(1);
    expect(included.results[0]!.thread.scope).toBe("manager");
    expect(included.results[0]!.thread.archivedAt).toBeTruthy();
  } finally {
    env.cleanup();
  }
});

test("scope isolation: a feature agent cannot name an overview thread", () => {
  const env = historyEnv();
  try {
    const history = new AgentHistoryStore(env.store.db);
    env.agentStore.appendMessage({
      threadId: env.caller.id, role: "user", source: "user",
      content: { type: "text", text: "overview thread filter probe" }
    });

    expect(() => history.search({
      callerThreadId: env.thread.id,
      query: "overview thread filter probe",
      threadId: env.caller.id
    })).toThrow(/thread_out_of_scope/);
  } finally {
    env.cleanup();
  }
});

// ---- The records lane: workers' task records, found by their words ----

/** Alpha (the env's project, its worker "Login" the caller's thread) plus
 *  workers with task records; records written a day apart, oldest first. */
function recordsEnv() {
  const env = historyEnv();
  let day = 0;
  const base = Date.now() - 30 * 86_400_000;
  const records = new FeatureRecordStore(env.store.db, () => new Date(base + 86_400_000 * day++).toISOString());
  const worker = (projectId: string, name: string, content: string) => {
    const featureId = seedFeature(env.features, projectId, { name, tmuxWindowName: name });
    return { featureId, record: records.write({ featureId, projectId, content, sourceThreadId: null, metadata: null }).record };
  };
  const history = new AgentHistoryStore(env.store.db);
  const ids = (result: { records: Array<{ id: string }> }) => result.records.map((r) => r.id).sort();
  return { ...env, records, worker, history, ids };
}

test("a worker's search returns its project's records, archived workers' included, not its own", () => {
  const env = recordsEnv();
  try {
    const own = env.records.write({ featureId: env.featureId, projectId: env.projectId, content: "Login retry needle work", sourceThreadId: null, metadata: null }).record;
    const done = env.worker(env.projectId, "export", "Export retry needle: shipped\nkept the retry needle in the queue");
    env.features.archive(done.featureId);
    const beta = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
    env.worker(beta, "billing", "Billing retry needle");
    const result = env.history.search({ callerThreadId: env.thread.id, query: "retry needle" });
    expect(result.records).toEqual([{
      id: done.record.id, worker: "export", project: "Alpha", updated: done.record.updatedAt.slice(0, 10),
      firstLine: "Export retry needle: shipped", lines: ["Export retry needle: shipped", "kept the retry needle in the queue"]
    }]);
    const withOwn = env.history.search({ callerThreadId: env.thread.id, query: "retry needle", includeCurrentLineage: true });
    expect(env.ids(withOwn)).toEqual([done.record.id, own.id].sort());
  } finally {
    env.cleanup();
  }
});

test("a manager's search with projectId returns that project's records", () => {
  const env = recordsEnv();
  try {
    const alpha = env.worker(env.projectId, "export", "Export retry needle");
    const beta = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
    env.worker(beta, "billing", "Billing retry needle");
    expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "retry needle" }))).toEqual([alpha.record.id]);
  } finally {
    env.cleanup();
  }
});

test("a manager's search without projectId returns every active project's records and its own conversation", () => {
  const env = recordsEnv();
  try {
    const alpha = env.worker(env.projectId, "export", "Export retry needle");
    const beta = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
    const billing = env.worker(beta, "billing", "Billing retry needle");
    const gamma = seedProject(env.projects, { name: "Gamma", workingDir: "/gamma", tmuxSessionName: "gamma" });
    const old = env.worker(gamma, "legacy", "Legacy retry needle");
    env.projects.archive(gamma);
    env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "retry needle in a feature thread" } });
    env.agentStore.appendMessage({ threadId: env.caller.id, role: "user", source: "user", content: { type: "text", text: "retry needle in the overview" } });
    const result = env.history.search({ callerThreadId: env.caller.id, query: "retry needle" });
    expect(result.project.id).toBe(GLOBAL_HISTORY_PROJECT);
    expect(result.results.map((r) => r.thread.id)).toEqual([env.caller.id]);
    expect(env.ids(result)).toEqual([alpha.record.id, billing.record.id].sort());
    expect(result.records.find((r) => r.id === billing.record.id)!.project).toBe("Beta");
    const archived = env.history.search({ callerThreadId: env.caller.id, query: "retry needle", includeArchived: true });
    expect(env.ids(archived)).toEqual([alpha.record.id, billing.record.id, old.record.id].sort());
  } finally {
    env.cleanup();
  }
});

test("the records lane ignores the default time preset and applies explicit since/until", () => {
  const env = recordsEnv();
  try {
    const at = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const records = new FeatureRecordStore(env.store.db, () => at);
    const featureId = seedFeature(env.features, env.projectId, { name: "old-work", tmuxWindowName: "old-work" });
    const record = records.write({ featureId, projectId: env.projectId, content: "Migration needle from long ago", sourceThreadId: null, metadata: null }).record;
    expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle" }))).toEqual([record.id]);
    expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle", timeRange: { preset: "last7d" } }))).toEqual([record.id]);
    const after = new Date(Date.now() - 100 * 86_400_000).toISOString();
    expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle", timeRange: { preset: "all", reason: "old work", since: after } }))).toEqual([]);
    expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle", timeRange: { preset: "all", reason: "old work", until: after } }))).toEqual([record.id]);
  } finally {
    env.cleanup();
  }
});

test("featureId narrows records to that feature; threadId skips the lane", () => {
  const env = recordsEnv();
  try {
    const a = env.worker(env.projectId, "export", "Export retry needle");
    env.worker(env.projectId, "import", "Import retry needle");
    expect(env.ids(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, featureId: a.featureId, query: "retry needle" }))).toEqual([a.record.id]);
    expect(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, threadId: env.thread.id, query: "retry needle" }).records).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("records count against the payload cap and are at most 5", () => {
  const env = recordsEnv();
  try {
    // Records big enough that the room they take changes how many chats fit.
    for (let i = 0; i < 7; i++) env.worker(env.projectId, `worker-${i}-${"long-name-".repeat(15)}`, `${"cache needle ".repeat(30)}\n${"cache needle again ".repeat(30)}`);
    // Ten feature threads with long hits, enough to fill the cap on their own.
    for (let i = 0; i < 10; i++) {
      const thread = env.agentStore.getOrCreateThread("worker", seedFeature(env.features, env.projectId, { name: `talk-${i}`, tmuxWindowName: `talk-${i}` }));
      for (let j = 0; j < 5; j++) env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: `cache needle ${i}-${j} ${"filler words ".repeat(120)}` } });
    }
    const result = env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "cache needle", limit: 10, snippetsPerThread: 5 });
    expect(result.records).toHaveLength(5);
    expect(result.caps.truncated).toBe(true);
    expect(JSON.stringify(result.results).length + JSON.stringify(result.records).length).toBeLessThanOrEqual(result.caps.maxPayloadChars);
  } finally {
    env.cleanup();
  }
});

test("the audit row counts the records returned", () => {
  const env = recordsEnv();
  try {
    env.worker(env.projectId, "export", "Export retry needle");
    env.worker(env.projectId, "import", "Import retry needle");
    env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "retry needle" });
    const row = env.store.db.prepare("select metadata_json from agent_history_audit where caller_thread_id = ? order by created_at desc limit 1").get(env.caller.id) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toMatchObject({ records: 2 });
  } finally {
    env.cleanup();
  }
});

// The records lane is not held to the chats' rules.
test("an until older than the default window still finds records; the chats come back empty", () => {
  const env = recordsEnv();
  try {
    const at = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const featureId = seedFeature(env.features, env.projectId, { name: "old-work", tmuxWindowName: "old-work" });
    const record = new FeatureRecordStore(env.store.db, () => at).write({ featureId, projectId: env.projectId, content: "Migration needle from long ago", sourceThreadId: null, metadata: null }).record;
    env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "migration needle today" } });
    const until = new Date(Date.now() - 150 * 86_400_000).toISOString();
    const result = env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle", timeRange: { until } });
    expect(env.ids(result)).toEqual([record.id]);
    expect(result.results).toEqual([]);
    // Said, not left to read as "nothing was said".
    expect(result.chatsNotSearched).toBe("The until is before this time range's start, so no chats were searched: for older chats, pass preset \"projectLifetime\", or \"all\" with a reason.");
    expect(env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle" }).chatsNotSearched).toBeUndefined();
    // A range the caller set backwards is still refused.
    expect(() => env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "migration needle", timeRange: { since: until, until: at } })).toThrow(/time_range_invalid/);
  } finally {
    env.cleanup();
  }
});

test("a manager naming a worker without a project searches that worker's project, chats and record", () => {
  const env = recordsEnv();
  try {
    const beta = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
    const billing = env.worker(beta, "billing", "Billing retry needle");
    env.worker(beta, "invoices", "Invoices retry needle");
    const billingThread = env.agentStore.getOrCreateThread("worker", billing.featureId);
    env.agentStore.appendMessage({ threadId: billingThread.id, role: "user", source: "user", content: { type: "text", text: "retry needle in billing's chat" } });
    const result = env.history.search({ callerThreadId: env.caller.id, featureId: billing.featureId, query: "retry needle" });
    expect(result.project.id).toBe(beta);
    expect(env.ids(result)).toEqual([billing.record.id]);
    expect(result.results.map((r) => r.thread.id)).toEqual([billingThread.id]);
    expect(result.chatsNotSearched).toBeUndefined();
    expect(() => env.history.search({ callerThreadId: env.caller.id, featureId: "feat_missing", query: "retry needle" })).toThrow(/feature_not_found/);
  } finally {
    env.cleanup();
  }
});

test("narrowing to an archived worker finds its record without includeArchived; its chats stay out", () => {
  const env = recordsEnv();
  try {
    const done = env.worker(env.projectId, "export", "Export retry needle");
    const thread = env.agentStore.getOrCreateThread("worker", done.featureId);
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "retry needle in export's chat" } });
    env.features.archive(done.featureId);
    const result = env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, featureId: done.featureId, query: "retry needle" });
    expect(env.ids(result)).toEqual([done.record.id]);
    expect(result.results).toEqual([]);
    expect(result.chatsNotSearched).toBe("This worker is archived: its chats are searched with includeArchived: true.");
    const withArchived = env.history.search({ callerThreadId: env.caller.id, projectId: env.projectId, featureId: done.featureId, query: "retry needle", includeArchived: true });
    expect(withArchived.results.map((r) => r.thread.id)).toEqual([thread.id]);
    expect(withArchived.chatsNotSearched).toBeUndefined();
  } finally {
    env.cleanup();
  }
});
