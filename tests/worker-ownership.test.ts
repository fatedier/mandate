import { expect, test } from "bun:test";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { ensureOpenOwner, ownerRefusal } from "../src/server/modules/workers/ownership.js";
import { buildWorkerMessageSendTool } from "../src/server/modules/agent/tools/worker-message-tools.js";
import { buildWorkItemTools } from "../src/server/modules/agent/tools/work-item-tools.js";
import { buildListWorkersTool } from "../src/server/modules/workers/tools/list-workers.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { toolContext } from "./helpers/typed.js";

function setup(prefix: string) {
  const e = freshStoresEnv(prefix);
  const projectId = seedProject(e.projects, { name: "project-1" });
  const a = e.agentStore.createManagerThread("project-1 3.21 release");
  const b = e.agentStore.createManagerThread("Sidebar");
  const workerId = seedWorker(e.workers, projectId, { name: "pr-33" });
  e.workers.setOwner(workerId, a.id);
  const ctx = (threadId: string) => toolContext({ threadId, wakeId: "wk" });
  return { ...e, projectId, a, b, workerId, ctx };
}

test("workers store: owner is stored, read back, and listed by owner", () => {
  const s = setup("md-own-store-");
  expect(s.workers.getById(s.workerId)?.ownerThreadId).toBe(s.a.id);
  expect(s.workers.listActiveOwnedBy(s.a.id).map((f) => f.id)).toEqual([s.workerId]);
  expect(s.workers.listActiveOwnedBy(s.b.id)).toEqual([]);
  s.workers.archive(s.workerId);
  expect(s.workers.listActiveOwnedBy(s.a.id)).toEqual([]);
});

test("ownerRefusal: the owner passes; another thread is told whose it is", () => {
  const s = setup("md-own-refuse-");
  expect(ownerRefusal({ workersStore: s.workers, agentStore: s.agentStore }, s.workerId, s.a.id)).toBe(null);
  expect(ownerRefusal({ workersStore: s.workers, agentStore: s.agentStore }, s.workerId, s.b.id))
    .toBe('Worker "pr-33" belongs to the thread "project-1 3.21 release". Ask the user to continue there.');
});

test("message_worker refuses another thread's worker and sends to its own", async () => {
  const s = setup("md-own-msg-");
  const tool = buildWorkerMessageSendTool({ agentStore: s.agentStore, workersStore: s.workers, wakeScheduler: { wake: () => "wk" } });
  expect(await tool.handler({ workerId: s.workerId, message: "go" }, s.ctx(s.b.id)))
    .toEqual({ error: 'Worker "pr-33" belongs to the thread "project-1 3.21 release". Ask the user to continue there.' });
  expect((await tool.handler({ workerId: s.workerId, message: "go" }, s.ctx(s.a.id))).status).toBe("started");
});

test("dismiss_work_item refuses another thread's worker and clears its own's questions", async () => {
  const s = setup("md-own-wi-");
  const workStore = new WorkItemStore(s.store.db);
  const planStore = new PlanStore(s.store.db);
  planStore.update(s.workerId, { openQuestions: ["Tag the release?"], steps: [{ title: "Tag" }] });
  const [dismiss] = buildWorkItemTools({ workStore, sse: new AgentSseEmitter(), workersStore: s.workers, agentStore: s.agentStore, planStore });
  const id = workStore.getByWorker(s.workerId)!.id;
  const refusal = { error: 'Worker "pr-33" belongs to the thread "project-1 3.21 release". Ask the user to continue there.' };
  expect(await dismiss!.handler({ id }, s.ctx(s.b.id))).toEqual(refusal);
  expect(planStore.get(s.workerId).openQuestions).toEqual(["Tag the release?"]);
  expect(await dismiss!.handler({ id }, s.ctx(s.a.id))).toEqual({ ok: true });
  expect(planStore.get(s.workerId).openQuestions).toEqual([]);
});

test("list_workers names each worker's thread and marks the caller's own", async () => {
  const s = setup("md-own-list-");
  const tool = buildListWorkersTool({ workersStore: s.workers, projectsStore: s.projects, agentStore: s.agentStore });
  const other = await tool.handler({}, s.ctx(s.b.id));
  expect(other.workers[0]).toMatchObject({ id: s.workerId, ownerThreadId: s.a.id, ownerThreadTitle: "project-1 3.21 release", yours: false });
  const mine = await tool.handler({}, s.ctx(s.a.id));
  expect(mine.workers[0]!.yours).toBe(true);
});

test("ensureOpenOwner: keeps a usable owner, takes a usable preferred one, else opens a thread named after the worker", () => {
  const s = setup("md-own-ensure-");
  const deps = { workersStore: s.workers, agentStore: s.agentStore };
  expect(ensureOpenOwner(deps, s.workerId)).toEqual({ ownerThreadId: s.a.id, changed: false });
  expect(ensureOpenOwner(deps, s.workerId, s.b.id)).toEqual({ ownerThreadId: s.b.id, changed: true });
  // A stale or non-manager preferred id is ignored.
  const worker = s.agentStore.getOrCreateThread("worker", s.workerId);
  expect(ensureOpenOwner(deps, s.workerId, worker.id)).toEqual({ ownerThreadId: s.b.id, changed: false });
  s.agentStore.archiveThread(s.b.id);
  const r = ensureOpenOwner(deps, s.workerId, "thr_missing")!;
  expect(r.changed).toBe(true);
  expect(s.agentStore.getThreadById(r.ownerThreadId)?.title).toBe("pr-33");
  expect(s.workers.getById(s.workerId)?.ownerThreadId).toBe(r.ownerThreadId);
});

test("setOwner announces the worker as changed, so its new owner's sweep arms", () => {
  const s = setup("md-own-event-");
  const seen: string[] = [];
  s.workers.onWorkItemChange((e) => seen.push(`${e.kind}:${e.workerId}`));
  s.workers.setOwner(s.workerId, s.b.id);
  expect(seen).toStrictEqual([`updated:${s.workerId}`]);
});
