import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { freshStoresEnv, withTempDataDir } from "./helpers/fixtures.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { testShellRunner } from "./helpers/shell-runner.js";
import { tempDir } from "./helpers/temp.js";
import { waitUntil } from "./helpers/wait.js";
import { onCleanup } from "./helpers/cleanup.js";
import { SIDE_CHAT_BOUNDARY, SIDE_CHAT_REFUSED } from "../src/server/modules/side-chat/side-chat-texts.js";
import { personalAgentDir } from "../src/server/platform/fs/resources.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { agentRoleOf, agentRoleWhere } from "../src/server/modules/activity/ledger-roles.js";
import { buildMemoryTools } from "../src/server/modules/memory/tools/memory.js";
import type { MemoryManager } from "../src/server/modules/memory/manager.js";
import { candidateCallOptions, type WakeLlmCandidate } from "../src/server/modules/agent/wake-llm-attempts.js";
import { createAgentModelRouter, threadRouteSources } from "../src/server/runtime/agent-model-router.js";
import { createAgentRuntimeProviders } from "../src/server/runtime/agent-providers.js";
import { createAgentRuntimeLlmRecorders } from "../src/server/runtime/agent-llm-recorders.js";
import { loadConfig } from "../src/server/config/load-config.js";
import { configJson } from "./helpers/config-file.js";
import { stub } from "./helpers/typed.js";
import { seedCall } from "./helpers/ledger-seed.js";

// A side chat is offered the personal agent's tools exactly (the prompt
// cache of the main conversation keys on them too) and refuses at the call
// what it may not do. Its background commands are its own; nothing addressed
// to the personal agent reaches it.

function setup() {
  const data = withTempDataDir();
  const env = freshStoresEnv("md-side-scope-");
  const runtime = testAgentRuntime(env, { commandRunner: testShellRunner(tempDir("shell-home-")) });
  onCleanup(() => { runtime.dispose(); data.restore(); });
  // The agent's folder, as the server makes it at its start.
  fs.mkdirSync(personalAgentDir(), { recursive: true });
  const personal = env.agentStore.getOrCreatePersonalThread();
  env.agentStore.ensureSystemMessage(personal.id, "You are the user's personal agent.");
  const open = () => {
    const side = env.agentStore.createSideChatThread();
    env.agentStore.copyConversation(personal.id, side.id);
    return side;
  };
  let n = 0;
  const call = (threadId: string, toolName: string, args: unknown) => {
    const scope = runtime.scopes[env.agentStore.getThreadById(threadId)!.scope];
    return scope.wrappedDispatcher.dispatch(
      { toolCallId: `call_${++n}`, toolName, args },
      { threadId, wakeId: "wake_test", scope: scope.buildToolScope(threadId) }
    );
  };
  const queued = (threadId: string) => env.agentStore.queuedMailboxSources(threadId);
  return { env, runtime, personal, open, call, queued };
}

test("a side chat is offered the personal agent's tools and refuses what it may not run", async () => {
  const s = setup();
  const side = s.open();
  const sideScope = s.runtime.scopes.side_chat;
  expect(Object.keys(sideScope.wrappedDispatcher.registry.tools)).toEqual(Object.keys(s.runtime.scopes.personal.wrappedDispatcher.registry.tools));
  expect(sideScope.toolDefinitions.map((t) => t.name)).toEqual(s.runtime.scopes.personal.toolDefinitions.map((t) => t.name));

  for (const name of ["message_worker", "send_to_thread", "await_stop", "archive_thread", "schedule_wake", "manage_schedule", "create_project",
    "memory_remember", "memory_update", "memory_forget", "subagent", "notify", "ask_user"]) {
    expect({ name, outcome: await s.call(side.id, name, {}) }).toEqual({ name, outcome: { isError: true, error: SIDE_CHAT_REFUSED } });
  }

  const file = path.join(tempDir("md-side-read-"), "notes.md");
  fs.writeFileSync(file, "two items left\n");
  const read = await s.call(side.id, "read", { path: file });
  expect(read.isError).toBeFalsy();
  expect(JSON.stringify(read.result)).toContain("two items left");
  const bash = await s.call(side.id, "bash", { command: "echo side-hello", description: "Say hello" });
  expect(bash.isError).toBeFalsy();
  expect(JSON.stringify(bash.result)).toContain("side-hello");
  const canvas = await s.call(side.id, "canvas", { action: "create", title: "Pricing sketch", kind: "report" });
  expect(canvas.isError).toBeFalsy();
});

test("writes into the agent's notes or page folder are refused", async () => {
  const s = setup();
  const side = s.open();
  const dir = personalAgentDir();
  for (const target of [path.join(dir, "notes", "index.md"), path.join(dir, "page", "index.html")]) {
    expect(await s.call(side.id, "write", { path: target, content: "from a side chat" })).toEqual({ isError: true, error: SIDE_CHAT_REFUSED });
    expect(fs.existsSync(target)).toBe(false);
  }
  const elsewhere = path.join(tempDir("md-side-write-"), "draft.md");
  const wrote = await s.call(side.id, "write", { path: elsewhere, content: "a draft" });
  expect(wrote.isError).toBeFalsy();
  expect(fs.readFileSync(elsewhere, "utf8")).toBe("a draft");
});

test("a side chat's command reports to the side chat, never the main conversation", async () => {
  const s = setup();
  const side = s.open();
  await s.runtime.commands.start({ parentThreadId: side.id, command: "echo done", title: "Finish", cwd: tempDir("md-side-cmd-"), owner: { kind: "global" } });
  await waitUntil(() => s.queued(side.id).includes("command-result"), { label: "the side chat is told its command ended" });
  expect(s.queued(s.personal.id)).toEqual([]);
});

test("each side chat gets its own command results", async () => {
  const s = setup();
  const first = s.open();
  const second = s.open();
  const a = await s.runtime.commands.start({ parentThreadId: first.id, command: "echo a", title: "A", cwd: tempDir("md-side-cmd-a-"), owner: { kind: "global" } });
  const b = await s.runtime.commands.start({ parentThreadId: second.id, command: "echo b", title: "B", cwd: tempDir("md-side-cmd-b-"), owner: { kind: "global" } });
  await waitUntil(() => s.queued(first.id).includes("command-result") && s.queued(second.id).includes("command-result"), { label: "both are told" });
  const taskIdsIn = (threadId: string) => (s.env.store.db.prepare(`select content from agent_mailbox where thread_id = ? and source = 'command-result'`).all(threadId) as Array<{ content: string }>)
    .map((row) => JSON.stringify(row.content));
  expect(taskIdsIn(first.id).join()).toContain(a.id);
  expect(taskIdsIn(first.id).join()).not.toContain(b.id);
  expect(taskIdsIn(second.id).join()).toContain(b.id);
  expect(s.queued(s.personal.id)).toEqual([]);
});

// Every notice for the personal agent (a thread's, a handoff's, a page
// result, a duty report, a schedule's news, voice) is addressed to the
// thread these resolve: never a side chat, whether the side chat was opened
// before or after it.
test("notices for the personal agent never reach a side chat", () => {
  const data = withTempDataDir();
  onCleanup(() => data.restore());
  const env = freshStoresEnv("md-side-notices-");
  const early = env.agentStore.createSideChatThread();
  const personal = env.agentStore.getOrCreatePersonalThread();
  const late = env.agentStore.createSideChatThread();
  expect(personal.id).not.toBe(early.id);
  expect(personal.scope).toBe("personal");
  for (const resolved of [env.agentStore.getOrCreatePersonalThread(), env.agentStore.openPersonalThread(), env.agentStore.getThreadByScope("personal", null), env.agentStore.getOrCreateThread("personal", null)]) {
    expect(resolved?.id).toBe(personal.id);
  }
  expect(env.agentStore.listOpenManagerThreads().map((t) => t.id)).not.toContain(late.id);
});

test("a side chat is recovered after a restart and its command result comes back to it", () => {
  const data = withTempDataDir();
  const env = freshStoresEnv("md-side-restart-");
  const personal = env.agentStore.getOrCreatePersonalThread();
  const side = env.agentStore.createSideChatThread();
  env.agentStore.copyConversation(personal.id, side.id);
  env.agentStore.createWake({ threadId: side.id, reason: "user", triggerMessageId: null });
  const output = path.join(tempDir("md-side-restart-out-"), "out.log");
  fs.writeFileSync(output, "half done\n");
  new BackgroundTaskStore(env.store.db).createCommand({ parentThreadId: side.id, title: "Long build", command: "make", outputPath: output, pid: null, startedAt: new Date().toISOString() });

  const runtime = testAgentRuntime(env, { commandRunner: testShellRunner(tempDir("shell-home-")) });
  onCleanup(() => { runtime.dispose(); data.restore(); });

  expect(env.agentStore.queuedMailboxSources(side.id).sort()).toEqual(["command-result", "restart-recovery"]);
  expect(env.agentStore.queuedMailboxSources(personal.id)).toEqual([]);
});

test("a side chat's calls go on the personal route with the personal cache key", () => {
  const data = withTempDataDir();
  onCleanup(() => data.restore());
  const env = freshStoresEnv("md-side-route-");
  fs.writeFileSync(path.join(env.dir, "config.json"), configJson({
    models: {
      default: { model: "main/gpt-5.5", modelFallbacks: [] },
      providers: {
        main: { type: "openai", apiKey: "main-key", models: [{ id: "gpt-5.5", input: ["text"] }] },
        proxy: { type: "openai-compatible", apiKey: "proxy-key", baseURL: "https://proxy.example/v1", models: [{ id: "chat-1", input: ["text"] }] }
      }
    },
    agent: { personalModel: "main/gpt-5.5", personalModelFallbacks: [{ model: "proxy/chat-1" }] }
  }));
  const config = loadConfig(env.dir);
  const personal = env.agentStore.getOrCreatePersonalThread();
  const side = env.agentStore.createSideChatThread();
  const providers = createAgentRuntimeProviders(config);
  const recorders = createAgentRuntimeLlmRecorders({ config, store: env.store });
  const router = createAgentModelRouter({
    config: () => config, providers: () => providers, recorders: () => recorders, store: env.store,
    ...threadRouteSources({ agentStore: env.agentStore, backgroundTasks: new BackgroundTaskStore(env.store.db) })
  });

  const candidates = router.llmForThread(side.id).candidates as WakeLlmCandidate[];
  expect(candidates.map((c) => c.meta?.model)).toEqual(["gpt-5.5", "chat-1"]);
  const [openai, proxy] = candidates.map((c) => candidateCallOptions(c, side.id, { askSummary: false }));
  expect((openai!.providerOptions?.openai as { promptCacheKey?: string } | undefined)?.promptCacheKey).toBe(personal.id);
  expect(proxy!.headers).toEqual({ "x-session-id": personal.id, "x-session-affinity": personal.id });
  // The personal agent's own calls are unchanged.
  const own = router.llmForThread(personal.id).candidates as WakeLlmCandidate[];
  expect((candidateCallOptions(own[0]!, personal.id, { askSummary: false }).providerOptions?.openai as { promptCacheKey?: string }).promptCacheKey).toBe(personal.id);
});

test("a side chat edits only its own canvases", async () => {
  const s = setup();
  const side = s.open();
  const mine = await s.call(side.id, "canvas", { action: "create", title: "Side draft", kind: "report" });
  const theirs = await s.call(s.personal.id, "canvas", { action: "create", title: "Main plan", kind: "report" });
  const made = (r: { result?: unknown }) => r.result as { canvasId: string; sourcePath: string };
  for (const r of [mine, theirs]) fs.writeFileSync(made(r).sourcePath, "<title>Draft</title><main><p>Draft</p></main>");
  const publish = (canvasId: string) => s.call(side.id, "canvas", { action: "publish", canvasId });
  expect((await publish(made(mine).canvasId)).result).toMatchObject({ ok: true, canvasId: made(mine).canvasId });
  expect((await publish(made(theirs).canvasId)).result).toEqual({ error: "canvas is not editable from this agent scope" });
  // Reading every canvas stays, as the personal agent reads them.
  expect((await s.call(side.id, "canvas", { action: "read", canvasId: made(theirs).canvasId })).result).toMatchObject({ canvasId: made(theirs).canvasId });
});

test("its memory searches count as the personal agent's", async () => {
  const env = freshStoresEnv("md-side-memory-");
  const side = env.agentStore.createSideChatThread();
  const uses: Array<{ agent: string; threadId: string }> = [];
  const memory = stub<MemoryManager>({
    search: async () => [{ entry: { id: "mem_1", type: "preference", title: "Short notes", body: "keep notes short", projectId: null, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } }] as never,
    recordUses: (rows: Array<{ agent: string; threadId: string }>) => { uses.push(...rows); }
  } as never);
  const tools = buildMemoryTools({ memory, scope: "manager", records: { getById: () => null, recent: () => [] } as never, agentStore: env.agentStore, projectsStore: env.projects });
  const search = tools.find((t) => t.name === "memory_search")!;
  await search.handler({ query: "notes" } as never, { threadId: side.id, wakeId: "wake_1", scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] } });
  expect(uses.map((u) => [u.agent, u.threadId])).toEqual([["personal", side.id]]);
});

test("its steps show under the side chat role, with the calls of its summaries", () => {
  expect(agentRoleOf("agent_wake_step", "side_chat")).toBe("side_chat");
  expect(agentRoleOf("side_chat", null)).toBe("side_chat");
  const env = freshStoresEnv("md-side-roles-");
  seedCall(env.store.db, { id: "c_step", t: 0, metadata: { threadScope: "side_chat" } });
  seedCall(env.store.db, { id: "c_summary", purpose: "side_chat", t: 1 });
  seedCall(env.store.db, { id: "c_personal", t: 2, metadata: { threadScope: "personal" } });
  const where = agentRoleWhere("side_chat");
  const ids = (env.store.db.prepare(`select id from llm_calls where ${where.sql} order by id`).all(...where.params) as Array<{ id: string }>).map((r) => r.id);
  expect(ids).toEqual(["c_step", "c_summary"]);
  // Nor are its steps among the unnamed ones.
  const unnamed = agentRoleWhere("purpose:agent_wake_step");
  expect((env.store.db.prepare(`select id from llm_calls where ${unnamed.sql}`).all(...unnamed.params) as Array<{ id: string }>)).toEqual([]);
});

test("after its own compaction drops the first row, the side chat is told again what it is", async () => {
  const s = setup();
  const side = s.open();
  const scope = s.runtime.scopes.side_chat;
  s.env.agentStore.appendMessage({ threadId: side.id, role: "user", source: "side-chat-boundary", content: { type: "text", text: SIDE_CHAT_BOUNDARY } });
  // While the first row is in its window, the context does not repeat it.
  expect(await scope.buildInitialContext?.(side.id) ?? "").not.toContain(SIDE_CHAT_BOUNDARY);
  s.env.agentStore.appendMessage({
    threadId: side.id, role: "user", source: "compression",
    content: { type: "summary", summary: "talked pricing over", replacedRange: [1, 5], replacedCount: 5, compactedCount: 5, retained: [] }
  });
  expect(await scope.buildInitialContext?.(side.id)).toContain(SIDE_CHAT_BOUNDARY);
  // Its system prompt is the personal agent's, and it gets no digest of the
  // agent's state after the fork.
  expect(await scope.buildSystemPrompt(side.id)).toBe(await s.runtime.scopes.personal.buildSystemPrompt(s.personal.id));
  expect(scope.buildRuntimeContext).toBeUndefined();
});

// A side chat is archived only while it is being ended; a restart in that
// wait (its Send waiting on a running call) leaves it open again, not hidden.
test("a side chat a restart caught being ended is open again", () => {
  const data = withTempDataDir();
  const env = freshStoresEnv("md-side-ending-restart-");
  const personal = env.agentStore.getOrCreatePersonalThread();
  const side = env.agentStore.createSideChatThread();
  env.agentStore.copyConversation(personal.id, side.id);
  env.agentStore.archiveThread(side.id);
  const runtime = testAgentRuntime(env, { commandRunner: testShellRunner(tempDir("shell-home-")) });
  onCleanup(() => { runtime.dispose(); data.restore(); });
  expect(env.agentStore.getThreadById(side.id)?.archivedAt).toBeNull();
  expect(runtime.sideChats.list().map((c) => c.id)).toEqual([side.id]);
});
