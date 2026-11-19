import { afterEach, expect, test } from "bun:test";
import { answersMetadata } from "../src/shared/questions.js";
import { Hono } from "hono";
import { freshStoresEnv, seedWorker, seedProject, NOOP_WAKE, type StoresEnv } from "./helpers/fixtures.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import { HandoffService } from "../src/server/modules/personal/handoff-service.js";
import { PersonalAgentService, startPersonalAgentBroadcast } from "../src/server/modules/personal/personal-agent-service.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { mountPersonalAgentRoutes } from "../src/server/modules/personal/personal-http.js";
import { buildAgentsTestApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/server/config/load-config.js";
import type { PersonalAgentDto } from "../src/shared/api/personal-agent.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";
import type { ThreadStop } from "../src/shared/thread-dot.js";
import { deleteCodexAuthProfile, saveCodexTokens, type AuthStoreFile } from "../src/server/modules/codex/codex-auth-store.js";
import { MemoryJsonStore } from "./helpers/memory-json-store.js";
import { allMessages } from "./helpers/thread-messages.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function setup(name = "", heldBack?: (threadId: string) => { times: number; reason: string } | null) {
  env = freshStoresEnv("md-global-http-");
  const config = loadConfig(env.dir);
  config.agent.personalAgentName = name;
  let handoffs!: HandoffService;
  const queue = new AgentUserMessageQueue({
    agentStore: env.agentStore,
    wakeScheduler: NOOP_WAKE,
    onMessageAppended: (threadId, message) => handoffs.noteAppended(threadId, message)
  });
  // How each target stands, as the runtime would read it: a test says when one has stopped.
  const stops = new Map<string, ThreadStop>();
  handoffs = new HandoffService({ db: env.store.db, agentStore: env.agentStore, workersStore: env.workers, queue, stopOf: (id) => stops.get(id) ?? null });
  const published: PersonalAgentDto[] = [];
  const service = new PersonalAgentService({ agentStore: env.agentStore, handoffs, config, emit: (agent) => published.push(agent), ...(heldBack ? { heldBack } : {}) });
  const app = new Hono();
  mountPersonalAgentRoutes(app, { personalAgent: service });
  return { env, config, handoffs, service, app, published, stops };
}

test("GET creates the thread once and says whether it is named", async () => {
  const s = setup("");
  const first = await (await s.app.request("/api/agents/personal")).json() as { agent: PersonalAgentDto };
  expect(first.agent).toMatchObject({ name: "", named: false, unread: false });
  const again = await (await s.app.request("/api/agents/personal")).json() as { agent: PersonalAgentDto };
  expect(again.agent.threadId).toBe(first.agent.threadId);
  s.config.agent.personalAgentName = "Jarvis";
  expect(s.service.state()).toMatchObject({ name: "Jarvis", named: true });
});

// The row's dot follows the agent's own words: a notice of another thread is
// no word to the user (what needs them wakes the agent, and it says so).
test("a message the user has not seen makes it unread, not a notice; viewing clears it; a wait that ends is no cause of its own", async () => {
  const s = setup("Jarvis");
  const { threadId } = s.service.state();
  s.env.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text: "Two things wait on you.", toolCalls: [] } });
  expect(s.service.state().unread).toBe(true);
  const seen = await s.app.request("/api/agents/personal/seen", { method: "POST", body: JSON.stringify({ seq: s.service.state().lastVisibleSeq }), headers: { "content-type": "application/json" } });
  expect(((await seen.json()) as { agent: PersonalAgentDto }).agent.unread).toBe(false);
  // A wait ends. This service tells nobody (no notify), so no message is
  // written here: the row stays clear.
  const projectId = seedProject(s.env.projects, { name: "m", workingDir: "/tmp/m", tmuxSessionName: "m" });
  const workerId = seedWorker(s.env.workers, projectId, { name: "release" });
  const sent = s.handoffs.sendToWorker({ personalThreadId: threadId, workerId, text: "x", spoken: false });
  const workerThread = s.env.agentStore.getThreadByScope("worker", workerId)!;
  await Bun.sleep(2);
  s.stops.set(workerThread.id, "stopped");
  s.handoffs.noteSettled(workerThread.id);
  expect(s.handoffs.dto(sent.id)!.state).toBe("replied");
  expect(s.service.state().unread).toBe(false);
  // The notice alone lights nothing: the agent may only follow up. It is
  // still read to: the page marks it seen.
  const notice = s.env.agentStore.appendMessage({ threadId, role: "user", source: "thread-notice", content: { type: "text", text: "[Thread notice] Worker release (f): stopped." } });
  expect([s.service.state().unread, s.service.state().lastVisibleSeq]).toEqual([false, notice.seq]);
  s.service.markSeen(s.service.state().lastVisibleSeq);
  expect(s.service.state().seenSeq).toBe(notice.seq);
  // The agent's words after it do.
  s.env.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text: "release answered.", toolCalls: [] } });
  expect(s.service.state().unread).toBe(true);
  s.service.markSeen(s.service.state().lastVisibleSeq);
  expect(s.service.state().unread).toBe(false);
  // Seen never moves backwards.
  s.service.markSeen(0);
  expect(s.service.state().unread).toBe(false);
});

// Where the user has read to: a page coming back to the conversation marks
// what came after it as new before it marks it seen.
test("the agent's state says where the user has read to", async () => {
  const s = setup("Jarvis");
  const { threadId } = s.service.state();
  expect(s.service.state().seenSeq).toBe(0);
  const read = s.env.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text: "The build is green.", toolCalls: [] } });
  s.service.markSeen(read.seq);
  s.env.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text: "A spike alert came in.", toolCalls: [] } });
  const agent = ((await (await s.app.request("/api/agents/personal")).json()) as { agent: PersonalAgentDto }).agent;
  expect([agent.seenSeq, agent.lastVisibleSeq > agent.seenSeq]).toEqual([read.seq, true]);
});

test("a service given no name for the agent stamps none on what it sends", () => {
  const s = setup();
  const { threadId } = s.service.state();
  const target = s.env.agentStore.createManagerThread("PR reviews");
  s.handoffs.sendToThread({ personalThreadId: threadId, threadId: target.id, text: "look at #15", spoken: false });
  const [message] = allMessages(s.env.agentStore, target.id);
  expect(message!.content.type === "text" && message!.content.relay).toEqual({ by: "personal", spoken: false, handoffId: expect.any(String) });
});

test("the proposal route is gone: nothing answers it", async () => {
  const s = setup();
  const response = await s.app.request("/api/agents/personal/proposals/hof_1", { method: "POST", body: JSON.stringify({ choice: "thread" }), headers: { "content-type": "application/json" } });
  expect(response.status).toBe(404);
});

test("the thread messages route accepts the personal agent's thread", async () => {
  const s = setup();
  const { threadId } = s.service.state();
  const queue = new AgentUserMessageQueue({ agentStore: s.env.agentStore, wakeScheduler: NOOP_WAKE });
  const agents = buildAgentsTestApp({ agentStore: s.env.agentStore, wakeScheduler: NOOP_WAKE, userMessageQueue: queue, scopes: {} as never });
  const res = await agents.request(`/api/agents/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ content: "what needs me?" }), headers: { "content-type": "application/json" } });
  expect(res.status).toBe(202);
  expect(allMessages(s.env.agentStore, threadId).map((m) => (m.content as { text: string }).text)).toEqual(["what needs me?"]);
});

test("the state is re-published after the personal agent's thread or a handoff changed, once per burst, never for another thread", async () => {
  const s = setup("Jarvis");
  const sse = new AgentSseEmitter();
  const stop = startPersonalAgentBroadcast({ sse, service: s.service, agentStore: s.env.agentStore });
  const { threadId } = s.service.state();
  const other = s.env.agentStore.createManagerThread("PR reviews");
  const elsewhere = s.env.agentStore.appendMessage({ threadId: other.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
  sse.emit("agentMessageAppended", { threadId: other.id, message: elsewhere });
  await Promise.resolve();
  expect(s.published).toStrictEqual([]);
  const answer = s.env.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text: "Two things wait on you.", toolCalls: [] } });
  sse.emit("agentMessageAppended", { threadId, message: answer });
  sse.emit("agentWakeStarted", { threadId, wakeId: "wk_1", reason: "user", startedAt: "2026-10-05T10:00:00.000Z", scope: "personal", scopeId: null });
  await Promise.resolve();
  expect(s.published.map((a) => a.unread)).toStrictEqual([true]);
  const sent = s.handoffs.sendToThread({ personalThreadId: threadId, threadId: other.id, text: "x", spoken: false });
  sse.emit("personalHandoffUpdated", { handoff: sent });
  await Promise.resolve();
  expect(s.published).toHaveLength(2);
  stop();
  sse.emit("personalHandoffUpdated", { handoff: sent });
  await Promise.resolve();
  expect(s.published).toHaveLength(2);
});

test("the state is re-published when Codex is signed in or out (voice may turn on or off), until stopped", () => {
  const s = setup();
  const sse = new AgentSseEmitter();
  const stop = startPersonalAgentBroadcast({ sse, service: s.service, agentStore: s.env.agentStore });
  const store = new MemoryJsonStore<AuthStoreFile>({});
  saveCodexTokens("codex", { access_token: "a", refresh_token: "r", expires_in: 3600 }, store);
  expect(s.published).toHaveLength(1);
  deleteCodexAuthProfile("codex", store);
  expect(s.published).toHaveLength(2);
  stop();
  saveCodexTokens("codex", { access_token: "a", refresh_token: "r", expires_in: 3600 }, store);
  expect(s.published).toHaveLength(2);
});

test("the handoffs asked for by id, as they stand now; unknown ids are skipped", async () => {
  const s = setup();
  const { threadId } = s.service.state();
  const target = s.env.agentStore.createManagerThread("PR reviews");
  const a = s.handoffs.sendToThread({ personalThreadId: threadId, threadId: target.id, text: "look at #15", spoken: false });
  const armed = s.handoffs.awaitStop({ personalThreadId: threadId, threadId: target.id });
  if (!("handoff" in armed)) throw new Error("expected a wait");
  const b = armed.handoff;
  type Listed = { handoffs: Array<{ id: string; state: string }> };
  const read = async (query: string) => (await (await s.app.request(`/api/agents/personal/handoffs${query}`)).json()) as Listed;
  expect((await read(`?ids=${a.id},hof_nope,${b.id}`)).handoffs.map((h) => [h.id, h.state])).toEqual([[a.id, "delivered"], [b.id, "waiting"]]);
  // Read as it stands now: its thread archived since, the wait is failed.
  s.env.agentStore.archiveThread(target.id);
  expect((await read(`?ids=${a.id}`)).handoffs[0]!.state).toBe("failed");
  expect((await read("")).handoffs).toEqual([]);
  // Read by id only: a since query reads nothing, a failed one included.
  expect((await read("?since=2000-01-01T00:00:00.000Z")).handoffs).toEqual([]);
});

test("the agent's state carries the questions it asked and the user has not answered", () => {
  const s = setup("Jarvis");
  const { threadId } = s.service.state();
  expect(s.service.state().questions).toEqual([]);
  const asked = s.env.agentStore.appendMessage({
    threadId, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c1", toolName: "ask_user", result: { asked: true, questionId: "q_1", question: "Tag 3.21 today?", options: [] } }
  });
  expect(s.service.state().questions).toEqual([{ id: "q_1", question: "Tag 3.21 today?", options: [], askedAt: asked.createdAt }]);
  // Spoken words name no question: it stands until it is answered by name.
  s.env.agentStore.appendMessage({ threadId, role: "user", source: "voice", content: { type: "text", text: "Yes, tag it." } });
  expect(s.service.state().questions.map((q) => q.id)).toEqual(["q_1"]);
  s.env.agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: "Tag it", metadata: answersMetadata([{ id: "q_1", question: "Tag 3.21 today?" }]) } });
  expect(s.service.state().questions).toEqual([]);
});

test("its state carries the tool-call review's mark on its thread, and a new status republishes it", async () => {
  let held: { times: number; reason: string } | null = null;
  const { service } = setup("", () => held);
  expect(service.state().heldBack).toBeNull();
  held = { times: 3, reason: "Deletes the shared build." };
  expect(service.state().heldBack).toEqual({ times: 3, reason: "Deletes the shared build." });
  // What Home shows changed (a subagent's hold, say): the state is sent again.
  const sse = new AgentSseEmitter();
  const sent: unknown[] = [];
  sse.addSink((e) => { if (e.event === SSE_EVENTS.personalAgentUpdated) sent.push(e.data); });
  const republished = new PersonalAgentService({ agentStore: env!.agentStore, handoffs: undefined as never, config: loadConfig(env!.dir), heldBack: () => held, emit: (agent) => sse.emit(SSE_EVENTS.personalAgentUpdated, { agent }) });
  const stop = startPersonalAgentBroadcast({ sse, service: republished, agentStore: env!.agentStore });
  sse.emit(SSE_EVENTS.threadStatus, { threads: [], waiting: [] });
  await Promise.resolve();
  stop();
  expect(sent).toHaveLength(1);
});
