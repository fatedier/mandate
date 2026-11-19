import { join } from "node:path";
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, seedWorker, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { ManagerThreadService } from "../src/server/modules/agent/manager-threads.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { readBuiltin, type PageBuiltinDeps } from "../src/server/modules/page/page-builtins.js";
import { ScheduleStore } from "../src/server/modules/schedules/schedule-store.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { mountPageRoutes } from "../src/server/modules/page/page-routes.js";
import { API_PATHS, API_ROUTES } from "../src/shared/api-contracts.js";
import { preparedByAsync } from "./helpers/sql-watch.js";

let env: StoresEnv | null = null;

/** A thread with a worker whose plan is done and one that asks, a canvas, a
 *  question the personal agent asked, and a day of model calls. */
function seeded() {
  env = freshStoresEnv("md-page-builtins-");
  const workStore = new WorkItemStore(env.store.db);
  const planStore = new PlanStore(env.store.db);
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const thread = env.agentStore.createManagerThread("Docs overhaul");
  const projectId = seedProject(env.projects, { name: "mandate", workingDir: "/tmp/m", tmuxSessionName: "m" });
  const release = seedWorker(env.workers, projectId, { name: "release", ownerThreadId: thread.id });
  expect(planStore.update(release, { conclusion: "Tagged 3.21; the changelog is written.", steps: [{ title: "Tag", status: "done", note: "git tag v3.21 pushed" }] })).toMatchObject({ ok: true });
  const evict = seedWorker(env.workers, projectId, { name: "evict", tmuxWindowName: "evict", ownerThreadId: thread.id });
  expect(planStore.update(evict, { steps: [{ title: "Wire the hook", status: "in_progress" }] })).toMatchObject({ ok: true });
  // A second thread, whose worker failed.
  const cacheThread = env.agentStore.createManagerThread("Cache work");
  const cache = seedWorker(env.workers, projectId, { name: "cache", tmuxWindowName: "cache", ownerThreadId: cacheThread.id });
  workStore.setFailure(cache, { at: new Date().toISOString(), message: "The provider refused the request.", kind: "error" });
  const older = canvasStore.create({ title: "Old notes", scope: "manager", scopeId: null, threadId: thread.id, kind: "report" });
  env.store.db.prepare("update canvas_documents set updated_at = '2026-01-01T00:00:00.000Z' where id = ?").run(older.id);
  const canvas = canvasStore.create({ title: "Cache report", scope: "manager", scopeId: null, threadId: thread.id, kind: "report" });
  const personal = env.agentStore.getOrCreatePersonalThread();
  env.agentStore.appendMessage({
    threadId: personal.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c1", toolName: "ask_user", result: { asked: true, questionId: "q_ab12cd", question: "Tag 3.21 today?", options: [] } }
  });
  const call = env.store.startLlmCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: thread.id, provider: "openai", model: "gpt-5.5", requestJson: {} });
  env.store.finishLlmCall(call.id, { status: "succeeded", responseJson: {}, outputJson: {}, inputTokens: 1200, outputTokens: 30});
  const deps: PageBuiltinDeps = {
    db: env.store.db,
    agentStore: env.agentStore,
    managerThreads: new ManagerThreadService({ agentStore: env.agentStore }),
    canvasStore,
    workersStore: env.workers,
    projectsStore: env.projects,
    workStore,
    planStore,
    isBusy: () => false,
    waitKind: () => null,
    statusSnapshot: () => ({
      threads: [{ threadId: thread.id, state: "decision" }, { threadId: cacheThread.id, state: "failed" }],
      waiting: [
        { key: "agent:agent:input", kind: "agent", waiting: "input", threadId: null, threadTitle: null, workerId: null, workerName: null, text: "Tag 3.21 today?", place: null },
        { key: `thread:${cacheThread.id}:failed`, kind: "thread", waiting: "failed", threadId: cacheThread.id, threadTitle: "Cache work", workerId: null, workerName: null, text: "The provider refused the request.", place: null },
        { key: `worker:${evict}:input`, kind: "worker", waiting: "input", threadId: thread.id, threadTitle: "Docs overhaul", workerId: evict, workerName: "evict", text: "Wire it now?", place: null },
        { key: `thread:${thread.id}:decision`, kind: "thread", waiting: "decision", threadId: thread.id, threadTitle: "Docs overhaul", workerId: null, workerName: null, text: "**Two options**: keep or drop.", place: null }
      ]
    })
  };
  return { deps, thread, release, evict, canvas, personal, cacheThread, cache, older };
}

test("each built-in has the agent-page skill's field names, from what Mandate shows elsewhere", async () => {
  const { deps, thread, release, evict, canvas, cacheThread, cache, older } = seeded();
  const threads = readBuiltin("threads", deps) as Array<Record<string, unknown>>;
  expect(threads.find((t) => t.id === thread.id)).toEqual(
    { id: thread.id, title: "Docs overhaul", state: "decision", lastActivityAt: expect.any(String), link: `/threads/${thread.id}` }
  );
  // The state the server worked out, the one the sidebar draws.
  expect(threads.find((t) => t.id === cacheThread.id)).toMatchObject({ state: "failed" });
  const workers = readBuiltin("workers", deps) as Array<Record<string, unknown>>;
  for (const worker of workers) expect(Object.keys(worker).sort()).toEqual(["id", "line", "link", "name", "state", "threadId"]);
  expect(workers.find((w) => w.id === cache)).toMatchObject({ state: "failed", line: "Failed: The provider refused the request." });
  expect(workers.find((w) => w.id === release)).toEqual({
    id: release, name: "release", threadId: thread.id, state: "done", line: "Tagged 3.21; the changelog is written.",
    link: `/threads/${thread.id}?worker=${release}`
  });
  expect(workers.find((w) => w.id === evict)).toMatchObject({ state: "in_progress", line: expect.stringContaining("Wire the hook") });
  // Home's list, its kind carried as data; the personal agent's own question is its "questions" source.
  expect(readBuiltin("waiting", deps)).toEqual([
    { waiting: "failed", title: "Cache work", text: "The provider refused the request.", link: `/threads/${cacheThread.id}` },
    { waiting: "input", title: "Docs overhaul", text: "Wire it now?", link: `/threads/${thread.id}?worker=${evict}` },
    { waiting: "decision", title: "Docs overhaul", text: "**Two options**: keep or drop.", link: `/threads/${thread.id}` }
  ]);
  const usage = await readBuiltin("usage", deps) as { days: Array<Record<string, unknown>> };
  expect(usage.days).toEqual([{ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), inputTokens: 1200, outputTokens: 30, cacheReadTokens: 0, calls: 1 }]);
  // Newest first.
  expect(readBuiltin("canvases", deps)).toEqual([
    { id: canvas.id, title: "Cache report", kind: "report", updatedAt: canvas.updatedAt, link: `/canvas/${canvas.id}` },
    { id: older.id, title: "Old notes", kind: "report", updatedAt: "2026-01-01T00:00:00.000Z", link: `/canvas/${older.id}` }
  ]);
  expect(readBuiltin("questions", deps)).toEqual([{ id: "q_ab12cd", question: "Tag 3.21 today?", askedAt: expect.any(String) }]);
  expect(readBuiltin("answers", deps)).toStrictEqual([]);
});

test("a built-in or a listed source is read by its name; anything else is 404", async () => {
  const { deps } = seeded();
  const app = new Hono();
  mountPageRoutes(app, {
    pageStore: new PageStore(env!.store.db),
    builtins: deps,
    sources: {
      list: () => [],
      data: (name) => (name === "soil-sensors" ? { name, value: 3, at: "2026-10-20T00:00:00.000Z", error: null } : null),
      setPaused: () => null,
      remove: () => false
    }
  });
  const threads = await (await app.request(API_PATHS.agentPageData("threads"))).json() as { name: string; value: unknown[]; error: null };
  expect([threads.name, threads.value.length, threads.error]).toEqual(["threads", 2, null]);
  expect(await (await app.request(API_PATHS.agentPageData("soil-sensors"))).json()).toEqual({ name: "soil-sensors", value: 3, at: "2026-10-20T00:00:00.000Z", error: null });
  expect((await app.request(API_PATHS.agentPageData("nope"))).status).toBe(404);
  expect(await (await app.request(API_ROUTES.agentPageSources)).json()).toEqual({ sources: [] });
  const patch = (body: unknown) => app.request(API_PATHS.agentPageSource("soil-sensors"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await patch({ paused: "yes" })).status).toBe(400);
  expect((await patch({ paused: true })).status).toBe(404);
  expect((await app.request(API_PATHS.agentPageSource("soil-sensors"), { method: "DELETE" })).status).toBe(404);
});

test("the usage built-in reads the calls on a thread of its own, not the server's", async () => {
  const { deps } = seeded();
  const prepared = await preparedByAsync(deps.db, async () => {
    const usage = await readBuiltin("usage", deps) as { days: Array<Record<string, unknown>> };
    expect(usage.days).toEqual([{ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), inputTokens: 1200, outputTokens: 30, cacheReadTokens: 0, calls: 1 }]);
  });
  expect(prepared.filter((sql) => /from llm_calls/.test(sql))).toStrictEqual([]);
});

test("the on_duty built-in lists each schedule with its duty thread and its last 7 days", () => {
  const { deps, thread } = seeded();
  const store = new ScheduleStore(env!.store.db);
  const at = "2026-11-08T01:00:00.000Z";
  const sch = store.insert({ threadId: thread.id, name: "greenhouse daily check", cron: "0 9 * * *", timezone: "Asia/Singapore", checkScript: "c", checkTimeoutMs: 60_000, brief: "b", status: "active", nextDueAt: "2026-11-09T01:00:00.000Z" }, at);
  for (const [startedAt, outcome] of [["2026-10-20T01:00:00.000Z", "woke"], ["2026-11-06T01:00:00.000Z", "woke"], ["2026-11-07T01:00:00.000Z", "quiet"]] as const) {
    store.recordRun({ scheduleId: sch.id, threadId: thread.id, dueAt: startedAt, startedAt, finishedAt: startedAt, outcome, exitCode: 0, durationMs: 5, line: "", missed: 0 });
  }
  store.update(sch.id, { lastOutcome: "quiet" }, { at });
  const rows = readBuiltin("on_duty", { ...deps, schedules: { store, now: () => Date.parse(at) } }) as Array<Record<string, unknown>>;
  expect(rows).toEqual([{
    id: sch.id, name: "greenhouse daily check", threadId: thread.id, threadTitle: "Docs overhaul", link: `/threads/${thread.id}`,
    status: "active", cronText: "Daily 09:00", nextDueAt: "2026-11-09T01:00:00.000Z", lastOutcome: "quiet", runs7d: 2, wakes7d: 1
  }]);
  // A schedule whose thread is not open yet (an older version's, at the start): no link.
  const unopened = store.insert({ threadId: "", name: "new watch", cron: "0 9 * * *", timezone: "UTC", checkScript: "c", checkTimeoutMs: 60_000, brief: "b", status: "active", nextDueAt: null }, at);
  const withUnopened = readBuiltin("on_duty", { ...deps, schedules: { store, now: () => Date.parse(at) } }) as Array<Record<string, unknown>>;
  expect(withUnopened.find((r) => r.id === unopened.id)).toMatchObject({ threadId: null, threadTitle: null, link: null, status: "active" });
  expect(readBuiltin("on_duty", deps)).toStrictEqual([]);
});

test("tasks lists the open tasks with their marks, threads and link", () => {
  const { deps, thread } = seeded();
  const board = new TaskBoardService({
    db: env!.store.db, agentStore: env!.agentStore, sse: { emit: () => {} } as never,
    threadDots: () => new Map([[thread.id, "needs_you"]])
  });
  const open = board.create({ title: "Scale recipes per serving", dueDate: "2026-11-20" }, "owner");
  board.setStatus(open.id, "progress", "owner");
  board.addLabel(open.id, "kitchen", "owner");
  board.link(open.id, thread.id);
  board.comment(open.id, "3.21 waits for this.", "owner");
  const closed = board.create({ title: "Done one" }, "owner");
  board.setStatus(closed.id, "done", "owner");
  const gone = board.create({ title: "Deleted" }, "owner");
  board.remove(gone.id);
  const tasks = readBuiltin("tasks", { ...deps, tasks: () => board.list() }) as Array<Record<string, unknown>>;
  expect(tasks).toEqual([{
    // In the agent's words, as its task tool takes them.
    id: open.id, title: "Scale recipes per serving", status: "in progress", dueDate: "2026-11-20", dueTime: null,
    marks: { needsYou: true, failed: false, quiet: false },
    threads: [{ title: "Docs overhaul", dot: "needs_you" }],
    labels: ["kitchen"],
    lastComment: { by: "owner", text: "3.21 waits for this.", at: expect.any(String) },
    result: null,
    link: `/tasks/${open.id}`
  }]);
  expect(readBuiltin("tasks", deps)).toEqual([]);
  const skill = readFileSync(join(import.meta.dir, "../src/server/modules/skills/builtins/agent-page/SKILL.md"), "utf8");
  expect(skill).toContain("- tasks: [{ id, title, status, dueDate, dueTime, marks: { needsYou, failed, quiet }, threads: [{ title, dot }], labels, lastComment, result, link }]; open tasks only; status is todo, in progress or in review; labels are names, automatic ones included.");
});
