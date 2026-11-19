import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, seedProject, seedWorker, type StoresEnv } from "./helpers/fixtures.js";
import { workRanIn } from "../src/server/modules/task-board/work-ran-in.js";
import { deleteJson, postJson } from "./helpers/test-app.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { taskBoardModule } from "../src/server/modules/task-board/module.js";
import type { AppDeps } from "../src/server/app/deps.js";

// A task's labels: free names the owner and the agent add, compared without
// regard to case, at most 40 characters; and the automatic ones, the
// projects its linked threads' workers ran in, first and not removable.

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

/** Where each thread's workers ran, by thread id: filled once the threads exist. */
function setup(prefix: string, ranIn: Map<string, string[]> = new Map()) {
  env = freshStoresEnv(prefix);
  const events: string[] = [];
  let now = Date.parse("2026-11-09T09:00:00.000Z");
  const service = new TaskBoardService({
    db: env.store.db,
    agentStore: env.agentStore,
    sse: { emit: (event: string) => { events.push(event); } } as never,
    threadDots: () => new Map(),
    now: () => now,
    workRanIn: (threadIds) => threadIds.flatMap((id) => ranIn.get(id) ?? [])
  });
  return { env, service, events, advance: (ms: number) => { now += ms; } };
}

const labels = (service: TaskBoardService, id: string) => service.detail(id)!.labels.map((l) => `${l.name}:${l.by}`);

test("labels are added by name, each once whatever its case, and told like any change", () => {
  const { service, events } = setup("md-tbl-add-");
  const task = service.create({ title: "Scale recipes per serving" }, "owner");
  const before = events.length;
  service.addLabel(task.id, "  billing ", "owner");
  service.addLabel(task.id, "BILLING", "owner");
  service.addLabel(task.id, "3.21", "agent");
  expect(labels(service, task.id)).toEqual(["billing:owner", "3.21:agent"]);
  expect(events.length - before).toBe(3);
  // No line in the task's stream for a label.
  expect(service.detail(task.id)!.entries).toEqual([]);
});

test("a name the board has keeps its first spelling on another task", () => {
  const { service } = setup("md-tbl-spell-");
  const a = service.create({ title: "a" }, "owner");
  const b = service.create({ title: "b" }, "owner");
  service.addLabel(a.id, "Billing", "owner");
  service.addLabel(b.id, "billing", "agent");
  expect(labels(service, b.id)).toEqual(["Billing:agent"]);
});

test("the owner adding the agent's label makes it theirs", () => {
  const { service } = setup("md-tbl-own-");
  const task = service.create({ title: "x" }, "owner");
  service.addLabel(task.id, "3.21", "agent");
  service.addLabel(task.id, "3.21", "owner");
  expect(labels(service, task.id)).toEqual(["3.21:owner"]);
});

test("a label is one line of at most 40 characters", () => {
  const { service } = setup("md-tbl-long-");
  const task = service.create({ title: "x" }, "owner");
  expect(() => service.addLabel(task.id, "x".repeat(41), "owner")).toThrow("A label is a word or two: at most 40 characters.");
  expect(() => service.addLabel(task.id, "two\nlines", "owner")).toThrow("A label is a word or two: at most 40 characters.");
  expect(() => service.addLabel(task.id, "   ", "owner")).toThrow("A label is a word or two: at most 40 characters.");
  // No name an address can carry: "." and ".." (see thread-labels.test.ts).
  for (const name of [".", ".."]) expect(() => service.addLabel(task.id, name, "owner")).toThrow("A label is a word or two: at most 40 characters.");
  service.addLabel(task.id, "x".repeat(40), "owner");
  expect(labels(service, task.id)).toEqual([`${"x".repeat(40)}:owner`]);
});

test("removing finds the label whatever its case; one the task does not have is refused", () => {
  const { service } = setup("md-tbl-remove-");
  const task = service.create({ title: "x" }, "owner");
  service.addLabel(task.id, "billing", "agent");
  service.removeLabel(task.id, "Billing");
  expect(labels(service, task.id)).toEqual([]);
  expect(() => service.removeLabel(task.id, "billing")).toThrow('That task has no label "billing".');
});

test("where the linked threads' workers ran shows as automatic labels, first, each once; a hand label of the same name shows once, as automatic", () => {
  const ranIn = new Map<string, string[]>();
  const { service, env } = setup("md-tbl-auto-", ranIn);
  const a = env.agentStore.createManagerThread("Recipe book");
  const b = env.agentStore.createManagerThread("Server billing");
  ranIn.set(a.id, ["acme-recipes", "northwind-server"]);
  ranIn.set(b.id, ["acme-recipes"]);
  const task = service.create({ title: "x" }, "owner");
  service.addLabel(task.id, "billing", "owner");
  service.addLabel(task.id, "ACME-Recipes", "owner");
  expect(labels(service, task.id)).toEqual(["billing:owner", "ACME-Recipes:owner"]);
  service.link(task.id, a.id);
  service.link(task.id, b.id);
  expect(labels(service, task.id)).toEqual(["acme-recipes:auto", "northwind-server:auto", "billing:owner"]);
  // The list's task says the same.
  expect(service.list()[0]!.labels.map((l) => l.name)).toEqual(["acme-recipes", "northwind-server", "billing"]);
});

test("an automatic label cannot be removed, and says why", () => {
  const ranIn = new Map<string, string[]>();
  const { service, env } = setup("md-tbl-auto-remove-", ranIn);
  const thread = env.agentStore.createManagerThread("Recipe book");
  ranIn.set(thread.id, ["acme-recipes"]);
  const task = service.create({ title: "x" }, "owner");
  service.link(task.id, thread.id);
  expect(() => service.removeLabel(task.id, "ACME-Recipes")).toThrow('"acme-recipes" is automatic: it comes from where the task\'s threads ran, and cannot be removed.');
});

test("labels go with their task when it is deleted forever", () => {
  const { service, env } = setup("md-tbl-forever-");
  const task = service.create({ title: "x" }, "owner");
  service.addLabel(task.id, "billing", "owner");
  service.remove(task.id);
  service.deleteForever(task.id);
  const left = env.store.db.prepare("select count(*) as n from task_board_labels").get() as { n: number };
  expect(left.n).toBe(0);
});

test("the owner's routes add and remove a label, answering with the task", async () => {
  env = freshStoresEnv("md-tbl-routes-");
  const taskBoard = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map() });
  const hono = new Hono();
  taskBoardModule.mountRoutes!(hono, { deps: { taskBoard } as unknown as AppDeps, upgradeWebSocket: (() => {}) as never });
  const id = taskBoard.create({ title: "x" }, "owner").id;
  const added = await postJson(hono, `/api/task-board/tasks/${id}/labels`, { name: "billing" });
  expect(added.status).toBe(200);
  expect(added.body.task.labels).toEqual([{ name: "billing", by: "owner" }]);
  const removed = await deleteJson(hono, `/api/task-board/tasks/${id}/labels/${encodeURIComponent("billing")}`);
  expect([removed.status, removed.body.task.labels]).toEqual([200, []]);
  expect((await postJson(hono, `/api/task-board/tasks/${id}/labels`, { name: "x".repeat(41) })).status).toBe(400);
  expect((await deleteJson(hono, `/api/task-board/tasks/${id}/labels/nothing`)).status).toBe(400);
});

test("where work ran: each project its threads' workers ran in, active or archived, once, in the order the workers were made", () => {
  env = freshStoresEnv("md-tbl-ranin-");
  const recipes = seedProject(env.projects, { name: "acme-recipes", tmuxSessionName: "md-tbl-a" });
  const server = seedProject(env.projects, { name: "northwind-server", tmuxSessionName: "md-tbl-b" });
  const a = env.agentStore.createManagerThread("Recipe book");
  const b = env.agentStore.createManagerThread("Server billing");
  const first = seedWorker(env.workers, server, { name: "first", tmuxWindowName: "first", ownerThreadId: a.id });
  const second = seedWorker(env.workers, recipes, { name: "second", tmuxWindowName: "second", ownerThreadId: b.id });
  const third = seedWorker(env.workers, server, { name: "third", tmuxWindowName: "third", ownerThreadId: b.id });
  // Made a minute apart, as workers are: inserts in one millisecond tie.
  for (const [id, at] of [[first, "2026-11-09T08:00:00.000Z"], [second, "2026-11-09T08:01:00.000Z"], [third, "2026-11-09T08:02:00.000Z"]] as const) {
    env.store.db.prepare("update workers set created_at = ? where id = ?").run(at, id);
  }
  env.workers.archive(first);
  const ranIn = workRanIn({ workersStore: env.workers, projectsStore: env.projects });
  expect(ranIn([a.id, b.id])).toEqual(["northwind-server", "acme-recipes"]);
  expect(ranIn([b.id])).toEqual(["acme-recipes", "northwind-server"]);
  expect(ranIn([])).toEqual([]);
});

test("a hand label that has become automatic too is refused removal, and stays for when the thread goes", () => {
  const ranIn = new Map<string, string[]>();
  const { service, env } = setup("md-tbl-shadow-", ranIn);
  const thread = env.agentStore.createManagerThread("Recipe book");
  ranIn.set(thread.id, ["acme-recipes"]);
  const task = service.create({ title: "x" }, "owner");
  service.addLabel(task.id, "acme-recipes", "owner");
  service.link(task.id, thread.id);
  expect(() => service.removeLabel(task.id, "acme-recipes")).toThrow(`"acme-recipes" is automatic: it comes from where the task's threads ran, and cannot be removed.`);
  service.unlink(task.id, thread.id);
  expect(labels(service, task.id)).toEqual(["acme-recipes:owner"]);
});

test("a name the board has only as an automatic label keeps that spelling by hand on another task", () => {
  const ranIn = new Map<string, string[]>();
  const { service, env } = setup("md-tbl-auto-spell-", ranIn);
  const thread = env.agentStore.createManagerThread("Recipe book");
  ranIn.set(thread.id, ["acme-recipes"]);
  const a = service.create({ title: "a" }, "owner");
  service.link(a.id, thread.id);
  const b = service.create({ title: "b" }, "owner");
  service.addLabel(b.id, "ACME-Recipes", "owner");
  expect(labels(service, b.id)).toEqual(["acme-recipes:owner"]);
});
