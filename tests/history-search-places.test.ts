import { expect, test } from "bun:test";
import { AgentHistoryStore } from "../src/server/modules/agent/history-store.js";
import { seedProject, seedWorker } from "./helpers/fixtures.js";
import { historyEnv } from "./helpers/history-env.js";

// What a search and a read say about where a conversation is: a worker's
// thread is in its project, a manager's and the personal agent's are in none.
// Nothing stands in for "no project".

type Env = ReturnType<typeof historyEnv>;

function say(env: Env, threadId: string, text: string): void {
  env.agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text } });
}

test("with no project named a search has no project, and each thread outside one says whose it is", () => {
  const env = historyEnv();
  const release = env.agentStore.createManagerThread("3.21 release");
  const yours = env.agentStore.getOrCreatePersonalThread();
  say(env, release.id, "rollout marker in the release thread");
  say(env, yours.id, "rollout marker in the personal agent's thread");
  say(env, env.thread.id, "rollout marker in a worker thread");
  const history = new AgentHistoryStore(env.store.db);

  const result = history.search({ callerThreadId: env.caller.id, query: "rollout marker" });

  expect(result.project).toBeNull();
  expect(result.threads.map((thread) => [thread.kind, thread.id]).sort()).toEqual([["personal", yours.id], ["manager", release.id]].sort());
  expect(result.threads.find((thread) => thread.id === release.id)).toMatchObject({ kind: "manager", title: "3.21 release" });
});

test("a project's search gives its worker threads with project and worker, beside the conversations outside any project", () => {
  const env = historyEnv();
  const release = env.agentStore.createManagerThread("3.21 release");
  say(env, release.id, "schema marker in the release thread");
  say(env, env.thread.id, "schema marker in the login worker");
  const history = new AgentHistoryStore(env.store.db);

  const result = history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "schema marker" });

  expect(result.project).toEqual({ id: env.projectId, name: "Alpha" });
  expect(result.threads.find((thread) => thread.id === env.thread.id)).toMatchObject({
    kind: "worker", project: "Alpha", worker: { id: env.workerId, name: "Login" }
  });
  expect(result.threads.find((thread) => thread.id === release.id)).toMatchObject({ kind: "manager", title: "3.21 release" });
});

test("a read goes by a hit's thread and seq", () => {
  const env = historyEnv();
  for (const text of ["before the marker", "the needle marker itself", "after the marker"]) say(env, env.thread.id, text);
  const history = new AgentHistoryStore(env.store.db);
  const found = history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "needle marker" });
  const hit = found.threads[0]!.hits[0]!;

  const read = history.read({ callerThreadId: env.caller.id, threadId: found.threads[0]!.id, seq: hit.seq });

  expect(read.thread).toMatchObject({ id: env.thread.id, kind: "worker", project: "Alpha", worker: { id: env.workerId, name: "Login" } });
  expect(read.messages.map((message) => message.content.text)).toEqual(["before the marker", "the needle marker itself", "after the marker"]);
});

test("a worker reads its own project's worker threads, and no other thread", () => {
  const env = historyEnv();
  const sibling = env.agentStore.getOrCreateThread("worker", seedWorker(env.workers, env.projectId, { name: "Signup", tmuxWindowName: "signup" }));
  const otherProject = seedProject(env.projects, { name: "Beta", workingDir: "/beta", tmuxSessionName: "beta" });
  const elsewhere = env.agentStore.getOrCreateThread("worker", seedWorker(env.workers, otherProject, { name: "Billing", tmuxWindowName: "billing" }));
  for (const thread of [sibling, elsewhere, env.caller]) say(env, thread.id, "a line to read");
  const history = new AgentHistoryStore(env.store.db);
  const seqOf = (threadId: string) => env.agentStore.getActiveMessages(threadId)[0]!.seq;

  expect(history.read({ callerThreadId: env.thread.id, threadId: sibling.id, seq: seqOf(sibling.id) }).thread.id).toBe(sibling.id);
  expect(() => history.read({ callerThreadId: env.thread.id, threadId: elsewhere.id, seq: seqOf(elsewhere.id) })).toThrow(/thread_out_of_scope/);
  expect(() => history.read({ callerThreadId: env.thread.id, threadId: env.caller.id, seq: seqOf(env.caller.id) })).toThrow(/thread_out_of_scope/);
});

test("a named archived thread can be read; a seq it does not have is not found", () => {
  const env = historyEnv();
  const old = env.agentStore.createManagerThread("Old release");
  say(env, old.id, "kept from before");
  const seq = env.agentStore.getActiveMessages(old.id)[0]!.seq;
  env.agentStore.archiveThread(old.id);
  const history = new AgentHistoryStore(env.store.db);

  expect(history.read({ callerThreadId: env.caller.id, threadId: old.id, seq }).thread).toMatchObject({ id: old.id, kind: "manager", title: "Old release" });
  expect(() => history.read({ callerThreadId: env.caller.id, threadId: old.id, seq: seq + 99 })).toThrow(/message_not_found/);
});

test("a worker's search refuses a manager's row even past the query's own filter", () => {
  const env = historyEnv();
  say(env, env.caller.id, "a line in the manager's thread");
  const history = new AgentHistoryStore(env.store.db);
  const row = env.store.db.prepare("select *, null as rank from agent_message_search_entries where thread_id = ?").get(env.caller.id);
  // The second of two layers: what the query let through is checked again.
  const group = (allowOutsideProjects: boolean) => (history as unknown as { groupSearchRows: (rows: unknown[], opts: object) => unknown[] })
    .groupSearchRows([row], { projectId: env.projectId, includeArchived: false, limit: 5, snippetsPerThread: 2, allowOutsideProjects });
  expect(() => group(false)).toThrow(/thread_out_of_scope/);
  expect(group(true)).toHaveLength(1);
});
