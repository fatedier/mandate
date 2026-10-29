import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { memoryModule } from "../src/server/modules/memory/module.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { MemoryDreamer } from "../src/server/modules/memory/dream.js";
import { entriesDigest } from "../src/server/modules/memory/briefs.js";
import type { AppDeps } from "../src/server/app/deps.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";
import type {
  MemoryBriefsResponse,
  MemoryDreamRunDetailResponse,
  MemoryDreamRunsResponse,
  MemoryEntryHistoryResponse
} from "../src/shared/api-contracts.js";

const { upgradeWebSocket } = createBunWebSocket();

function app(env: ReturnType<typeof freshStoresEnv>) {
  const hono = new Hono();
  memoryModule.mountRoutes?.(hono, { deps: stub<AppDeps>({ store: env.store }), upgradeWebSocket });
  return hono;
}

test("GET /api/memory/briefs lists the user brief first, names projects, sizes them, and marks a brief whose entries changed", async () => {
  const env = freshStoresEnv("md-memory-briefs-route-");
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const provider = new LocalMemoryProvider(env.store.db);
  const first = await provider.remember({ scope: "project", projectId: project1, type: "knowledge", source: "agent", content: "one" });
  provider.putBrief({ scope: "project", projectId: project1, content: "project-1 brief", inputDigest: entriesDigest([first]), builtAt: "2026-10-07T00:00:00.000Z", runId: null });
  provider.putBrief({ scope: "user", projectId: null, content: "user brief", inputDigest: entriesDigest([]), builtAt: "2026-10-07T00:00:00.000Z", runId: null });
  await provider.remember({ scope: "project", projectId: project1, type: "knowledge", source: "agent", content: "two" });

  const body = await (await app(env).request("/api/memory/briefs")).json() as MemoryBriefsResponse;

  expect(body.briefs).toEqual([
    { scope: "user", projectId: null, projectName: null, content: "user brief", builtAt: "2026-10-07T00:00:00.000Z", stale: false, tokens: expect.any(Number), tokenLimit: 3000 },
    { scope: "project", projectId: project1, projectName: "project-1", content: "project-1 brief", builtAt: "2026-10-07T00:00:00.000Z", stale: true, tokens: expect.any(Number), tokenLimit: 2000 }
  ]);
  expect(body.briefs[0]!.tokens).toBeGreaterThan(0);
});

test("GET /api/memory/entries/:id/history tells a memory's story, newest first, and where it came from", async () => {
  const env = freshStoresEnv("md-memory-history-route-");
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const featureId = seedFeature(env.features, project1, { name: "udp", tmuxWindowName: "udp-win" });
  const thread = env.agentStore.getOrCreateThread("worker", featureId);
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const kept = await memory.remember({
    scope: "project", projectId: project1, type: "knowledge", source: "extraction", content: "v1 sends JSON.",
    sourceThreadId: thread.id, metadata: { extractionTrigger: "worker_archive" }
  });
  const dup = await memory.remember({ scope: "project", projectId: project1, type: "knowledge", source: "agent", content: "v1 is JSON." });
  const model = createMockLLM([
    { toolCalls: [{ toolCallId: "c1", toolName: "apply_action", args: { type: "merge", memoryId: dup.id, targetMemoryId: kept.id, reason: "same fact" } }], finishReason: "tool-calls" },
    { toolCalls: [{ toolCallId: "c2", toolName: "write_brief", args: { content: "project-1: v1 is JSON." } }], finishReason: "tool-calls" }
  ]);
  await new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 3 })
    .run("manual", { kind: "project", projectId: project1 });

  const body = await (await app(env).request(`/api/memory/entries/${kept.id}/history`)).json() as MemoryEntryHistoryResponse;
  expect(body.events.map((event) => event.text)).toEqual([
    `The dream merged ${dup.id.slice(0, 12)} into this`,
    "Extracted when the worker was archived"
  ]);
  expect(body.events[0]!.detail).toBe("same fact");
  expect(body.sourceThread).toEqual({ id: thread.id, scope: "worker", title: null, projectSlug: "md-project-1", featureSlug: "udp-win", featureName: "udp", archived: false });

  const merged = await (await app(env).request(`/api/memory/entries/${dup.id}/history`)).json() as MemoryEntryHistoryResponse;
  expect(merged.events.map((event) => event.text)).toEqual([
    `The dream merged this into ${kept.id.slice(0, 12)}`,
    "Remembered by an agent"
  ]);
  expect(merged.sourceThread).toBeNull();
  expect((await app(env).request("/api/memory/entries/mem_nope/history")).status).toBe(404);
});

test("a run's detail carries the brief it wrote and the one before; the run list says a brief was written", async () => {
  const env = freshStoresEnv("md-memory-run-brief-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Short replies." });
  const run = async (brief: string) => {
    const model = createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "write_brief", args: { content: brief } }], finishReason: "tool-calls" }
    ]);
    return new MemoryDreamer({ contextLimitTokens: 200_000, db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, model, provider: "openai", maxSteps: 2 })
      .run("manual", { kind: "user" });
  };
  const first = await run("First brief.");
  await Bun.sleep(2);
  const second = await run("Second brief.");

  const detail = await (await app(env).request(`/api/memory/dream/runs/${second.runId}`)).json() as Extract<MemoryDreamRunDetailResponse, { run: unknown }>;
  expect(detail.brief).toEqual({ content: "Second brief.", previous: "First brief." });
  const firstDetail = await (await app(env).request(`/api/memory/dream/runs/${first.runId}`)).json() as Extract<MemoryDreamRunDetailResponse, { run: unknown }>;
  expect(firstDetail.brief).toEqual({ content: "First brief.", previous: null });

  const list = await (await app(env).request("/api/memory/dream/runs?limit=5")).json() as MemoryDreamRunsResponse;
  expect(list.runs.map((r) => r.briefWritten)).toStrictEqual([true, true]);
  // The brief's text stays out of the list.
  expect(JSON.stringify(list)).not.toContain("Second brief.");
});

test("a memory's creation is told from what is known of it, not from what it became", async () => {
  const env = freshStoresEnv("md-memory-history-origin-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const promoted = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Short replies." });
  await Bun.sleep(2);
  await memory.update({ id: promoted.id, source: "user", userQuote: "Keep the replies shorter", metadata: { statedAt: new Date().toISOString() } });
  const texts = async (id: string) => ((await (await app(env).request(`/api/memory/entries/${id}/history`)).json()) as MemoryEntryHistoryResponse).events.map((e) => e.text);
  expect(await texts(promoted.id)).toEqual(["Restated in your words", "Remembered"]);
  // A part split off a statement carries the statement's date, which is older than the part.
  const part = await memory.remember({ scope: "user", type: "preference", source: "user", userQuote: "Keep the replies shorter", content: "Short replies.", metadata: { splitFrom: "mem_whole", statedAt: "2026-01-01T00:00:00.000Z" } });
  expect(await texts(part.id)).toEqual(["Split from mem_whole"]);
});

test("a memory's source says when its conversation was archived, the thread's or its worker's", async () => {
  const env = freshStoresEnv("md-memory-history-archived-");
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const featureId = seedFeature(env.features, project1, { name: "udp", tmuxWindowName: "udp-win" });
  const worker = env.agentStore.getOrCreateThread("worker", featureId);
  const manager = env.agentStore.getOrCreateThread("manager", "planning");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const fromWorker = await memory.remember({ scope: "project", projectId: project1, type: "knowledge", source: "agent", content: "a", sourceThreadId: worker.id });
  const fromManager = await memory.remember({ scope: "project", projectId: project1, type: "knowledge", source: "agent", content: "b", sourceThreadId: manager.id });
  const source = async (id: string) => ((await (await app(env).request(`/api/memory/entries/${id}/history`)).json()) as MemoryEntryHistoryResponse).sourceThread;
  expect((await source(fromWorker.id))?.archived).toBe(false);
  expect((await source(fromManager.id))?.archived).toBe(false);

  env.store.db.prepare("update features set archived_at = ? where id = ?").run("2026-10-07T00:00:00.000Z", featureId);
  env.store.db.prepare("update agent_threads set archived_at = ? where id = ?").run("2026-10-07T00:00:00.000Z", manager.id);
  expect((await source(fromWorker.id))?.archived).toBe(true);
  expect((await source(fromManager.id))?.archived).toBe(true);
});

test("GET /api/memory/entries?learned=1 leaves out the parts a dream split off, before the limit", async () => {
  const env = freshStoresEnv("md-memory-learned-route-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const learned = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "learned" });
  await Bun.sleep(2);
  for (const content of ["part one", "part two"]) {
    await memory.remember({ scope: "user", type: "preference", source: "agent", content, metadata: { splitFrom: "mem_whole" } });
    await Bun.sleep(2);
  }
  const body = await (await app(env).request("/api/memory/entries?status=all&learned=1&sort=created&limit=1")).json() as { entries: Array<{ id: string }>; total: number };
  expect(body.entries.map((e) => e.id)).toEqual([learned.id]);
  expect(body.total).toBe(1);
});

// A subagent's thread is no page of its own: its memory names the
// conversation it worked for.
test("a memory learned in a subagent's thread names the conversation the subagent worked for", async () => {
  const env = freshStoresEnv("md-memory-history-subagent-");
  const parent = env.agentStore.createManagerThread("Release planning");
  const child = env.agentStore.createSubagentThread("task_1");
  env.store.db.prepare(`insert into background_tasks (id, kind, parent_thread_id, child_thread_id, type, title, task, status, created_at)
      values ('task_1', 'subagent', ?, ?, 'general', 'Look it up', 'Look it up.', 'finished', '2026-10-01T00:00:00.000Z')`).run(parent.id, child.id);
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const entry = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "a", sourceThreadId: child.id });
  const body = await (await app(env).request(`/api/memory/entries/${entry.id}/history`)).json() as MemoryEntryHistoryResponse;
  expect(body.sourceThread).toEqual({ id: parent.id, scope: "manager", title: "Release planning", projectSlug: null, featureSlug: null, featureName: null, archived: false });
});

test("GET /api/memory/entries?forgotten=1 lists only what an agent forgot", async () => {
  const env = freshStoresEnv("md-memory-forgotten-route-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const forgotten = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "forgotten" });
  await memory.archive(forgotten.id, { forgottenReason: "proved wrong" });
  const merged = await memory.remember({ scope: "user", type: "preference", source: "agent", content: "merged" });
  await memory.archive(merged.id, { mergedInto: "mem_x" });
  const body = await (await app(env).request("/api/memory/entries?status=archived&forgotten=1&limit=25")).json() as { entries: Array<{ id: string }>; total: number };
  expect(body.entries.map((e) => e.id)).toEqual([forgotten.id]);
  expect(body.total).toBe(1);
});

// Task records are not memory: a type=task filter is no filter, as any unknown type is.
test("the entries list takes type=task as any type", async () => {
  const env = freshStoresEnv("md-memory-type-task-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  await memory.remember({ scope: "user", type: "preference", source: "agent", content: "Short replies." });
  const listed = async (query: string) => ((await (await app(env).request(`/api/memory/entries${query}`)).json()) as { entries: Array<{ id: string }> }).entries.map((e) => e.id);
  expect(await listed("?type=task")).toEqual(await listed(""));
  expect(await listed("?type=task")).toHaveLength(1);
});
