import { expect, spyOn, test } from "bun:test";
import { AgentHistoryStore, runSearchReads, type SearchFound } from "../src/server/modules/agent/history-store.js";
import { WorkerRecordStore } from "../src/server/modules/plans/record-store.js";
import { seedWorker, seedProject } from "./helpers/fixtures.js";
import { historyEnv } from "./helpers/history-env.js";

// A search's reads run in a worker of their own, beside the server's
// connection: the answer is the one the server's thread would give, and a
// worker that cannot read leaves the reads to the server's thread.

type Env = ReturnType<typeof historyEnv>;

function seed(env: Env): void {
  for (const text of ["rollout notes for the release", "rollout checklist", "migration plan for staging", "数据库迁移的方案"]) {
    env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text } });
  }
}

/** What a search answered, without what each call makes anew: the time
 *  range's start, counted back from now. */
function answered(result: ReturnType<AgentHistoryStore["search"]>) {
  return {
    ...result,
    timeRange: { ...result.timeRange, since: null },
  };
}

const query = (env: Env, text: string) => ({ callerThreadId: env.caller.id, projectId: env.projectId, query: text, includeOwnThread: true });

test("a search's reads in a worker answer what the server's thread answers", async () => {
  const env = historyEnv();
  seed(env);
  const store = new AgentHistoryStore(env.store.db);
  const errors = spyOn(console, "error");
  try {
    for (const text of ["rollout", "数据库", "据库迁 zzzz", "nothing like this"]) {
      const here = store.search(query(env, text));
      const away = await store.searchAway(query(env, text));
      expect(answered(away)).toEqual(answered(here));
    }
    expect(answered(await store.searchAway(query(env, "rollout"))).threads.length).toBeGreaterThan(0);
    // The worker answered: nothing fell back to the server's thread.
    expect(errors.mock.calls.some((args) => String(args[0]).includes("history-search"))).toBe(false);
  } finally {
    errors.mockRestore();
  }
});

test("a worker that cannot open the database leaves the reads to the server's thread", async () => {
  const env = historyEnv();
  seed(env);
  const db = env.store.db;
  const store = new AgentHistoryStore(db);
  const here = store.search(query(env, "rollout"));
  Object.defineProperty(db, "filename", { value: `${env.dir}/missing/mandate.db`, configurable: true });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const away = await store.searchAway(query(env, "rollout"));
    expect(answered(away)).toEqual(answered(here));
    expect(errors.mock.calls.some((args) => String(args[0]).includes("[mandate] history-search: "))).toBe(true);
  } finally {
    errors.mockRestore();
  }
});

/** The search split where the worker's reads happen, so a test can change
 *  the database between the reads and what the server's thread does next. */
function split(store: AgentHistoryStore) {
  const seam = store as unknown as {
    planSearch(input: Parameters<AgentHistoryStore["search"]>[0]): { reads: Parameters<typeof runSearchReads>[1] };
    finishSearch(plan: unknown, found: SearchFound): ReturnType<AgentHistoryStore["search"]>;
  };
  return { plan: seam.planSearch.bind(seam), finish: seam.finishSearch.bind(seam) };
}

test("a worker archived while the reads ran drops out of the answer; the other hits still come back", () => {
  const env = historyEnv();
  seed(env);
  const exportWorker = seedWorker(env.workers, env.projectId, { name: "Export", tmuxWindowName: "export" });
  const exportThread = env.agentStore.getOrCreateThread("worker", exportWorker);
  env.agentStore.appendMessage({ threadId: exportThread.id, role: "user", source: "user", content: { type: "text", text: "rollout notes for export" } });
  const store = new AgentHistoryStore(env.store.db);
  const { plan, finish } = split(store);
  const planned = plan(query(env, "rollout"));
  const found = runSearchReads(env.store.db, planned.reads);
  expect(new Set(found.rows.map((row) => row.thread_id))).toEqual(new Set([env.thread.id, exportThread.id]));
  env.workers.archive(exportWorker);
  const result = finish(planned, found);
  expect(result.threads.map((r) => r.id)).toEqual([env.thread.id]);
});

test("a project archived after the search was planned gives no records when archived ones are not asked for", () => {
  const env = historyEnv();
  new WorkerRecordStore(env.store.db).write({ workerId: env.workerId, projectId: env.projectId, content: "Rollout needle notes"});
  const store = new AgentHistoryStore(env.store.db);
  const planned = split(store).plan({ callerThreadId: env.caller.id, projectId: env.projectId, query: "rollout needle", includeOwnThread: true });
  expect(runSearchReads(env.store.db, planned.reads).records).toHaveLength(1);
  env.projects.archive(env.projectId);
  expect(runSearchReads(env.store.db, planned.reads).records).toEqual([]);
});

test("task records archived or deleted while the reads ran are left out of the answer", () => {
  const env = historyEnv();
  const records = new WorkerRecordStore(env.store.db);
  const write = (projectId: string, workerId: string, content: string) =>
    records.write({ workerId, projectId, content}).record;
  const kept = write(env.projectId, env.workerId, "Rollout needle notes");
  const gone = write(env.projectId, seedWorker(env.workers, env.projectId, { name: "Draft", tmuxWindowName: "draft" }), "Rollout needle draft");
  const beta = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
  write(beta, seedWorker(env.workers, beta, { name: "Billing", tmuxWindowName: "billing" }), "Rollout needle in billing");
  const { plan, finish } = split(new AgentHistoryStore(env.store.db));
  const planned = plan({ callerThreadId: env.caller.id, query: "rollout needle" });
  const found = runSearchReads(env.store.db, planned.reads);
  expect(found.records).toHaveLength(3);
  env.projects.archive(beta);
  env.store.db.prepare("delete from worker_records where id = ?").run(gone.id);
  expect(finish(planned, found).records.map((r) => r.id)).toEqual([kept.id]);
});
