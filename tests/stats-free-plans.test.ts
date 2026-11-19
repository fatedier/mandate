import { expect, test } from "bun:test";
import { ThreadDeletion } from "../src/server/modules/agent/thread-delete.js";
import { loadWindowVerdicts } from "../src/server/modules/activity/window-verdicts.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { initializeMemorySchema } from "../src/server/modules/memory/schema.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { memoryEntryHistory } from "../src/server/modules/memory/browse.js";
import { MemoryDreamer } from "../src/server/modules/memory/dream.js";
import { listMemoryDreamRuns } from "../src/server/modules/memory/dream-runs.js";
import { listActivityFilterOptions } from "../src/server/modules/activity/filter-options.js";
import { createPriceCatalog } from "../src/server/modules/pricing/catalog.js";
import { PricingPass } from "../src/server/modules/pricing/pricing-pass.js";
import type { ProviderConfig } from "../src/server/config/types.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { recentMemoriesFor } from "../src/server/modules/memory/recent-memories.js";
import { WorkerRecordStore } from "../src/server/modules/plans/record-store.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { plansOf, plansOfAsync } from "./helpers/sql-watch.js";
import { LearnedSkillStore } from "../src/server/modules/skills/learned-skill-store.js";
import { resolveReviewTarget } from "../src/server/modules/skills/review-target.js";

// Mandate never runs ANALYZE, so SQLite plans every query without statistics.
// Each read here is planned the way it must be in that state: through the
// index that answers it, never through a walk of a table that grows.

type Env = ReturnType<typeof freshStoresEnv>;

const noStats = (env: Env) => expect(env.store.db.prepare("select count(*) as n from sqlite_master where name = 'sqlite_stat1'").get()).toEqual({ n: 0 });

test("a turn's last reply is found through its wake, not by walking its thread", () => {
  const env = freshStoresEnv("md-plans-wake-text-");
  noStats(env);
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-plans");
  const wake = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "done" } });
  const [plan] = plansOf(env.store.db, /from agent_messages/, () => expect(env.agentStore.latestAssistantTextOfWake(thread.id, wake.id)).toBe("done"));
  // Newest first by the turn's own (wake, seq) index: its rows are read
  // from the newest down until one has words, never all of them sorted.
  expect(plan).toContain("idx_agent_messages_wake_seq (wake_id=?)");
  expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
});

// A message deleted from a long conversation (tens of thousands of rows) is
// read and removed by its id: beside a list of ids, `thread_id = ?` is
// planned as a walk of every row of the thread.
test("a deleted message is found by its id, not by walking its thread", () => {
  const env = freshStoresEnv("md-plans-remove-message-");
  noStats(env);
  const thread = env.agentStore.createManagerThread("Long");
  const kept = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "kept" } });
  const gone = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "gone" } });
  const plans = plansOf(env.store.db, /from agent_messages where/, () => env.agentStore.removeMessages(thread.id, [gone.id]));
  for (const plan of plans) {
    expect(plan).toContain("sqlite_autoindex_agent_messages_1 (id=?)");
    expect(plan).not.toContain("idx_agent_messages_thread_seq");
  }
  expect(env.agentStore.getMessageById(gone.id)).toBeNull();
  expect(env.agentStore.getMessageById(kept.id)?.id).toBe(kept.id);
});

// A review request names its conversation by id or by a name the agent
// knows. Workers and threads pile up (archived ones are kept), so each is
// found through an index: a manager's workers through their owner, open
// manager threads through their own index, active workers by name through
// the active ones only.
test("a review request finds the conversation it names through indexes", () => {
  const env = freshStoresEnv("md-plans-review-target-");
  noStats(env);
  const project = seedProject(env.projects, { name: "bakery", tmuxSessionName: "md-bk" });
  const skills = new LearnedSkillStore(env.store.db, () => new Set());
  const manager = env.agentStore.createManagerThread("Bakery");
  const workerId = seedWorker(env.workers, project, { name: "cert renewal", tmuxWindowName: "md-w1", ownerThreadId: manager.id });
  const workerThread = env.agentStore.getOrCreateThread("worker", workerId);
  for (const threadId of [workerThread.id, manager.id]) env.agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: "work" } });
  const personal = env.agentStore.getOrCreatePersonalThread();
  const deps = { agentStore: env.agentStore, workersStore: env.workers, store: skills };
  const plans = plansOf(env.store.db, /from (workers|agent_threads)\b/, () => {
    expect(resolveReviewTarget(deps, manager.id, "cert renewal")?.threadId).toBe(workerThread.id);
    expect(resolveReviewTarget(deps, manager.id, workerId)?.threadId).toBe(workerThread.id);
    expect(resolveReviewTarget(deps, personal.id, "cert renewal")?.threadId).toBe(workerThread.id);
    expect(resolveReviewTarget(deps, personal.id, "Bakery")?.threadId).toBe(manager.id);
  });
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan).not.toMatch(/SCAN (workers|agent_threads)(?! USING)/);
  const owned = plansOf(env.store.db, /from workers where owner_thread_id/, () => {
    env.workers.listActiveOwnedBy(manager.id);
    env.workers.listArchivedOwnedBy(manager.id);
  });
  for (const plan of owned) expect(plan).toContain("idx_workers_owner");
  const [openManagers] = plansOf(env.store.db, /from agent_threads/, () => env.agentStore.listOpenManagerThreads());
  expect(openManagers).toContain("idx_agent_threads_open_managers");
  expect(openManagers).not.toContain("USE TEMP B-TREE FOR ORDER BY");
});

test("learned skills are listed, made visible, counted and queued through indexes", () => {
  const env = freshStoresEnv("md-plans-learned-");
  noStats(env);
  const skills = new LearnedSkillStore(env.store.db, () => new Set());
  const made = skills.create({ name: "release-steps", description: "x", body: "x", where: { scope: "project", projectId: "proj_one" }, by: "review" });
  if (!made.ok) throw new Error(made.message);
  skills.recordUse(made.skill.id, "thr_w", "worker");
  skills.requestReview({ threadId: "thr_w", requestedBy: "thr_m", focus: "x", fromSeq: 1, toSeq: 2 });
  const plans = [
    ...plansOf(env.store.db, /from learned_skills/, () => skills.list({ where: { scope: "project", projectId: "proj_one" }, status: "available" })),
    ...plansOf(env.store.db, /from learned_skills/, () => skills.visible({ projectIds: ["proj_one"] })),
    ...plansOf(env.store.db, /from learned_skill_uses/, () => skills.usesSince(made.skill.id, "2026-01-01T00:00:00.000Z")),
    ...plansOf(env.store.db, /from skill_review_runs/, () => skills.nextQueuedReview())
  ];
  for (const plan of plans) expect(plan).not.toMatch(/SCAN (learned_skills|learned_skill_uses|skill_review_runs)\b/);
  // A request finds its thread's queued run through the thread, not by walking every queued run.
  const [queuedLookup] = plansOf(env.store.db, /from skill_review_runs where thread_id/, () => skills.requestReview({ threadId: "thr_other", requestedBy: "thr_m", focus: "y", fromSeq: 1, toSeq: 2 }));
  expect(queuedLookup).toContain("idx_skill_review_runs_thread");
  // The available skills of every scope are read through their status, archived ones never walked.
  const [available] = plansOf(env.store.db, /from learned_skills where/, () => skills.list({ status: "available" }));
  expect(available).toContain("idx_learned_skills_status");
  // A skill's history and an action's members are read by their keys, however long the history grows.
  for (let r = 1; r <= 33; r++) skills.change(made.skill.id, r, { body: `b ${r}`, change: "patch", by: "agent" });
  const historyPlans = [
    ...plansOf(env.store.db, /from learned_skill_versions/, () => skills.versions(made.skill.id)),
    ...plansOf(env.store.db, /from learned_skill_versions/, () => skills.history(made.skill.id)),
    ...plansOf(env.store.db, /from learned_skill_versions/, () => skills.ends(made.skill.id)),
    ...plansOf(env.store.db, /from learned_skill_actions/, () => skills.revert(made.skill.id, { by: "agent", reason: "x" }))
  ];
  for (const plan of historyPlans) expect(plan).not.toMatch(/SCAN (learned_skill_versions|learned_skill_actions)\b/);
  // The Memory page's review list reads its newest runs in order through an index.
  const [reviews] = plansOf(env.store.db, /from skill_review_runs order by/, () => skills.recentReviews(50));
  expect(reviews).toContain("idx_skill_review_runs_created");
  expect(reviews).not.toContain("USE TEMP B-TREE");
});

// Archived workers keep their conversations open: a walk that starts from
// every open worker thread reads hundreds of them for the few live workers.
test("the stalled workers are found from the active workers, not from every open worker thread", () => {
  const env = freshStoresEnv("md-plans-stalled-");
  noStats(env);
  const items = new WorkItemStore(env.store.db);
  const plans = [
    ...plansOf(env.store.db, /from workers wk/, () => items.listStalled()),
    ...plansOf(env.store.db, /from workers wk/, () => items.listStalled({ ownerThreadId: "thr_owner" }))
  ];
  for (const plan of plans) expect(plan.split(" | ")[0]).toMatch(/^(SCAN|SEARCH) wk\b/);
});

test("a worker's or a project's thread is found through the open-thread index", () => {
  const env = freshStoresEnv("md-plans-scope-");
  noStats(env);
  env.agentStore.getOrCreateThread("worker", "wkr-scope");
  const [plan] = plansOf(env.store.db, /from agent_threads/, () => expect(env.agentStore.getThreadByScope("worker", "wkr-scope")?.scopeId).toBe("wkr-scope"));
  expect(plan).toContain("idx_agent_threads_scope_active");
});

test("the manager thread the user last wrote in is found through the user's own messages", () => {
  const env = freshStoresEnv("md-plans-latest-manager-");
  const first = env.agentStore.createManagerThread("First");
  env.agentStore.createManagerThread("Second");
  env.agentStore.appendMessage({ threadId: first.id, role: "user", source: "user", content: { type: "text", text: "hello" } });
  const plans = plansOf(env.store.db, /from agent_threads t/, () => expect(env.agentStore.latestOpenManagerThread()?.id).toBe(first.id));
  expect(plans[0]).toContain("idx_agent_messages_person");
});

test("the threads with queued mail are found from the threads, not by walking the mailbox", () => {
  const env = freshStoresEnv("md-plans-queued-mail-");
  const thread = env.agentStore.createManagerThread("Mail");
  env.agentStore.enqueueMailboxMessage({ threadId: thread.id, role: "user", source: "thread-notice", content: { type: "text", text: "a report" }, triggerTurn: true });
  const [plan] = plansOf(env.store.db, /from agent_mailbox|agent_mailbox m/, () => expect(env.agentStore.listThreadIdsWithQueuedMailboxMessages()).toEqual([thread.id]));
  expect(plan).not.toMatch(/SCAN (m|agent_mailbox)\b/);
  expect(plan).toContain("idx_agent_mailbox_thread_status");
});

test("threads with queued mail come in the order of each one's first queued message, ties by that message's id", () => {
  const env = freshStoresEnv("md-plans-queued-order-");
  const a = env.agentStore.createManagerThread("A");
  const b = env.agentStore.createManagerThread("B");
  const mail = env.store.db.prepare(`insert into agent_mailbox (id, thread_id, role, source, content, trigger_turn, status, created_at)
    values (?, ?, 'user', 'thread-notice', '{"type":"text","text":"x"}', 1, 'queued', ?)`);
  const at = "2026-11-02T10:00:00.000Z";
  mail.run("mbx_Z", a.id, at);
  mail.run("mbx_M", b.id, at);
  mail.run("mbx_A", a.id, "2026-11-02T10:00:01.000Z");
  expect(env.agentStore.listThreadIdsWithQueuedMailboxMessages()).toEqual([b.id, a.id]);
  // A thread's first message is the one written first, even at the same
  // time as a later one with a smaller id.
  env.store.db.exec("delete from agent_mailbox");
  mail.run("mbx_Z", a.id, at);
  mail.run("mbx_M", b.id, at);
  mail.run("mbx_A", a.id, at);
  expect(env.agentStore.listThreadIdsWithQueuedMailboxMessages()).toEqual([b.id, a.id]);
});

test("deleting a thread clears its calls' words through the scope index, not a walk of every call", () => {
  const env = freshStoresEnv("md-plans-delete-calls-");
  const thread = env.agentStore.createManagerThread("Old");
  const call = env.store.startLlmCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: thread.id, provider: "mock", model: "mock", requestJson: { messages: ["hello"] } });
  env.store.finishLlmCall(call.id, { status: "succeeded", inputTokens: 10, outputTokens: 1});
  // A call recorded with the thread's id and no kind of scope is cleared too.
  const bare = env.store.startLlmCall({ purpose: "agent_wake_step", scopeId: thread.id, provider: "mock", model: "mock", requestJson: { messages: ["hi"] } });
  env.store.finishLlmCall(bare.id, { status: "succeeded", inputTokens: 10, outputTokens: 1});
  env.agentStore.archiveThread(thread.id);
  const deletion = new ThreadDeletion({ db: env.store.db, agentStore: env.agentStore, canvases: { delete: () => null }, dataDir: env.dir });
  const [plan] = plansOf(env.store.db, /update llm_calls/, () => expect(deletion.delete(thread.id).ok).toBe(true));
  expect(plan).not.toMatch(/SCAN llm_calls\b/);
  expect(env.store.db.prepare("select request_json from llm_calls where scope_id = ?").all(thread.id)).toEqual([{ request_json: null }, { request_json: null }]);
});

test("the cache verdicts of a window read the window's calls by time, not every thread call", () => {
  const env = freshStoresEnv("md-plans-verdicts-");
  const [plan] = plansOf(env.store.db, /from llm_calls/, () => loadWindowVerdicts(env.store.db, new Date(Date.now() - 8 * 3600_000).toISOString()));
  expect(plan).toMatch(/created_at>\?/);
  expect(plan).not.toContain("(scope_type=?)");
});

test("a memory's dream actions are looked up by the memory, not by walking every action", async () => {
  const env = freshStoresEnv("md-plans-dream-actions-");
  const provider = new LocalMemoryProvider(env.store.db);
  const entry = await provider.remember({ scope: "user", type: "preference", source: "agent", content: "Replies stay short." });
  const [history] = plansOf(env.store.db, /from memory_dream_actions/, () => memoryEntryHistory(env.store.db, entry.id));
  expect(history).not.toMatch(/SCAN memory_dream_actions\b/);
  const actionsOn = (MemoryDreamer.prototype as unknown as { actionsOn(this: unknown, id: string): unknown }).actionsOn;
  const [dream] = plansOf(env.store.db, /from memory_dream_actions/, () => actionsOn.call({ options: { db: env.store.db } }, entry.id));
  expect(dream).not.toMatch(/SCAN memory_dream_actions\b/);
});

test("a memory's dream actions written in the same millisecond keep the order they were written in", async () => {
  const env = freshStoresEnv("md-plans-dream-order-");
  const provider = new LocalMemoryProvider(env.store.db);
  const kept = await provider.remember({ scope: "user", type: "preference", source: "agent", content: "Replies stay short." });
  const folded = await provider.remember({ scope: "user", type: "preference", source: "agent", content: "Keep replies brief." });
  const at = "2026-11-02T10:00:00.000Z";
  env.store.db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at) values ('run_1', 'test', 'succeeded', 'done', ?)").run(at);
  const act = env.store.db.prepare(`insert into memory_dream_actions (id, run_id, action_type, status, memory_id, target_memory_id, reason, created_at)
    values (?, 'run_1', ?, 'applied', ?, ?, ?, ?)`);
  // One batch: the duplicate folded into the kept memory, then the kept one updated.
  act.run("act_z", "merge", folded.id, kept.id, "same rule", at);
  act.run("act_a", "update", kept.id, null, "clearer", at);
  const actionsOn = (MemoryDreamer.prototype as unknown as { actionsOn(this: unknown, id: string): Array<{ actionType: string }> }).actionsOn;
  expect(actionsOn.call({ options: { db: env.store.db } }, kept.id).map((a) => a.actionType)).toEqual(["merge", "update"]);
  const dreamed = memoryEntryHistory(env.store.db, kept.id)!.events.filter((event) => event.at === at).map((event) => event.detail);
  expect(dreamed).toEqual(["same rule", "clearer"]);
});

// Deleting a thread finds a worker's canvases through their scope index.
test("deleting a thread finds a worker's canvases through an index", () => {
  const env = freshStoresEnv("md-plans-canvas-delete-");
  const plan = (env.store.db.prepare("explain query plan select id from canvas_documents where thread_id in ('t1') or (scope = 'worker' and scope_id in ('f1'))").all() as Array<{ detail: string }>).map((row) => row.detail);
  expect(plan.some((detail) => detail.includes("idx_canvas_documents_scope_updated"))).toBe(true);
});

test("the Activity log's filter options are read from indexes, never from the calls table itself", () => {
  const env = freshStoresEnv("md-plans-filter-options-");
  noStats(env);
  const db = env.store.db;
  const now = "2026-11-02T10:00:00.000Z";
  db.prepare(`insert into llm_calls (id, purpose, status, started_at, created_at, updated_at, provider, provider_name, model)
    values ('call_1', 'agent_step', 'finished', ?, ?, ?, 'openai', 'gateway', 'gpt-5.5')`).run(now, now, now);
  const plans = plansOf(db, /from llm_calls/, () => expect(listActivityFilterOptions(db)).toEqual({
    models: [{ provider: "gateway", model: "gpt-5.5" }],
    purposes: ["agent_step"]
  }));
  // The table holds every call's payloads: a read of it is the whole table from disk.
  expect(plans.map((plan) => plan.match(/SCAN llm_calls( USING COVERING INDEX \w+)?/)?.[0] ?? plan))
    .toEqual(["SCAN llm_calls USING COVERING INDEX idx_llm_calls_models", "SCAN llm_calls USING COVERING INDEX idx_llm_calls_purpose_created"]);
});

// A provider with few calls is found through the provider index, not by
// walking every call newest first until the page fills (a provider with ten
// calls among two hundred thousand read them all). A busy one keeps the walk
// in time order: through the provider index its calls would all be sorted to
// show twenty.
test("the Logs provider filter reads a rare provider through its index and a busy one in time order", () => {
  const env = freshStoresEnv("md-plans-provider-filter-");
  noStats(env);
  const db = env.store.db;
  const insert = db.prepare(`insert into llm_calls (id, purpose, scope_type, scope_id, provider, provider_name, model, status, started_at, created_at, updated_at)
    values (?, 'agent_wake_step', 'agent_thread', 't', ?, ?, 'model-a', 'succeeded', ?, ?, ?)`);
  db.transaction(() => {
    for (let i = 0; i < 5_000; i++) {
      const at = new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 1000).toISOString();
      insert.run(`busy_${i}`, "openai", "busy", at, at, at);
    }
    const at = "2026-09-01T00:00:00.000Z";
    insert.run("rare_1", "openai", "rare", at, at, at);
    insert.run("rare_2", "openai", "rare", at, at, at);
  })();
  const rare = plansOf(db, /from llm_calls/, () => expect(env.store.listLlmCallSummaries(20, { provider: "rare" }).map((c) => c.id).sort()).toEqual(["rare_1", "rare_2"]));
  expect(rare.at(-1)).toContain("idx_llm_calls_models");
  const busy = plansOf(db, /order by created_at desc/, () => expect(env.store.listLlmCallSummaries(20, { provider: "busy" })).toHaveLength(20));
  expect(busy.at(-1)).toContain("idx_llm_calls_created");
  expect(busy.at(-1)).not.toContain("TEMP B-TREE");
});

test("re-pricing clears a connection's calls window by window, by rowid, though an index leads with the connection", () => {
  const env = freshStoresEnv("md-plans-reprice-");
  noStats(env);
  const db = env.store.db;
  const url = "https://fill.example.test/v1";
  const connection = (extra: Partial<ProviderConfig> = {}): ProviderConfig =>
    ({ type: "openai-compatible", baseURL: url, apiKey: "", models: [{ id: "m1", input: ["text"] }], ...extra });
  let providers: Record<string, ProviderConfig> = { fill: connection() };
  const catalog = createPriceCatalog({ litellm: null, modelsDev: { date: "2026-10-22", plans: [], providers: [{ id: "fill", name: "Fill", api: url, models: [{ id: "m1", rates: { base: { input: 1, output: 2 } } }] }] } });
  const pass = new PricingPass({ db, data: { catalog: () => catalog }, providers: () => providers, clearWindow: 100, clearBatchesPerTick: 1 });
  const at = "2026-10-21T00:00:00.000Z";
  db.prepare(`insert into llm_calls (id, purpose, provider, model, base_url, provider_name, status, started_at, created_at, updated_at, input_tokens, output_tokens)
    values ('llm_1', 'agent_wake_step', 'openai-compatible', 'm1', ?, 'fill', 'succeeded', ?, ?, ?, 1000, 0)`).run(url, at, at, at);
  pass.tick();
  pass.tick();
  const clears = (change: () => void) => {
    change();
    return plansOf(db, /update llm_calls set cost_source = null/, () => pass.tick());
  };
  // A model's price, then the whole connection's billing.
  const plans = [
    ...clears(() => { providers = { fill: connection({ models: [{ id: "m1", input: ["text"], price: { input: 5, output: 5 } }] }) }; }),
    ...clears(() => { providers = { fill: connection({ billing: "free", models: [{ id: "m1", input: ["text"], price: { input: 5, output: 5 } }] }) }; })
  ];
  expect(plans.length).toBe(2);
  expect(plans.map((plan) => plan.includes("USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)"))).toEqual([true, true]);
});

test("after a price data change, the Unpriced calls are read through their own index, not a walk of every call", () => {
  const env = freshStoresEnv("md-plans-reprice-");
  const db = env.store.db;
  const url = "https://fill.example.test/v1";
  const providers: Record<string, ProviderConfig> = { fill: { type: "openai-compatible", baseURL: url, apiKey: "", models: [{ id: "m1", input: ["text"] }] } };
  const catalogOf = (date: string, ids: string[]) => createPriceCatalog({
    litellm: null,
    modelsDev: { date, plans: [], providers: [{ id: "fill", name: "Fill", api: url, models: ids.map((id) => ({ id, rates: { base: { input: 1, output: 2 } } })) }] }
  });
  let catalog = catalogOf("2026-10-22", ["m1"]);
  const now = Date.UTC(2026, 10, 3);
  const pass = new PricingPass({ db, data: { catalog: () => catalog }, providers: () => providers, now: () => now });
  const insert = db.prepare(`insert into llm_calls (id, purpose, provider, model, base_url, provider_name, status, started_at, created_at, updated_at, input_tokens, output_tokens)
    values (?, 'agent_wake_step', 'openai-compatible', ?, ?, 'fill', 'succeeded', ?, ?, ?, 1000, 0)`);
  for (let i = 0; i < 50; i += 1) {
    const at = new Date(now - (i + 1) * 3_600_000).toISOString();
    insert.run(`llm_${i}`, i % 10 === 0 ? "zz" : "m1", url, at, at, at);
  }
  pass.tick();
  catalog = catalogOf("2026-10-23", ["m1", "zz"]);
  const plans = plansOf(db, /where cost_source = 'unpriced'/, () => pass.tick());
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) {
    expect(plan).toContain("USING INDEX idx_llm_calls_unpriced_recorded");
    expect(plan).not.toMatch(/SCAN llm_calls\b/);
  }
  expect((db.prepare("select count(*) n from llm_calls where cost_source = 'unpriced'").get() as { n: number }).n).toBe(0);
});

/** Makes the (thread_id, seq) index unique last, after every other index of
 *  the table, as an upgrade from an older schema can leave it (SQLite weighs
 *  indexes alike in the order they were made). */
function seqIndexMadeLast(env: Env): void {
  env.store.db.exec("drop index idx_agent_messages_thread_seq; create unique index idx_agent_messages_thread_seq on agent_messages(thread_id, seq)");
}

for (const [label, prepare] of [["a new database", (_env: Env) => {}], ["a database whose seq index came last", seqIndexMadeLast]] as const) {
  test(`${label}: what a person last wrote, and a thread's latest summary, are read through their own indexes`, () => {
    const env = freshStoresEnv("md-plans-person-");
    noStats(env);
    prepare(env);
    const agent = env.agentStore;
    const thread = agent.createManagerThread("Release");
    const said = agent.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "ship it" } });
    agent.appendMessage({ threadId: thread.id, role: "user", source: "compression", content: { type: "summary", summary: "before", replacedRange: [1, 1], replacedCount: 1, compactedCount: 1, retained: [] } });
    const later = agent.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "shipping" } });
    const plans = [
      ...plansOf(env.store.db, /from agent_messages/, () => expect(agent.latestPersonMessageSeq(thread.id)).toBe(said.seq)),
      ...plansOf(env.store.db, /from agent_messages/, () => expect(agent.latestPersonMessageBefore(thread.id, later.seq)?.id).toBe(said.id)),
      ...plansOf(env.store.db, /from agent_messages/, () => expect(agent.newestUserStatement(thread.id, () => true).said?.text).toBe("ship it")),
      ...plansOf(env.store.db, /from agent_messages/, () => expect(agent.latestOpenManagerThread()?.id).toBe(thread.id)),
      ...plansOf(env.store.db, /from agent_messages/, () => expect(agent.textsBefore(thread.id, "own", "9999", 5).map((t) => t.text)).toEqual(["ship it"])),
      ...plansOf(env.store.db, /from agent_messages/, () => expect(agent.textsBefore(thread.id, "relayed", "9999", 5)).toEqual([]))
    ];
    for (const plan of plans) expect(plan).toContain("idx_agent_messages_person");
    // A walk back from the newest message reads the thread's own range,
    // newest first, with no sort over the thread.
    const walk = plansOf(env.store.db, /from agent_messages m/, () => agent.forEachNewestFirst(thread.id, () => false, { afterSeq: 0, roles: ["assistant"] }));
    for (const plan of walk) {
      expect(plan).toContain("idx_agent_messages_thread_seq");
      expect(plan).not.toContain("TEMP B-TREE");
    }
    const window = plansOf(env.store.db, /source = 'compression'/, () => agent.getActiveMessages(thread.id));
    for (const plan of window) expect(plan).toContain("idx_agent_messages_compression");
  });
}

test("a thread's context figure is read from its last measured turn through an index, not by sorting every turn, in new and existing databases", () => {
  for (const existing of [false, true]) {
    const env = freshStoresEnv("md-plans-context-usage-");
    const db = env.store.db;
    if (existing) {
      // An existing database gets the index at start, after all the others.
      db.exec("drop index idx_agent_wakes_context_usage");
      initializeAgentSchema(db);
    }
    const thread = env.agentStore.getOrCreateThread("worker", "wkr-plans-context");
    const wake = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    env.agentStore.updateWakeTokenUsage(wake.id, 42, 42);
    const [plan] = plansOf(db, /from agent_wakes/, () => expect(env.agentStore.getContextUsage(thread.id, 1000).inputTokens).toBe(42));
    expect(plan).toContain("idx_agent_wakes_context_usage (thread_id=?)");
    expect(plan).not.toContain("TEMP B-TREE");
  }
});

test("the Memory page's run list reads its newest runs in order through an index, and only their actions, in new and existing databases", () => {
  for (const existing of [false, true]) {
    const env = freshStoresEnv("md-plans-dream-runs-");
    const db = env.store.db;
    if (existing) {
      db.exec("drop index idx_memory_dream_runs_recent");
      initializeMemorySchema(db);
    }
    db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at) values ('run_1', 'test', 'running', 'user', '2026-11-01T10:00:00.000Z')").run();
    const [plan] = plansOf(db, /from memory_dream_runs/, () => expect(listMemoryDreamRuns(db, 20).map((r) => r.id)).toEqual(["run_1"]));
    expect(plan).toContain("SCAN memory_dream_runs USING INDEX idx_memory_dream_runs_recent");
    expect(plan).toContain("SEARCH a USING INDEX idx_memory_dream_actions_run (run_id=?)");
    expect(plan).not.toContain("sqlite_autoindex_memory_dream_runs_1");
    // The actions are counted on their own: a run's row (its step log
    // with it) is never copied into a grouping once per action.
    expect(plan).not.toContain("TEMP B-TREE FOR GROUP BY");
  }
});

test("a plan's state is read through its status index, and a step is placed through ranges of its order, never by walking the plan", () => {
  const env = freshStoresEnv("md-plans-plan-steps-");
  noStats(env);
  const projectId = seedProject(env.projects);
  const workerId = seedWorker(env.workers, projectId);
  const plans = new PlanStore(env.store.db);
  plans.update(workerId, { steps: [{ title: "a" }, { title: "b", status: "done", note: "ok" }, { title: "c" }] });
  const [open] = plansOf(env.store.db, /status in \('pending'/, () => plans.stateOf(workerId));
  expect(open).toContain("idx_worker_plan_steps_status (status=? AND worker_id=?)");
  const placing = plansOf(env.store.db, /from worker_plan_steps (indexed by idx_worker_plan_steps_order\s+)?where worker_id = \? and position|order by position desc limit 2/, () => {
    plans.update(workerId, { steps: [{ title: "d", after: 1 }, { id: 3, after: 1 }, { title: "e" }] });
  });
  for (const plan of placing) {
    expect(plan).toContain("idx_worker_plan_steps_order (worker_id=?");
    expect(plan).not.toContain("SCAN");
  }
});

/** A user memory and a project memory, with a brief for each of them. */
async function memoriesWithBriefs(env: Env, projectId: string) {
  const provider = new LocalMemoryProvider(env.store.db, { embedder: { model: "test", embed: async () => [1, 0] } });
  await provider.remember({ scope: "user", type: "preference", source: "agent", content: "Replies stay short." });
  await provider.remember({ scope: "project", projectId, type: "knowledge", source: "agent", content: "Export API is rows-only." });
  provider.putBrief({ scope: "user", projectId: null, content: "user brief", inputDigest: "older", builtAt: "2026-10-20T00:00:00.000Z" });
  provider.putBrief({ scope: "project", projectId, content: "project brief", inputDigest: "older", builtAt: "2026-10-20T00:00:00.000Z" });
  return provider;
}

// A tick asks of every partition whether its memories changed since its
// brief and whether any are left: a digest of ids and times, and a yes or
// no. Both come from the index, never from the memories' text.
test("a dream tick learns what changed from the index alone", async () => {
  {
    const env = freshStoresEnv("md-plans-dream-tick-");
    const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
    const provider = await memoriesWithBriefs(env, projectId);
    const dreamer = new MemoryDreamer({ db: env.store.db, memory: new MemoryManager(provider), agentStore: env.agentStore, records: new WorkerRecordStore(env.store.db), projectsStore: env.projects, contextLimitTokens: 200_000, candidates: [{ model: createMockLLM([]), provider: "openai" }] });
    const plans = plansOf(env.store.db, /from memory_entries/, () => {
      expect(dreamer.needsRun({ kind: "user" })).toBe(true);
      expect(dreamer.needsRun({ kind: "project", projectId })).toBe(true);
      expect(dreamer.unusedSinceBrief({ kind: "project", projectId })).toBe(Date.parse("2026-10-20T00:00:00.000Z"));
    });
    for (const plan of plans) expect(plan).toContain("USING COVERING INDEX idx_memory_entries_listing");
  }
});

// Every search first asks which stored vectors changed: the embeddings' and
// the memories' indexes answer it, without a memory row read.
test("the vector cache learns which vectors changed from the indexes alone", async () => {
  {
    const env = freshStoresEnv("md-plans-vector-stamps-");
    const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
    const provider = await memoriesWithBriefs(env, projectId);
    const plans = plansOf(env.store.db, /^(?![\s\S]*vector_json)[\s\S]*as revision[\s\S]*memory_entries/, () => expect(provider.availableVectors()?.size).toBe(2));
    for (const plan of plans) {
      expect(plan).toContain("USING COVERING INDEX idx_memory_entries_listing");
      expect(plan).toContain("USING COVERING INDEX idx_memory_embeddings_revision");
    }
  }
});

// The vector lane scores every visible memory; the ranking needs each one's
// id and time, from the indexes. Only what it returns is read in full.
test("a search's vector lane ranks from the indexes alone", async () => {
  const env = freshStoresEnv("md-plans-vector-lane-");
  const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const provider = await memoriesWithBriefs(env, projectId);
  let found: string[] = [];
  const plans = await plansOfAsync(env.store.db, /memory_embeddings me\b/, async () => {
    found = (await provider.search({ query: "rows", maxResults: 5 })).map((r) => r.entry.content);
  });
  expect(found).toContain("Export API is rows-only.");
  for (const plan of plans) {
    expect(plan).toContain("USING COVERING INDEX idx_memory_entries_listing");
    expect(plan).toContain("USING COVERING INDEX idx_memory_embeddings_revision");
  }
});

// What an extraction window is shown as recent: the last two days', no
// tasks. A project's are bounded by time in the index's seek; the user's
// (no project to seek past) are passed over in the index, which holds their
// time and type, before any row is read.
test("the recent memories an extraction is shown are bounded by time in the index", async () => {
  const env = freshStoresEnv("md-plans-recent-memories-");
  const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const provider = await memoriesWithBriefs(env, projectId);
  const plans = plansOf(env.store.db, /from memory_entries/, () =>
    expect(recentMemoriesFor(new MemoryManager(provider), [{ id: projectId, name: "project-1" }], Date.now()).map((e) => e.content).sort())
      .toEqual(["Export API is rows-only.", "Replies stay short."]));
  expect(plans).toHaveLength(2);
  for (const plan of plans) expect(plan).toContain("USING INDEX idx_memory_entries_listing");
  expect(plans[1]).toContain("updated_at>?");
});
