import { expect, test } from "bun:test";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { createWindowExtractor, windowExtraction } from "../src/server/runtime/agent-memory-hooks.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { newId } from "../src/server/platform/ids.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";

test("a worker extracts into its project with its task record; a manager lists its projects first; the global agent lists every project", () => {
  const env = freshStoresEnv("md-memory-hooks-");
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const project4 = seedProject(env.projects, { name: "project-4", tmuxSessionName: "md-project-4" });
  const manager = env.agentStore.createManagerThread("t");
  // The worker is in the older project, so "its projects first" differs from
  // listActive's own order (newest first).
  const featureId = seedFeature(env.features, project1, { ownerThreadId: manager.id, name: "Row export" });
  const workerThread = env.agentStore.getOrCreateThread("worker", featureId);
  const deps = { agentStore: env.agentStore, projectsStore: env.projects, featuresStore: env.features };

  expect(windowExtraction(workerThread.id, [], deps)).toEqual({
    messages: [],
    projects: [{ id: project1, name: "project-1" }],
    worker: { featureId, projectId: project1, name: "Row export" }
  });
  expect(env.projects.listActive().map((p) => p.name)).toEqual(["project-4", "project-1"]);
  expect(windowExtraction(manager.id, [], deps)!.projects.map((p) => p.name)).toEqual(["project-1", "project-4"]);
  const global = env.agentStore.getOrCreateThread("global", null);
  expect(windowExtraction(global.id, [], deps)).toEqual({
    messages: [],
    projects: expect.arrayContaining([{ id: project1, name: "project-1" }, { id: project4, name: "project-4" }]),
    worker: null
  });
});

// The archive hooks hand the whole window over before the archive is written,
// so a compression that finishes afterwards must not hand its part over again.
test("an archived thread or an archived worker has no window left to extract", () => {
  const env = freshStoresEnv("md-memory-hooks-closed-");
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const manager = env.agentStore.createManagerThread("t");
  const featureId = seedFeature(env.features, project1, { ownerThreadId: manager.id, name: "Row export" });
  const workerThread = env.agentStore.getOrCreateThread("worker", featureId);
  const deps = { agentStore: env.agentStore, projectsStore: env.projects, featuresStore: env.features };

  env.features.archive(featureId);
  expect(windowExtraction(workerThread.id, [], deps)).toBeNull();
  env.agentStore.archiveThread(manager.id);
  expect(windowExtraction(manager.id, [], deps)).toBeNull();
});

// Compression keeps a user turn too large to retain whole as a shortened copy,
// and the window carries that copy; the stored row has the user's whole words.
test("a window hands extraction its messages as stored, not the shortened copies it carried", () => {
  const env = freshStoresEnv("md-memory-hooks-stored-");
  const thread = env.agentStore.createManagerThread("t");
  const whole = `${"log line\n".repeat(50)}Then keep releases tagged from main.`;
  const stored = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: whole } });
  const shortened = { ...stored, content: { type: "text" as const, text: "log line... [truncated 400 chars]" } };
  const deps = { agentStore: env.agentStore, projectsStore: env.projects, featuresStore: env.features };
  expect(windowExtraction(thread.id, [shortened], deps)!.messages).toEqual([stored]);
});

// A subagent's window is its parent's handover and what it did with it: the
// parent's own window, its result among it, already gives what is worth
// remembering.
test("a subagent's window gives memory extraction nothing", () => {
  const env = freshStoresEnv("md-memory-hooks-subagent-");
  seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const manager = env.agentStore.createManagerThread("t");
  const taskId = newId("task");
  const child = env.agentStore.createSubagentThread(taskId);
  new BackgroundTaskStore(env.store.db).create({ id: taskId, parentThreadId: manager.id, childThreadId: child.id, type: "general", title: "Notes", task: "Find the notes." });
  const message = env.agentStore.appendMessage({
    threadId: child.id, role: "user", source: "subagent-task", content: { type: "text", text: "The user prefers tables over charts." }
  });
  const deps = { agentStore: env.agentStore, projectsStore: env.projects, featuresStore: env.features };
  expect(windowExtraction(child.id, [message], deps)).toBeNull();
  expect(windowExtraction(manager.id, [], deps)).not.toBeNull();
});

// A worker's window handed over writes its task record beside its plan.
test("a worker's window writes its task record into feature_records, and says so to the page", async () => {
  const env = freshStoresEnv("md-memory-hooks-records-");
  const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const manager = env.agentStore.createManagerThread("t");
  const featureId = seedFeature(env.features, projectId, { ownerThreadId: manager.id, name: "UDP framing", tmuxWindowName: "udp" });
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  const message = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Fix the UDP framing bug in project-1" } });
  const records = new FeatureRecordStore(env.store.db);
  // The first window writes the record; the second has nothing to add.
  const model = createMockLLM([
    { text: JSON.stringify({ entries: [], taskRecord: "Asked: fix UDP framing." }) },
    { text: JSON.stringify({ entries: [] }) }
  ]);
  const emitted: Array<[string, unknown]> = [];
  const extractor = createWindowExtractor({
    agentStore: env.agentStore, projectsStore: env.projects, featuresStore: env.features,
    memory: new MemoryManager(new LocalMemoryProvider(env.store.db)), records,
    route: () => ({ candidates: [{ model, provider: "openai", supportsReasoning: undefined }], repeatCheck: [] }),
    budgetTokens: () => 50_000,
    sse: { emit: (event, data) => { emitted.push([event, data]); } }
  });
  const settled = async () => {
    for (let i = 0; i < 200 && extractor.inFlight(thread.id); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(extractor.inFlight(thread.id)).toBe(false);
  };
  extractor.extractWindow(thread.id, "compression", [message]);
  await settled();
  expect(records.get(featureId)?.content).toBe("Asked: fix UDP framing.");
  expect(emitted).toEqual([[SSE_EVENTS.featureRecordUpdated, { featureId }]]);
  extractor.extractWindow(thread.id, "compression", [message]);
  await settled();
  expect(emitted).toHaveLength(1);
});

// Extractions run one at a time: each reads what memory holds when it starts
// (the recent memories it may rewrite, the repeat check's neighbours), so two
// at once would each miss what the other wrote.
test("two windows handed over together are extracted one after the other, the second reading what the first wrote", async () => {
  const env = freshStoresEnv("md-memory-hooks-queue-");
  const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const manager = env.agentStore.createManagerThread("t");
  const threads = ["release", "deploy"].map((name) => {
    const featureId = seedFeature(env.features, projectId, { ownerThreadId: manager.id, name, tmuxWindowName: name });
    const thread = env.agentStore.getOrCreateThread("worker", featureId);
    const message = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: `Ship the ${name} work for project-1` } });
    return { thread, message };
  });
  const learned = "project-1 releases are cut on Fridays, after the full test run.";
  const model = createMockLLM([
    { text: JSON.stringify({ entries: [{ type: "knowledge", scope: "project", projectId, content: learned }] }) },
    { text: JSON.stringify({ entries: [] }) }
  ]);
  const extractor = createWindowExtractor({
    agentStore: env.agentStore, projectsStore: env.projects, featuresStore: env.features,
    memory: new MemoryManager(new LocalMemoryProvider(env.store.db)), records: new FeatureRecordStore(env.store.db),
    route: () => ({ candidates: [{ model, provider: "openai", supportsReasoning: undefined }], repeatCheck: [] }),
    budgetTokens: () => 50_000,
    sse: { emit: () => {} }
  });
  for (const { thread, message } of threads) extractor.extractWindow(thread.id, "worker_archive", [message]);
  const busy = () => threads.some(({ thread }) => extractor.inFlight(thread.id));
  for (let i = 0; i < 400 && busy(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(busy()).toBe(false);
  expect(model.streamCalls).toHaveLength(2);
  expect(JSON.stringify(model.streamCalls[1]!.prompt)).toContain(learned);
});

test("an extraction that fails does not hold up the ones after it", async () => {
  const env = freshStoresEnv("md-memory-hooks-queue-fail-");
  const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const manager = env.agentStore.createManagerThread("t");
  const threads = ["first", "second"].map((name) => {
    const featureId = seedFeature(env.features, projectId, { ownerThreadId: manager.id, name, tmuxWindowName: name });
    const thread = env.agentStore.getOrCreateThread("worker", featureId);
    const message = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: `Work on ${name}` } });
    return { thread, message };
  });
  const model = createMockLLM([
    { error: new Error("provider down") },
    { text: JSON.stringify({ entries: [{ type: "knowledge", scope: "project", projectId, content: "project-1 builds with make." }] }) }
  ]);
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const extractor = createWindowExtractor({
    agentStore: env.agentStore, projectsStore: env.projects, featuresStore: env.features,
    memory, records: new FeatureRecordStore(env.store.db),
    route: () => ({ candidates: [{ model, provider: "openai", supportsReasoning: undefined }], repeatCheck: [] }),
    budgetTokens: () => 50_000,
    sse: { emit: () => {} }
  });
  for (const { thread, message } of threads) extractor.extractWindow(thread.id, "worker_archive", [message]);
  const busy = () => threads.some(({ thread }) => extractor.inFlight(thread.id));
  for (let i = 0; i < 400 && busy(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(busy()).toBe(false);
  expect(memory.listAvailable({ scope: "project", projectId }).map((m) => m.content)).toEqual(["project-1 builds with make."]);
});

// A window keeps the route and budget it was handed over with, however long
// it waits its turn: settings changed meanwhile are for later windows.
test("a window waiting its turn keeps the route it was handed over with", async () => {
  const env = freshStoresEnv("md-memory-hooks-queue-route-");
  const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const manager = env.agentStore.createManagerThread("t");
  const threads = ["first", "second"].map((name) => {
    const featureId = seedFeature(env.features, projectId, { ownerThreadId: manager.id, name, tmuxWindowName: name });
    const thread = env.agentStore.getOrCreateThread("worker", featureId);
    const message = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: `Work on ${name}` } });
    return { thread, message };
  });
  const before = createMockLLM([{ text: JSON.stringify({ entries: [] }) }, { text: JSON.stringify({ entries: [] }) }]);
  const after = createMockLLM([{ text: JSON.stringify({ entries: [] }) }]);
  let model = before;
  const extractor = createWindowExtractor({
    agentStore: env.agentStore, projectsStore: env.projects, featuresStore: env.features,
    memory: new MemoryManager(new LocalMemoryProvider(env.store.db)), records: new FeatureRecordStore(env.store.db),
    route: () => ({ candidates: [{ model, provider: "openai", supportsReasoning: undefined }], repeatCheck: [] }),
    budgetTokens: () => 50_000,
    sse: { emit: () => {} }
  });
  for (const { thread, message } of threads) extractor.extractWindow(thread.id, "worker_archive", [message]);
  // Settings reloaded while the second waits.
  model = after;
  const busy = () => threads.some(({ thread }) => extractor.inFlight(thread.id));
  for (let i = 0; i < 400 && busy(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect([before.streamCalls.length, after.streamCalls.length]).toEqual([2, 0]);
});
