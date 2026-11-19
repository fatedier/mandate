import { expect, test } from "bun:test";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { conversationScopeOf, subagentAskedBy, subagentParentOf } from "../src/server/modules/agent/subagent-threads.js";
import { newId } from "../src/server/platform/ids.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";

function setup() {
  const env = freshStoresEnv("md-subagent-threads-");
  const tasks = new BackgroundTaskStore(env.store.db);
  const subagentOf = (parentThreadId: string) => {
    const taskId = newId("task");
    const child = env.agentStore.createSubagentThread(taskId);
    tasks.create({ id: taskId, parentThreadId, childThreadId: child.id, type: "general", title: "Notes", task: "Find the notes." });
    return child;
  };
  return { ...env, tasks, subagentOf, deps: { agentStore: env.agentStore, backgroundTasks: tasks } };
}

test("a subagent's thread has the subagent scope and its task's id, and is no manager thread: nobody is told of one", () => {
  const s = setup();
  const announced: string[] = [];
  s.agentStore.onManagerThreadCreated((thread) => announced.push(thread.id));
  const child = s.agentStore.createSubagentThread("task_1");
  expect(child).toMatchObject({ scope: "subagent", scopeId: "task_1", archivedAt: null, title: null });
  expect(s.agentStore.getThreadById(child.id)).toEqual(child);
  expect(announced).toStrictEqual([]);
  expect(s.agentStore.listOpenManagerThreads()).toEqual([]);
  expect(s.agentStore.latestOpenManagerThread()).toBeNull();
  // One thread per task.
  expect(() => s.agentStore.createSubagentThread("task_1")).toThrow();
});

test("The personal agent's one open thread stays the one: a subagent's thread neither stands in for it nor blocks it", () => {
  const s = setup();
  const early = s.agentStore.createSubagentThread("task_early");
  expect(s.agentStore.openPersonalThread()).toBeNull();
  const personal = s.agentStore.getOrCreatePersonalThread();
  expect(personal.scope).toBe("personal");
  expect(personal.id).not.toBe(early.id);
  const later = s.agentStore.createSubagentThread("task_later");
  expect(later.scope).toBe("subagent");
  expect(s.agentStore.openPersonalThread()?.id).toBe(personal.id);
  expect(s.agentStore.getOrCreatePersonalThread().id).toBe(personal.id);
});

test("a thread's calls follow its own scope; a subagent's follow the thread that started it, and none when that is gone", () => {
  const s = setup();
  const projectId = seedProject(s.projects);
  const worker = s.agentStore.getOrCreateThread("worker", seedWorker(s.workers, projectId));
  const manager = s.agentStore.createManagerThread("Release 0.72");
  const personal = s.agentStore.getOrCreatePersonalThread();
  for (const [thread, scope] of [[worker, "worker"], [manager, "manager"], [personal, "personal"]] as const) {
    expect(conversationScopeOf(s.deps, thread.id)).toBe(scope);
    expect(subagentParentOf(s.deps, thread.id)).toBeNull();
    const child = s.subagentOf(thread.id);
    expect(subagentParentOf(s.deps, child.id)?.id).toBe(thread.id);
    expect(conversationScopeOf(s.deps, child.id)).toBe(scope);
  }
  expect(conversationScopeOf(s.deps, "thr_gone")).toBeUndefined();
  const orphan = s.agentStore.createSubagentThread("task_without_row");
  expect(subagentParentOf(s.deps, orphan.id)).toBeNull();
  expect(conversationScopeOf(s.deps, orphan.id)).toBeUndefined();
  const ofDeleted = s.subagentOf("thr_deleted");
  expect(conversationScopeOf(s.deps, ofDeleted.id)).toBeUndefined();
  // No nesting: a subagent's thread is no one's parent.
  const nested = s.subagentOf(s.subagentOf(manager.id).id);
  expect(subagentParentOf(s.deps, nested.id)).toBeNull();
  expect(conversationScopeOf(s.deps, nested.id)).toBeUndefined();
});

test("a subagent's task says who asked: a manager thread by the title a person sees, a worker by its worker, the personal agent as itself", () => {
  const s = setup();
  const deps = { agentStore: s.agentStore, workersStore: s.workers };
  const titled = s.agentStore.createManagerThread("Release 0.72");
  const untitled = s.agentStore.createManagerThread();
  s.agentStore.appendMessage({ threadId: untitled.id, role: "user", source: "user", content: { type: "text", text: "Ship the cache change\nand tell me" } });
  const fresh = s.agentStore.createManagerThread();
  const worker = s.agentStore.getOrCreateThread("worker", seedWorker(s.workers, seedProject(s.projects), { name: "Row export" }));
  expect(subagentAskedBy(deps, titled)).toBe("Release 0.72");
  expect(subagentAskedBy(deps, untitled)).toBe("Ship the cache change");
  expect(subagentAskedBy(deps, fresh)).toBe("New thread");
  expect(subagentAskedBy(deps, worker)).toBe("Row export");
  expect(subagentAskedBy(deps, s.agentStore.getOrCreatePersonalThread())).toBe("Personal agent");
});
