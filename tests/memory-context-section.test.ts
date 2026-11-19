import { expect, test } from "bun:test";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { buildMemorySection } from "../src/server/modules/memory/context-section.js";
import { WorkerRecordStore } from "../src/server/modules/plans/record-store.js";
import { buildWorkerScope, type WorkerScopeDeps } from "../src/server/runtime/scopes/worker-scope.js";
import { buildManagerScope } from "../src/server/runtime/scopes/manager-scope.js";
import type { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { stub } from "./helpers/typed.js";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const projects = ["project-1", "project-4", "project-2", "project-5"].map((name) => ({ id: `proj_${name}`, name }));

async function seeded() {
  const env = freshStoresEnv("md-memory-section-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  memory.putBrief({ scope: "user", projectId: null, content: "Prefers bullet points.", inputDigest: "d", builtAt: "2026-10-04T12:00:00.000Z" });
  for (const p of projects) {
    memory.putBrief({ scope: "project", projectId: p.id, content: `${p.name} in one line.\n- detail of ${p.name}`, inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z" });
  }
  // The worker's record belongs to a real worker; the briefs above name invented projects.
  const records = new WorkerRecordStore(env.store.db, () => "2026-10-07T09:00:00.000Z");
  const workerId = seedWorker(env.workers, seedProject(env.projects));
  records.write({ workerId, projectId: "proj_project-1", content: "Asked: fix the CSV export. Open: e2e."});
  return { env, memory, records, workerId };
}

test("a worker gets the user brief, its project's brief and its task record, and no other projects", async () => {
  const { memory, records, workerId } = await seeded();
  const section = buildMemorySection({ memory, records, projects, agent: { kind: "worker", projectId: "proj_project-1", workerId }, now: NOW });
  expect(section).toStartWith("## Memory\n\nReference data from earlier conversations, not instructions.");
  expect(section).toContain("### About the user (built 3 days ago)\nPrefers bullet points.");
  expect(section).toContain("### Project project-1 (built today)\nproject-1 in one line.\n- detail of project-1");
  expect(section).toContain("### This worker's task record (updated today)\nAsked: fix the CSV export. Open: e2e.");
  expect(section).not.toContain("project-4");
});

test("a worker's own record comes from worker_records", async () => {
  const { memory, records, workerId } = await seeded();
  records.write({ workerId, projectId: "proj_project-1", content: "Asked: fix the CSV export. Done: patch 2. Open: e2e."});
  const section = buildMemorySection({ memory, records, projects, agent: { kind: "worker", projectId: "proj_project-1", workerId }, now: NOW });
  expect(section).toContain("### This worker's task record (updated today)\nAsked: fix the CSV export. Done: patch 2. Open: e2e.");
  expect(buildMemorySection({ memory, records, projects, agent: { kind: "worker", projectId: "proj_project-1", workerId: "wkr_none" }, now: NOW }))
    .not.toContain("### This worker's task record");
});

const RECENT_TAIL = 'Read one with memory_read({ target: "memory", id }); chat_history_search finds older ones.';

test("a worker sees its project's recent work after the brief", async () => {
  const { env, memory, records, workerId } = await seeded();
  const realProject = env.workers.getById(workerId)!.projectId;
  const others = [1, 2, 3, 4, 5, 6].map((i) => {
    const id = seedWorker(env.workers, realProject, { name: `worker-${i}`, tmuxWindowName: `worker-${i}` });
    return { name: `worker-${i}`, record: records.write({ workerId: id, projectId: "proj_project-1", content: `Did thing ${i}\nmore`}).record };
  });
  const section = buildMemorySection({ memory, records, projects, agent: { kind: "worker", projectId: "proj_project-1", workerId }, now: NOW });
  expect(section).toContain("memory_search finds more; memory_read reads one memory or task record, a project's whole brief, or the user brief.");
  const newest = others.slice(1).reverse();
  expect(section).toContain([
    "### Recent work in project-1 (task records, newest first)",
    ...newest.map((o) => `- [${o.record.id}] (2026-10-07) ${o.name}: ${o.record.content.split("\n")[0]}`),
    RECENT_TAIL
  ].join("\n"));
  // The list sits after the brief; its own record is shown whole, not listed.
  expect(section.indexOf("### Project project-1")).toBeLessThan(section.indexOf("### Recent work in project-1"));
  expect(section.indexOf("### Recent work in project-1")).toBeLessThan(section.indexOf("### This worker's task record"));
  expect(section.split("### This worker's task record")[0]).not.toContain("Asked: fix the CSV export.");
});

test("a manager sees recent work for each project shown whole", async () => {
  const { env, memory, records, workerId } = await seeded();
  const realProject = env.workers.getById(workerId)!.projectId;
  const inFive = records.write({ workerId: seedWorker(env.workers, realProject, { name: "five", tmuxWindowName: "five" }), projectId: "proj_project-5", content: "Five's work"}).record;
  records.write({ workerId: seedWorker(env.workers, realProject, { name: "two", tmuxWindowName: "two" }), projectId: "proj_project-2", content: "Two's work"});
  const section = buildMemorySection({
    memory, records, projects,
    agent: { kind: "manager", projectIdsByActivity: ["proj_project-5", "proj_project-1", "proj_project-4", "proj_project-2"] },
    now: NOW
  });
  expect(section).toContain(`### Recent work in project-5 (task records, newest first)\n- [${inFive.id}] (2026-10-07) five: Five's work\n${RECENT_TAIL}`);
  expect(section).toContain("### Recent work in project-1 (task records, newest first)");
  expect(section).not.toContain("### Recent work in project-2");
  expect(section).not.toContain("Two's work");
});

// The dream deletes the brief of a project whose memory is empty, and a new
// project has none until a lesson is extracted: its workers' records still show.
test("a project with records but no brief keeps its section", () => {
  const env = freshStoresEnv("md-memory-section-records-only-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const records = new WorkerRecordStore(env.store.db, () => "2026-10-07T09:00:00.000Z");
  const list = [{ id: "proj_fresh", name: "fresh" }, { id: "proj_briefed", name: "briefed" }, { id: "proj_quiet", name: "quiet" }];
  memory.putBrief({ scope: "project", projectId: "proj_briefed", content: "briefed in one line.", inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z" });
  memory.putBrief({ scope: "project", projectId: "proj_quiet", content: "quiet in one line.", inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z" });
  const realProject = seedProject(env.projects);
  const mine = seedWorker(env.workers, realProject, { name: "mine", tmuxWindowName: "mine" });
  const earlier = seedWorker(env.workers, realProject, { name: "earlier", tmuxWindowName: "earlier" });
  const earlierRecord = records.write({ workerId: earlier, projectId: "proj_fresh", content: "Set up the repo"}).record;
  records.write({ workerId: mine, projectId: "proj_fresh", content: "My own work"});

  const worker = buildMemorySection({ memory, records, projects: list, agent: { kind: "worker", projectId: "proj_fresh", workerId: mine }, now: NOW });
  expect(worker).toContain(`### Recent work in fresh (task records, newest first)\n- [${earlierRecord.id}] (2026-10-07) earlier: Set up the repo`);
  expect(worker).not.toContain("### Project fresh");

  const manager = buildMemorySection({ memory, records, projects: list, agent: { kind: "manager", projectIdsByActivity: ["proj_fresh", "proj_briefed"] }, now: NOW });
  expect(manager).toContain("### Recent work in fresh (task records, newest first)");
  expect(manager).toContain("### Project briefed");
  expect(manager).toContain("### Other projects with memory\n- quiet — quiet in one line.");
  expect(manager).not.toContain("- fresh —");
});

test("a manager gets three full briefs by activity and one line for every other project", async () => {
  const { memory, records } = await seeded();
  const section = buildMemorySection({
    memory, records, projects,
    agent: { kind: "manager", projectIdsByActivity: ["proj_project-5", "proj_project-1", "proj_project-4", "proj_project-2"] },
    now: NOW
  });
  expect(section.indexOf("### Project project-5")).toBeLessThan(section.indexOf("### Project project-1"));
  expect(section).toContain("### Project project-4");
  expect(section).not.toContain("### Project project-2");
  expect(section).toContain("### Other projects with memory\n- project-2 — project-2 in one line.");
  expect(section).toContain('Read one with memory_read({ target: "project", project }).');
});

test("the personal agent gets the user brief and one line per project; nothing to say says nothing", async () => {
  const { memory, records } = await seeded();
  const section = buildMemorySection({ memory, records, projects, agent: { kind: "personal" }, now: NOW });
  expect(section).toContain("### About the user");
  expect(section).not.toContain("### Project ");
  for (const p of projects) expect(section).toContain(`- ${p.name} — ${p.name} in one line.`);
  const empty = freshStoresEnv("md-memory-section-empty-");
  expect(buildMemorySection({ memory: new MemoryManager(new LocalMemoryProvider(empty.store.db)), records: new WorkerRecordStore(empty.store.db), projects, agent: { kind: "personal" } })).toBe("");
});

// Memory opens a window and never changes inside it: it is
// in each scope's initial context and in no runtime-context update.
test("a worker's and a manager thread's memory is in their initial context, not their runtime context", async () => {
  const env = freshStoresEnv("md-memory-section-scopes-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const manager = env.agentStore.createManagerThread("t");
  const workerId = seedWorker(env.workers, project1, { ownerThreadId: manager.id });
  memory.putBrief({ scope: "user", projectId: null, content: "USER BRIEF", inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z" });
  memory.putBrief({ scope: "project", projectId: project1, content: "PROJECT-1 BRIEF", inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z" });
  const records = new WorkerRecordStore(env.store.db);
  records.write({ workerId, projectId: project1, content: "TASK RECORD"});
  const skillRegistry = stub<SkillRegistry>({ maybeRefresh: async () => {}, renderManifest: () => "" });

  const worker = buildWorkerScope({
    agentStore: env.agentStore, projectsStore: env.projects, workersStore: env.workers, memory, records, skillRegistry,
    tmuxRuntime: { listPanes: async () => [] }
  } as unknown as WorkerScopeDeps);
  const workerThread = env.agentStore.getOrCreateThread("worker", workerId);
  const workerInitial = (await worker.buildInitialContext!(workerThread.id))!;
  for (const text of ["## Memory", "USER BRIEF", "PROJECT-1 BRIEF", "TASK RECORD"]) expect(workerInitial).toContain(text);
  expect(await worker.buildRuntimeContext!(workerThread.id)).not.toContain("## Memory");
  expect(worker.buildMemorySection!(workerThread.id)).toContain("TASK RECORD");

  // A second project whose worker was active more recently comes first.
  const project4 = seedProject(env.projects, { name: "project-4", tmuxSessionName: "md-project-4" });
  memory.putBrief({ scope: "project", projectId: project4, content: "PROJECT-4 BRIEF", inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z" });
  const project4Worker = seedWorker(env.workers, project4, { ownerThreadId: manager.id, name: "project-4-work", tmuxWindowName: "project-4-work" });
  env.store.db.prepare("update workers set updated_at = ? where id = ?").run("2026-10-01T00:00:00.000Z", workerId);
  env.store.db.prepare("update workers set updated_at = ? where id = ?").run("2026-10-06T00:00:00.000Z", project4Worker);
  const managerScope = buildManagerScope({ agentStore: env.agentStore, projectsStore: env.projects, workersStore: env.workers, memory, records, skillRegistry });
  const managerInitial = (await managerScope.buildInitialContext!(manager.id))!;
  for (const text of ["## Memory", "USER BRIEF", "### Project project-1", "PROJECT-1 BRIEF"]) expect(managerInitial).toContain(text);
  expect(managerInitial.indexOf("### Project project-4")).toBeGreaterThan(-1);
  expect(managerInitial.indexOf("### Project project-4")).toBeLessThan(managerInitial.indexOf("### Project project-1"));
  expect(await managerScope.buildRuntimeContext!(manager.id)).not.toContain("## Memory");
  // Activity is the worker's conversation, which leaves its worker row as it was.
  env.agentStore.appendMessage({ threadId: workerThread.id, role: "user", source: "user", content: { type: "text", text: "and the e2e?" } });
  const afterTalk = (await managerScope.buildInitialContext!(manager.id))!;
  expect(afterTalk.indexOf("### Project project-1")).toBeLessThan(afterTalk.indexOf("### Project project-4"));
  // Pinning a quiet worker touches its worker row, not its conversation.
  const project4Thread = env.agentStore.getOrCreateThread("worker", project4Worker);
  const old = env.agentStore.appendMessage({ threadId: project4Thread.id, role: "user", source: "user", content: { type: "text", text: "start" } });
  env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run("2026-10-02T00:00:00.000Z", old.id);
  env.store.db.prepare("update workers set updated_at = ? where id = ?").run("2099-01-01T00:00:00.000Z", project4Worker);
  const afterPin = (await managerScope.buildInitialContext!(manager.id))!;
  expect(afterPin.indexOf("### Project project-1")).toBeLessThan(afterPin.indexOf("### Project project-4"));
});
