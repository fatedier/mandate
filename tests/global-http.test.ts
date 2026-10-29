import { afterEach, expect, test } from "bun:test";
import { answersMetadata } from "../src/shared/questions.js";
import { Hono } from "hono";
import { freshStoresEnv, seedFeature, seedProject, NOOP_WAKE, type StoresEnv } from "./helpers/fixtures.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import { HandoffService } from "../src/server/modules/global/handoff-service.js";
import { GlobalAgentService, startGlobalAgentBroadcast } from "../src/server/modules/global/global-agent-service.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { mountGlobalAgentRoutes } from "../src/server/modules/global/global-http.js";
import { buildAgentsTestApp } from "./helpers/test-app.js";
import { loadConfig } from "../src/server/config/load-config.js";
import type { GlobalAgentDto } from "../src/shared/api/global-agent.js";
import type { ThreadStop } from "../src/shared/thread-dot.js";
import { deleteCodexAuthProfile, saveCodexTokens, type AuthStoreFile } from "../src/server/modules/codex/codex-auth-store.js";
import { MemoryJsonStore } from "./helpers/memory-json-store.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function setup(name = "") {
  env = freshStoresEnv("md-global-http-");
  const config = loadConfig(env.dir);
  config.agent.globalAgentName = name;
  let handoffs!: HandoffService;
  const queue = new AgentUserMessageQueue({
    agentStore: env.agentStore,
    wakeScheduler: NOOP_WAKE,
    onMessageAppended: (threadId, message) => handoffs.noteAppended(threadId, message)
  });
  // How each target stands, as the runtime would read it: a test says when one has stopped.
  const stops = new Map<string, ThreadStop>();
  handoffs = new HandoffService({ db: env.store.db, agentStore: env.agentStore, featuresStore: env.features, queue, stopOf: (id) => stops.get(id) ?? null });
  const published: GlobalAgentDto[] = [];
  const service = new GlobalAgentService({ agentStore: env.agentStore, handoffs, config, emit: (agent) => published.push(agent) });
  const app = new Hono();
  mountGlobalAgentRoutes(app, { globalAgent: service });
  return { env, config, handoffs, service, app, published, stops };
}

test("GET creates the thread once and says whether it is named", async () => {
  const s = setup("");
  const first = await (await s.app.request("/api/agents/global")).json() as { agent: GlobalAgentDto };
  expect(first.agent).toMatchObject({ name: "", named: false, unread: false });
  const again = await (await s.app.request("/api/agents/global")).json() as { agent: GlobalAgentDto };
  expect(again.agent.threadId).toBe(first.agent.threadId);
  s.config.agent.globalAgentName = "Jarvis";
  expect(s.service.state()).toMatchObject({ name: "Jarvis", named: true });
});

// What comes back is a message (the notice, then the
// agent's words), so the row's dot follows the conversation's messages alone.
test("a message the user has not seen makes it unread, a notice included; viewing clears it; a wait that ends is no cause of its own", async () => {
  const s = setup("Jarvis");
  const { threadId } = s.service.state();
  s.env.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text: "Two things wait on you.", toolCalls: [] } });
  expect(s.service.state().unread).toBe(true);
  const seen = await s.app.request("/api/agents/global/seen", { method: "POST", body: JSON.stringify({ seq: s.service.state().lastVisibleSeq }), headers: { "content-type": "application/json" } });
  expect(((await seen.json()) as { agent: GlobalAgentDto }).agent.unread).toBe(false);
  // A wait ends. This service tells nobody (no notify), so no message is
  // written here: the row stays clear.
  const projectId = seedProject(s.env.projects, { name: "m", workingDir: "/tmp/m", tmuxSessionName: "m" });
  const featureId = seedFeature(s.env.features, projectId, { name: "release" });
  const sent = s.handoffs.sendToFeature({ globalThreadId: threadId, featureId, text: "x", spoken: false });
  const workerThread = s.env.agentStore.getThreadByScope("worker", featureId)!;
  await Bun.sleep(2);
  s.stops.set(workerThread.id, "stopped");
  s.handoffs.noteSettled(workerThread.id);
  expect(s.handoffs.dto(sent.id)!.state).toBe("replied");
  expect(s.service.state().unread).toBe(false);
  // The notice is a message: it lights the row by itself, whether or not the
  // agent then says anything (it may only follow up).
  s.env.agentStore.appendMessage({ threadId, role: "user", source: "thread-notice", content: { type: "text", text: "[Thread notice] Worker release (f): stopped." } });
  expect(s.service.state().unread).toBe(true);
  s.service.markSeen(s.service.state().lastVisibleSeq);
  expect(s.service.state().unread).toBe(false);
  // And so do the agent's words after it.
  s.env.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text: "release answered.", toolCalls: [] } });
  expect(s.service.state().unread).toBe(true);
  s.service.markSeen(s.service.state().lastVisibleSeq);
  expect(s.service.state().unread).toBe(false);
  // Seen never moves backwards.
  s.service.markSeen(0);
  expect(s.service.state().unread).toBe(false);
});

test("a service given no name for the agent stamps none on what it sends", () => {
  const s = setup();
  const { threadId } = s.service.state();
  const target = s.env.agentStore.createManagerThread("PR reviews");
  s.handoffs.sendToThread({ globalThreadId: threadId, threadId: target.id, text: "look at #15", spoken: false });
  const [message] = s.env.agentStore.getMessages(target.id);
  expect(message!.content.type === "text" && message!.content.relay).toEqual({ by: "global", spoken: false, handoffId: expect.any(String) });
});

test("the proposal route is gone: nothing answers it", async () => {
  const s = setup();
  const response = await s.app.request("/api/agents/global/proposals/hof_1", { method: "POST", body: JSON.stringify({ choice: "thread" }), headers: { "content-type": "application/json" } });
  expect(response.status).toBe(404);
});

test("the thread messages route accepts the global thread", async () => {
  const s = setup();
  const { threadId } = s.service.state();
  const queue = new AgentUserMessageQueue({ agentStore: s.env.agentStore, wakeScheduler: NOOP_WAKE });
  const agents = buildAgentsTestApp({ agentStore: s.env.agentStore, wakeScheduler: NOOP_WAKE, userMessageQueue: queue, scopes: {} as never });
  const res = await agents.request(`/api/agents/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ content: "what needs me?" }), headers: { "content-type": "application/json" } });
  expect(res.status).toBe(202);
  expect(s.env.agentStore.getMessages(threadId).map((m) => (m.content as { text: string }).text)).toEqual(["what needs me?"]);
});

test("the state is re-published after the global thread or a handoff changed, once per burst, never for another thread", async () => {
  const s = setup("Jarvis");
  const sse = new AgentSseEmitter();
  const stop = startGlobalAgentBroadcast({ sse, service: s.service, agentStore: s.env.agentStore });
  const { threadId } = s.service.state();
  const other = s.env.agentStore.createManagerThread("PR reviews");
  const elsewhere = s.env.agentStore.appendMessage({ threadId: other.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
  sse.emit("agentMessageAppended", { threadId: other.id, message: elsewhere });
  await Promise.resolve();
  expect(s.published).toStrictEqual([]);
  const answer = s.env.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text: "Two things wait on you.", toolCalls: [] } });
  sse.emit("agentMessageAppended", { threadId, message: answer });
  sse.emit("agentWakeStarted", { threadId, wakeId: "wk_1", reason: "user", startedAt: "2026-10-05T10:00:00.000Z", scope: "global", scopeId: null });
  await Promise.resolve();
  expect(s.published.map((a) => a.unread)).toStrictEqual([true]);
  const sent = s.handoffs.sendToThread({ globalThreadId: threadId, threadId: other.id, text: "x", spoken: false });
  sse.emit("globalHandoffUpdated", { handoff: sent });
  await Promise.resolve();
  expect(s.published).toHaveLength(2);
  stop();
  sse.emit("globalHandoffUpdated", { handoff: sent });
  await Promise.resolve();
  expect(s.published).toHaveLength(2);
});

test("the state is re-published when Codex is signed in or out (voice may turn on or off), until stopped", () => {
  const s = setup();
  const sse = new AgentSseEmitter();
  const stop = startGlobalAgentBroadcast({ sse, service: s.service, agentStore: s.env.agentStore });
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
  const a = s.handoffs.sendToThread({ globalThreadId: threadId, threadId: target.id, text: "look at #15", spoken: false });
  const armed = s.handoffs.awaitStop({ globalThreadId: threadId, threadId: target.id });
  if (!("handoff" in armed)) throw new Error("expected a wait");
  const b = armed.handoff;
  type Listed = { handoffs: Array<{ id: string; state: string }> };
  const read = async (query: string) => (await (await s.app.request(`/api/agents/global/handoffs${query}`)).json()) as Listed;
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
