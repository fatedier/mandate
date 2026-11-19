import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { Hono } from "hono";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { AppDeps } from "../src/server/app/deps.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";
import { API_PATHS } from "../src/shared/api/routes.js";
import type { SideChatDto } from "../src/shared/api/side-chat.js";
import { sideChatModule } from "../src/server/modules/side-chat/module.js";
import { SIDE_CHAT_BOUNDARY, sideChatHandoffRequest } from "../src/server/modules/side-chat/side-chat-texts.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { personalAgentDir } from "../src/server/platform/fs/resources.js";
import { freshStoresEnv, NOOP_WAKE, withTempDataDir } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { RUNS_UNTIL_KILLED, testShellRunner, withRunningCommand } from "./helpers/shell-runner.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { buildAgentsTestApp, buildTestScopes } from "./helpers/test-app.js";
import { waitUntil } from "./helpers/wait.js";
import { stub } from "./helpers/typed.js";
import { tempDir } from "./helpers/temp.js";
import { onCleanup } from "./helpers/cleanup.js";
import { seedCall } from "./helpers/ledger-seed.js";
import { SideChatService } from "../src/server/modules/side-chat/side-chat-service.js";
import { ThreadDeletion } from "../src/server/modules/agent/thread-delete.js";

// A side chat is opened from the personal agent's page, talked in, and ended
// by Send (a summary into the main conversation) or Discard. Ending it stops
// whatever it runs first, and leaves nothing but, for Send, the one message.

type Script = Parameters<typeof createMockLLM>[0];

/** The personal agent's turns answer from `main`, a side chat's from `side`
 *  (told by the boundary in its prompt). A turn waits at its gate while set. */
function setup(main: Script = [], side: Script = []) {
  const data = withTempDataDir();
  const env = freshStoresEnv("md-side-service-");
  const events: Array<{ event: string; data: unknown }> = [];
  const sinks: Array<(e: never) => void> = [];
  const canvasStore = new CanvasStore(env.store.db, env.dir);
  const runtime = testAgentRuntime(env, {
    ready: Promise.resolve(),
    canvasStore,
    // As the server's emitter: what is emitted reaches its sinks.
    sse: stub<AgentSseEmitter>({
      emit: (event, d) => { events.push({ event, data: d }); for (const sink of sinks) sink({ event, data: d } as never); },
      addSink: (sink) => { sinks.push(sink); return () => {}; }
    }),
    commandRunner: withRunningCommand(testShellRunner(tempDir("shell-home-")))
  });
  onCleanup(() => { runtime.dispose(); data.restore(); });
  fs.mkdirSync(personalAgentDir(), { recursive: true });
  const mainModel = createMockLLM(main);
  const sideModel = createMockLLM(side);
  const gates = { main: null as Promise<void> | null, side: null as Promise<void> | null };
  const seen: string[] = [];
  const held = { main: false, side: false };
  const waitGate = async (gate: Promise<void> | null, signal: AbortSignal | undefined) => {
    if (!gate) return;
    await new Promise<void>((resolve, reject) => {
      gate.then(resolve);
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
    });
  };
  const model = {
    ...mainModel,
    doStream: async (options: Parameters<typeof mainModel.doStream>[0]) => {
      const prompt = JSON.stringify(options.prompt);
      seen.push(prompt);
      if (prompt.includes("[Side chat] Everything above")) {
        held.side = Boolean(gates.side);
        await waitGate(gates.side, options.abortSignal);
        return sideModel.doStream(options);
      }
      held.main = Boolean(gates.main);
      await waitGate(gates.main, options.abortSignal);
      return mainModel.doStream(options);
    }
  };
  // A runtime's turns call the model above.
  const drive = (target: ReturnType<typeof testAgentRuntime>) => {
    const deps = (target.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    deps.llmForThread = () => ({ model: model as never });
    deps.beforeModelCallHook = undefined;
    deps.supportsInputForThread = () => true;
    deps.supportsToolResultImagesForThread = () => true;
  };
  drive(runtime);
  const personal = env.agentStore.getOrCreatePersonalThread();
  env.agentStore.ensureSystemMessage(personal.id, "You are the user's personal agent.");
  env.agentStore.appendMessage({ threadId: personal.id, role: "user", source: "user", content: { type: "text", text: "Plan the release." } });
  env.agentStore.appendMessage({ threadId: personal.id, role: "assistant", source: "self", content: { type: "assistant", text: "Two items are left." } });
  const app = new Hono();
  sideChatModule.mountRoutes!(app, { deps: { sideChats: runtime.sideChats } as unknown as AppDeps, upgradeWebSocket: (() => {}) as never });
  const call = (method: string, url: string, body?: unknown) =>
    app.request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
  const say = (threadId: string, text: string) => runtime.userMessageQueue.submitThreadUserMessage({ threadId, content: text, source: "user" });
  const updates = (id: string) => events.filter((e) => e.event === SSE_EVENTS.sideChatUpdated && (e.data as { sideChat: SideChatDto }).sideChat.id === id)
    .map((e) => (e.data as { sideChat: SideChatDto }).sideChat);
  const rows = (threadId: string) => env.store.db.prepare(`select count(*) as n from agent_messages where thread_id = ?`).get(threadId) as { n: number };
  return { env, runtime, events, personal, call, say, updates, rows, gates, held, seen, canvasStore, sideModel, drive };
}

const openOne = async (s: ReturnType<typeof setup>): Promise<SideChatDto> => {
  const res = await s.call("POST", API_PATHS.sideChats());
  expect(res.status).toBe(201);
  return ((await res.json()) as { sideChat: SideChatDto }).sideChat;
};

test("opening a side chat forks the personal agent and lists it", async () => {
  const s = setup();
  s.env.agentStore.setThreadModelOverride(s.personal.id, "main/gpt-5.5");
  const chat = await openOne(s);
  const thread = s.env.agentStore.getThreadById(chat.id)!;
  expect(thread.scope).toBe("side_chat");
  const last = s.env.agentStore.getActiveMessages(chat.id).at(-1)!;
  expect([last.source, last.content]).toEqual(["side-chat-boundary", { type: "text", text: SIDE_CHAT_BOUNDARY }]);
  // It runs on the model the agent runs on now, and nothing in it is new.
  expect(s.env.agentStore.threadModelOverride(chat.id)).toBe("main/gpt-5.5");
  expect(chat).toMatchObject({ title: "New side chat", named: false, working: false });
  expect(chat.seenSeq).toBeGreaterThanOrEqual(chat.lastVisibleSeq);
  expect(s.updates(chat.id)).toHaveLength(1);
  const listed = (await (await s.call("GET", API_PATHS.sideChats())).json()) as { sideChats: SideChatDto[] };
  expect(listed.sideChats.map((c) => c.id)).toEqual([chat.id]);
  // The main conversation is as it was.
  expect(s.env.agentStore.getActiveMessages(s.personal.id).map((m) => m.source)).toEqual(["user", "self"]);
});

test("the side chat's transcript starts at its boundary row", async () => {
  const s = setup();
  const chat = await openOne(s);
  s.env.agentStore.appendMessage({ threadId: chat.id, role: "user", source: "user", content: { type: "text", text: "What about pricing?" } });
  const app = buildAgentsTestApp({ agentStore: s.env.agentStore, wakeScheduler: NOOP_WAKE, scopes: buildTestScopes(s.env.workers) });
  const page = (await (await app.request(`${API_PATHS.agentThread(chat.id)}?limit=50`)).json()) as { messages: Array<{ source: string }>; hasMore: boolean };
  expect(page.messages.map((m) => m.source)).toEqual(["side-chat-boundary", "user"]);
  expect(page.hasMore).toBe(false);
  const boundarySeq = s.env.agentStore.getActiveMessages(chat.id).find((m) => m.source === "side-chat-boundary")!.seq;
  const older = (await (await app.request(`${API_PATHS.agentThread(chat.id)}?before=${boundarySeq}`)).json()) as { messages: unknown[] };
  expect(older.messages).toEqual([]);
  const since = (await (await app.request(`${API_PATHS.agentThread(chat.id)}?since=0`)).json()) as { messages: Array<{ source: string }> };
  expect(since.messages.map((m) => m.source)).toEqual(["side-chat-boundary", "user"]);
});

test("the list follows its work", async () => {
  const s = setup([], [{ text: "Pricing by seat reads simplest." }, { text: "The wait was stopped." }]);
  const chat = await openOne(s);
  let release!: () => void;
  s.gates.side = new Promise<void>((resolve) => { release = resolve; });
  s.say(chat.id, "What about pricing?");
  await waitUntil(() => s.runtime.sideChats.dto(chat.id)?.working, { label: "working while its turn runs" });
  release();
  await waitUntil(() => s.runtime.sideChats.dto(chat.id)?.working === false, { label: "idle after its turn" });
  const after = s.runtime.sideChats.dto(chat.id)!;
  expect(after.lastVisibleSeq).toBeGreaterThan(after.seenSeq);
  expect(after.title).toBe("What about pricing?");
  // A background command keeps it working until it ends.
  const task = await s.runtime.commands.start({ parentThreadId: chat.id, command: RUNS_UNTIL_KILLED, title: "Wait", cwd: tempDir("md-side-cmd-"), owner: { kind: "global" } });
  await waitUntil(() => s.runtime.sideChats.dto(chat.id)?.working, { label: "working while its command runs" });
  s.runtime.commands.stop(task.id, "user");
  // Its end is the side chat's to hear: a turn reads it, and then it rests.
  await waitUntil(() => s.env.agentStore.queuedMailboxSources(chat.id).length === 0
    && s.runtime.sideChats.dto(chat.id)?.working === false
    && s.updates(chat.id).at(-1)?.working === false, { label: "idle once the command ended and its end was read" });
  const seen = s.updates(chat.id);
  expect(seen.some((d) => d.working)).toBe(true);
  expect(seen.at(-1)!.working).toBe(false);
});

test("a summary is written on the side chat's own context", async () => {
  const s = setup([], [{ text: "Decided: seat pricing. Open: the free tier." }]);
  const chat = await openOne(s);
  s.env.agentStore.appendMessage({ threadId: chat.id, role: "user", source: "user", content: { type: "text", text: "What about pricing?" } });
  const res = await s.call("POST", API_PATHS.sideChatSummary(chat.id));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ summary: "Decided: seat pricing. Open: the free tier." });
  const prompt = s.seen.at(-1)!;
  for (const part of ["Plan the release.", "Two items are left.", "What about pricing?", JSON.stringify(sideChatHandoffRequest("")).slice(1, 60)]) {
    expect(prompt).toContain(part);
  }
  // Nothing of it is written anywhere.
  expect(s.env.agentStore.getActiveMessages(chat.id).at(-1)!.content).toEqual({ type: "text", text: "What about pricing?" });
});

test("send puts one message in the main conversation and ends the side chat", async () => {
  const s = setup([{ text: "On it." }]);
  const chat = await openOne(s);
  s.env.agentStore.appendMessage({ threadId: chat.id, role: "user", source: "user", content: { type: "text", text: "What about pricing?" } });
  const canvas = s.canvasStore.create({ title: "Pricing sketch", scope: "manager", scopeId: null, threadId: chat.id, kind: "report", projectId: null });
  const res = await s.call("POST", API_PATHS.sideChatSend(chat.id), { summary: "Seat pricing.", note: "Go with it." });
  expect(res.status).toBe(200);
  const sent = s.env.agentStore.getActiveMessages(s.personal.id).filter((m) => m.content.type === "text" && m.content.sideChat);
  expect(sent).toHaveLength(1);
  const part = (sent[0]!.content as { sideChat: { summary: string; note: string; file: string } }).sideChat;
  expect([part.summary, part.note]).toEqual(["Seat pricing.", "Go with it."]);
  expect(fs.readFileSync(part.file, "utf8")).toContain("What about pricing?");
  expect(s.env.agentStore.getThreadById(chat.id)).toBeNull();
  expect(s.rows(chat.id).n).toBe(0);
  expect(s.canvasStore.getById(canvas.id)?.threadId).toBe(s.personal.id);
  expect(s.events.some((e) => e.event === SSE_EVENTS.sideChatDeleted && (e.data as { id: string }).id === chat.id)).toBe(true);
  expect(s.runtime.sideChats.list()).toEqual([]);
});

test("send while the main conversation is busy: the message waits in order, and the side chat stays until it lands", async () => {
  const s = setup([{ text: "Working on the release." }, { text: "Read the side chat." }]);
  const chat = await openOne(s);
  let release!: () => void;
  s.gates.main = new Promise<void>((resolve) => { release = resolve; });
  s.say(s.personal.id, "Carry on.");
  await waitUntil(() => s.held.main, { label: "the main turn is mid-step" });
  expect((await s.call("POST", API_PATHS.sideChatSend(chat.id), { summary: "Seat pricing.", note: "" })).status).toBe(200);
  // Typed after the Send, while the turn still runs: it comes after it.
  s.say(s.personal.id, "Actually, wait for my go.");
  const texts = () => s.env.agentStore.getActiveMessages(s.personal.id)
    .filter((m) => m.role === "user" && m.source === "user" && m.content.type === "text")
    .map((m) => (m.content as { text: string; sideChat?: unknown }).sideChat ? "hand-over" : (m.content as { text: string }).text);
  expect(texts()).toEqual(["Plan the release.", "Carry on."]);
  // Not gone until its message is in: hidden meanwhile, in every window.
  expect(s.env.agentStore.getThreadById(chat.id)?.archivedAt).not.toBeNull();
  expect(s.runtime.sideChats.list()).toEqual([]);
  expect(s.events.some((e) => e.event === SSE_EVENTS.sideChatDeleted && (e.data as { id: string }).id === chat.id)).toBe(true);
  s.gates.main = null;
  release();
  await waitUntil(() => texts().length === 4, { label: "both landed" });
  expect(texts()).toEqual(["Plan the release.", "Carry on.", "hand-over", "Actually, wait for my go."]);
  await waitUntil(() => s.env.agentStore.getThreadById(chat.id) === null, { label: "the side chat goes once its message is in" });
  expect(s.events.some((e) => e.event === SSE_EVENTS.sideChatDeleted && (e.data as { id: string }).id === chat.id)).toBe(true);
});

test("a Send still waiting when the server restarts is delivered after it, note and all", async () => {
  const s = setup([{ text: "Back on the release." }, { text: "Read the side chat." }]);
  const chat = await openOne(s);
  s.gates.main = new Promise<void>(() => {});
  s.say(s.personal.id, "Carry on.");
  await waitUntil(() => s.held.main, { label: "the main turn is mid-step" });
  expect((await s.call("POST", API_PATHS.sideChatSend(chat.id), { summary: "Seat pricing.", note: "Go with it." })).status).toBe(200);
  // The server goes away with the message still waiting behind the turn.
  s.runtime.dispose();
  let start!: () => void;
  const again = testAgentRuntime(s.env, { ready: new Promise<void>((resolve) => { start = resolve; }), commandRunner: testShellRunner(tempDir("shell-home-")) });
  onCleanup(() => again.dispose());
  // Still hidden: it is on its way, behind the interrupted turn resumed first.
  expect(again.sideChats.list()).toEqual([]);
  s.drive(again);
  s.gates.main = null;
  start();
  const sent = () => s.env.agentStore.getActiveMessages(s.personal.id).filter((m) => m.content.type === "text" && m.content.sideChat);
  await waitUntil(() => sent().length === 1, { label: "the hand-over lands after the restart" });
  expect(sent().map((m) => (m.content as { sideChat: { summary: string; note: string } }).sideChat)).toMatchObject([{ summary: "Seat pricing.", note: "Go with it." }]);
  await waitUntil(() => s.env.agentStore.getThreadById(chat.id) === null, { label: "the side chat goes once its message is in" });
  expect(again.sideChats.list()).toEqual([]);
}, 30_000);

test("discard leaves nothing", async () => {
  const s = setup();
  const chat = await openOne(s);
  const canvas = s.canvasStore.create({ title: "Dropped idea", scope: "manager", scopeId: null, threadId: chat.id, kind: "report", projectId: null });
  const before = s.env.agentStore.getActiveMessages(s.personal.id).map((m) => m.id);
  const res = await s.call("DELETE", API_PATHS.sideChat(chat.id));
  expect(res.status).toBe(200);
  expect(s.env.agentStore.getThreadById(chat.id)).toBeNull();
  expect(s.rows(chat.id).n).toBe(0);
  expect(s.canvasStore.getById(canvas.id)).toBeNull();
  expect(s.env.agentStore.getActiveMessages(s.personal.id).map((m) => m.id)).toEqual(before);
  expect((await s.call("DELETE", API_PATHS.sideChat(chat.id))).status).toBe(404);
});

for (const end of ["send", "discard"] as const) {
  test(`ending a busy side chat stops its turn and commands first (${end})`, async () => {
    const s = setup([], [{ text: "never written" }]);
    const chat = await openOne(s);
    s.gates.side = new Promise<void>(() => {});
    s.say(chat.id, "Think it over.");
    await waitUntil(() => s.held.side, { label: "its turn is mid-step" });
    const task = await s.runtime.commands.start({ parentThreadId: chat.id, command: RUNS_UNTIL_KILLED, title: "Wait", cwd: tempDir("md-side-busy-"), owner: { kind: "global" } });
    const res = end === "send"
      ? await s.call("POST", API_PATHS.sideChatSend(chat.id), { summary: "Nothing yet.", note: "" })
      : await s.call("DELETE", API_PATHS.sideChat(chat.id));
    expect(res.status).toBe(200);
    expect(s.env.agentStore.getThreadById(chat.id)).toBeNull();
    expect(s.runtime.backgroundTasks.get(task.id)).toBeNull();
    expect(s.runtime.wakeScheduler.isThreadBusy(chat.id)).toBe(false);
    const landed = s.env.agentStore.getActiveMessages(s.personal.id).filter((m) => m.content.type === "text" && m.content.sideChat);
    expect(landed).toHaveLength(end === "send" ? 1 : 0);
    // Its command's end reached nobody.
    expect(s.env.agentStore.queuedMailboxSources(s.personal.id)).toEqual([]);
  });
}

test("rename and seen", async () => {
  const s = setup();
  const chat = await openOne(s);
  const renamed = (await (await s.call("PATCH", API_PATHS.sideChat(chat.id), { title: "Pricing  " })).json()) as { sideChat: SideChatDto };
  expect([renamed.sideChat.title, renamed.sideChat.named]).toEqual(["Pricing", true]);
  expect((await s.call("PATCH", API_PATHS.sideChat(chat.id), { title: "" })).status).toBe(400);
  const seen = (await (await s.call("POST", API_PATHS.sideChatSeen(chat.id), { seq: chat.seenSeq + 5 })).json()) as { sideChat: SideChatDto };
  expect(seen.sideChat.seenSeq).toBe(chat.seenSeq + 5);
  const back = (await (await s.call("POST", API_PATHS.sideChatSeen(chat.id), { seq: 1 })).json()) as { sideChat: SideChatDto };
  expect(back.sideChat.seenSeq).toBe(chat.seenSeq + 5);
  expect((await s.call("POST", API_PATHS.sideChatSeen("thr_gone"), { seq: 1 })).status).toBe(404);
});

// A call of the side chat's still running (a cache seal goes out minutes
// after its last step) holds its end back: before anything is sent, so a
// Send tried again sends once.
test("a model call of the side chat still running holds Send back before anything goes", async () => {
  const data = withTempDataDir();
  onCleanup(() => data.restore());
  const env = freshStoresEnv("md-side-send-held-");
  const submitted: unknown[] = [];
  const service = new SideChatService({
    agentStore: env.agentStore,
    backgroundTasks: { countRunning: () => 0 },
    sends: { add: () => {}, remove: () => {}, list: () => [] },
    queue: { flushQueuedIntoThread: () => [], submitThreadUserMessage: (input) => { submitted.push(input); return { threadId: "", messageId: "m", wakeId: null, queued: false }; } },
    deletion: new ThreadDeletion({ db: env.store.db, agentStore: env.agentStore, canvases: new CanvasStore(env.store.db, env.dir) }),
    sse: { emit: () => {} },
    turnRunning: () => false,
    stopWork: () => {},
    stepPrompt: async () => { throw new Error("not asked"); },
    callModel: async () => ({ text: "", cutOff: false }),
    archiveDir: () => tempDir("md-side-send-held-files-"),
    timeZone: "UTC",
    now: () => new Date(),
    wait: async () => {}
  });
  const chat = service.open();
  seedCall(env.store.db, { id: "c_seal", purpose: "agent_cache_seal", scopeType: "agent_thread", scopeId: chat.id, status: "running", t: 0 });
  expect(await service.send(chat.id, { summary: "Seat pricing.", note: "" })).toMatchObject({ status: 409 });
  expect(submitted).toHaveLength(0);
  // Still there, and listed again.
  expect(service.list().map((c) => c.id)).toEqual([chat.id]);
  env.store.db.prepare("update llm_calls set status = 'succeeded' where id = 'c_seal'").run();
  expect(await service.send(chat.id, { summary: "Seat pricing.", note: "" })).toEqual({ ok: true });
  expect(submitted).toHaveLength(1);
});

test("ending a side chat starts no turn of its own: mail waiting behind its turn is not read", async () => {
  const s = setup([], [{ text: "first" }, { text: "second" }]);
  const chat = await openOne(s);
  s.gates.side = new Promise<void>(() => {});
  s.say(chat.id, "Think it over.");
  await waitUntil(() => s.held.side, { label: "its turn is mid-step" });
  // A command of its ended while the turn ran: its result waits in the mailbox.
  s.env.agentStore.enqueueMailboxMessage({ threadId: chat.id, role: "user", source: "command-result", content: { type: "text", text: "Command finished." } });
  const wakes = () => (s.env.store.db.prepare("select count(*) as n from agent_wakes where thread_id = ?").get(chat.id) as { n: number }).n;
  expect(wakes()).toBe(1);
  const res = await s.call("DELETE", API_PATHS.sideChat(chat.id));
  expect(res.status).toBe(200);
  expect(s.env.agentStore.getThreadById(chat.id)).toBeNull();
  expect(s.env.store.db.prepare("select count(*) as n from agent_wakes where thread_id = ?").get(chat.id)).toEqual({ n: 0 });
  // Nothing of it ran after the end: the side model answered no second step.
  expect(s.sideModel.callsMade).toBe(0);
}, 30_000);

test("words still queued in the side chat at Send are kept in its file", async () => {
  const s = setup([], [{ text: "never written" }]);
  const chat = await openOne(s);
  s.gates.side = new Promise<void>(() => {});
  s.say(chat.id, "Think it over.");
  await waitUntil(() => s.held.side, { label: "its turn is mid-step" });
  // Typed while it worked: waiting behind its turn.
  s.say(chat.id, "And what about the free tier?");
  expect(s.runtime.userMessageQueue.pendingCount(chat.id)).toBe(1);
  expect((await s.call("POST", API_PATHS.sideChatSend(chat.id), { summary: "Seat pricing.", note: "" })).status).toBe(200);
  const sent = s.env.store.db.prepare(`select content from agent_mailbox where thread_id = ? and source = 'user'`).get(s.personal.id) as { content: string } | null
    ?? s.env.store.db.prepare(`select content from agent_messages where thread_id = ? and source = 'user' order by seq desc limit 1`).get(s.personal.id) as { content: string };
  const file = (JSON.parse(sent.content) as { sideChat: { file: string } }).sideChat.file;
  expect(fs.readFileSync(file, "utf8")).toContain("And what about the free tier?");
}, 30_000);

test("an end waits for a compaction under way, not only the usual few seconds", async () => {
  const data = withTempDataDir();
  onCleanup(() => data.restore());
  const env = freshStoresEnv("md-side-compacting-");
  let compactingFor = 260;
  const submitted: unknown[] = [];
  const service = new SideChatService({
    agentStore: env.agentStore,
    backgroundTasks: { countRunning: () => 0 },
    sends: { add: () => {}, remove: () => {}, list: () => [] },
    queue: { flushQueuedIntoThread: () => [], submitThreadUserMessage: (input) => { submitted.push(input); return { threadId: "", messageId: "m", wakeId: null, queued: false }; } },
    deletion: new ThreadDeletion({ db: env.store.db, agentStore: env.agentStore, canvases: new CanvasStore(env.store.db, env.dir) }),
    sse: { emit: () => {} },
    // A compaction holds the thread: 260 polls of 50 ms, past the 10 s an end waits for its work.
    turnRunning: () => compactingFor > 0,
    compacting: () => compactingFor > 0,
    stopWork: () => {},
    stepPrompt: async () => { throw new Error("not asked"); },
    callModel: async () => ({ text: "", cutOff: false }),
    archiveDir: () => tempDir("md-side-compacting-files-"),
    timeZone: "UTC",
    now: () => new Date(),
    wait: async () => { compactingFor -= 1; }
  });
  const chat = service.open();
  expect(await service.send(chat.id, { summary: "Seat pricing.", note: "" })).toEqual({ ok: true });
  expect(submitted).toHaveLength(1);
});

test("summary, Send and Discard keep their request open past the server's idle timeout", async () => {
  const s = setup([], [{ text: "Seat pricing." }]);
  const chat = await openOne(s);
  const asked: Array<{ path: string; seconds: number }> = [];
  const server = { timeout: (request: Request, seconds: number) => { asked.push({ path: new URL(request.url).pathname, seconds }); } };
  const app = new Hono();
  sideChatModule.mountRoutes!(app, { deps: { sideChats: s.runtime.sideChats } as unknown as AppDeps, upgradeWebSocket: (() => {}) as never });
  const call = (method: string, url: string, body?: unknown) =>
    app.request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }, { server });
  await call("POST", API_PATHS.sideChatSummary(chat.id));
  await call("POST", API_PATHS.sideChatSend(chat.id), { summary: "Seat pricing.", note: "" });
  const other = await openOne(s);
  await call("DELETE", API_PATHS.sideChat(other.id));
  expect(asked.map((a) => a.path)).toEqual([API_PATHS.sideChatSummary(chat.id), API_PATHS.sideChatSend(chat.id), API_PATHS.sideChat(other.id)]);
  // Longer than the end waits for a compaction.
  expect(asked.every((a) => a.seconds >= 150)).toBe(true);
});
