import { expect, test } from "bun:test";
import type { WSContext } from "hono/ws";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import { VoiceSessionGateway, type VoiceSessionClocks } from "../src/server/modules/voice/voice-gateway.js";
import { VoiceSessionOrchestrator } from "../src/server/modules/voice/voice-session-orchestrator.js";
import type { VoiceProvider, VoiceSession, VoiceSessionEvents, VoiceProviderConfig } from "../src/server/modules/voice/voice-provider.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { startSpokenUpdateSource } from "../src/server/modules/voice/spoken-updates.js";

/** Voice stays one session across the browser's own reconnects:
 *  its limits keep their clocks, and what came back
 *  while the page was away is still said. */

class FakeOrchestrator {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  closeReasons: string[] = [];
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return () => {};
  }
  emit(event: string, ...args: unknown[]) { for (const h of this.handlers.get(event) ?? []) h(...args); }
  async start() {}
  sendAudio() {}
  cancelResponse() {}
  async close(reason = "client-closed") { this.closeReasons.push(reason); this.emit("onClose", reason); }
}

const ws = () => stub<WSContext>({ send() {}, close() {} });

test("a reconnect of the same activation keeps its clocks; another is new", async () => {
  const asked: VoiceSessionClocks[] = [];
  const built: FakeOrchestrator[] = [];
  const gateway = new VoiceSessionGateway({
    buildOrchestrator: (clocks) => { asked.push(clocks); const o = new FakeOrchestrator(); built.push(o); return stub<VoiceSessionOrchestrator>(o); }
  });
  const first = gateway.createHandlers({ activationId: "act-1" });
  await first.onOpen({}, ws());
  built[0]!.emit("onUserSpeech", asked[0]!.startedAtMs + 1000);
  await first.onClose(); // the browser's socket dropped
  const again = gateway.createHandlers({ activationId: "act-1" });
  await again.onOpen({}, ws());
  expect(asked[1]!.startedAtMs).toBe(asked[0]!.startedAtMs);
  expect(asked[1]!.lastSpeechAtMs).toBe(asked[0]!.startedAtMs + 1000);
  const other = gateway.createHandlers({ activationId: "act-2" });
  await other.onOpen({}, ws());
  expect(asked[2]!.startedAtMs).toBeGreaterThanOrEqual(asked[0]!.startedAtMs);
});

test("one activation's sessions share what the user heard; another activation, or one a limit ended, has heard nothing", async () => {
  const asked: VoiceSessionClocks[] = [];
  const built: FakeOrchestrator[] = [];
  const gateway = new VoiceSessionGateway({
    buildOrchestrator: (clocks) => { asked.push(clocks); const o = new FakeOrchestrator(); built.push(o); return stub<VoiceSessionOrchestrator>(o); }
  });
  const first = gateway.createHandlers({ activationId: "act-1" });
  await first.onOpen({}, ws());
  built[0]!.emit("onUpdatesHeard", ["h1:replied"]);
  await first.onClose();
  await gateway.createHandlers({ activationId: "act-1" }).onOpen({}, ws());
  expect([...asked[1]!.heardUpdates]).toEqual(["h1:replied"]);
  built[1]!.emit("onUpdatesHeard", ["h2:failed"]);
  expect([...asked[1]!.heardUpdates]).toEqual(["h1:replied", "h2:failed"]);
  await gateway.createHandlers({ activationId: "act-2" }).onOpen({}, ws());
  expect([...asked[2]!.heardUpdates]).toEqual([]);
  built[2]!.emit("onUpdatesHeard", ["h3:replied"]);
  await built[2]!.close("idle-timeout");
  await gateway.createHandlers({ activationId: "act-2" }).onOpen({}, ws()); // the next start, under the same id
  expect([...asked[3]!.heardUpdates]).toEqual([]);
});

test("an activation stopped by its limit does not carry over: the next start is new", async () => {
  const asked: VoiceSessionClocks[] = [];
  const built: FakeOrchestrator[] = [];
  const gateway = new VoiceSessionGateway({
    buildOrchestrator: (clocks) => { asked.push(clocks); const o = new FakeOrchestrator(); built.push(o); return stub<VoiceSessionOrchestrator>(o); }
  });
  await gateway.createHandlers({ activationId: "act-1" }).onOpen({}, ws());
  await built[0]!.close("max-session-reached");
  await Bun.sleep(2);
  await gateway.createHandlers({ activationId: "act-1" }).onOpen({}, ws());
  expect(asked[1]!.startedAtMs).toBeGreaterThan(asked[0]!.startedAtMs);
});

class FakeProvider implements VoiceProvider {
  events: VoiceSessionEvents | null = null;
  async startSession(_config: VoiceProviderConfig, events: VoiceSessionEvents): Promise<VoiceSession> {
    this.events = events;
    return {
      sendAudio: () => {}, sendToolResult: () => {}, sendContextMessage: () => {}, requestResponse: () => {},
      cancelResponse: () => {}, truncateItem: () => {}, updateInstructions: () => {}, preloadHistory: () => {}, close: async () => {}
    };
  }
}

function orchestrator(env: ReturnType<typeof freshAgentEnv>, over: { idleTimeoutMs: number; maxSessionMs: number; startedAtMs?: number; lastSpeechAtMs?: number }) {
  const provider = new FakeProvider();
  const orch = new VoiceSessionOrchestrator({
    agentStore: env.agentStore, threadId: env.agentStore.getOrCreateGlobalThread().id, provider,
    providerConfig: { apiKey: "k", model: "m", voice: "v", language: "auto", systemPrompt: "p", tools: [] },
    dispatcher: { registry: { tools: {} }, dispatch: async () => ({ result: null }) },
    buildToolScope: () => ({ kind: "manager", managerDir: "", projectWorkingDirs: [] }),
    sse: new AgentSseEmitter(), contextMessageCount: 0, ...over
  });
  const closed: Array<{ reason: string; afterMs?: number }> = [];
  orch.on("onClose", (reason, afterMs) => closed.push({ reason, ...(afterMs !== undefined ? { afterMs } : {}) }));
  return { orch, provider, closed };
}

test("a continuing session's length limit counts from the activation's start", async () => {
  const env = freshAgentEnv();
  const s = orchestrator(env, { idleTimeoutMs: 0, maxSessionMs: 80, startedAtMs: Date.now() - 50 });
  await s.orch.start();
  await Bun.sleep(45);
  expect(s.closed).toStrictEqual([{ reason: "max-session-reached", afterMs: 80 }]);
});

test("a continuing session's idle counts from the user's last words, not from the reconnect", async () => {
  const env = freshAgentEnv();
  const s = orchestrator(env, { idleTimeoutMs: 80, maxSessionMs: 0, lastSpeechAtMs: Date.now() - 50 });
  await s.orch.start();
  await Bun.sleep(45);
  expect(s.closed).toStrictEqual([{ reason: "idle-timeout", afterMs: 80 }]);
});

test("the user's speech is reported, with when", async () => {
  const env = freshAgentEnv();
  const s = orchestrator(env, { idleTimeoutMs: 0, maxSessionMs: 0 });
  const heard: number[] = [];
  s.orch.on("onUserSpeech", (at) => heard.push(at));
  await s.orch.start();
  const before = Date.now();
  s.provider.events!.onSpeechStarted();
  expect(heard).toHaveLength(1);
  expect(heard[0]!).toBeGreaterThanOrEqual(before);
  await s.orch.close();
});

test("a session says what the agent said since voice was turned on and this activation has not heard, once each; live ones too", () => {
  const sse = new AgentSseEmitter();
  // What it said at the end of turns a notice or an alarm started, since the moment asked for.
  const since = [{ key: "said:w2", text: "heard already" }, { key: "said:w3", text: "The search timeout is fixed." }];
  const byWake: Record<string, Array<{ key: string; text: string }>> = { w2: [since[0]!], w3: [since[1]!], w4: [{ key: "said:w4", text: "Got it" }] };
  const asked: unknown[] = [];
  const start = startSpokenUpdateSource({
    sse,
    waiting: () => [],
    globalThreadId: () => "g1",
    saidAfter: (query) => { asked.push(query); return "wakeId" in query ? byWake[query.wakeId] ?? [] : since; }
  });
  const said: Array<[string, string | undefined]> = [];
  start((text, key) => said.push([text, key]), { since: "2026-10-05T10:02:00.000Z", heard: new Set(["said:w2"]) });
  expect(asked).toStrictEqual([{ since: "2026-10-05T10:02:00.000Z" }]);
  expect(said).toStrictEqual([["The search timeout is fixed.", "said:w3"]]);
  const ended = (wakeId: string) => sse.emit("agentWakeFinished", { threadId: "g1", wakeId, status: "finished" });
  ended("w3"); // its live event, late
  ended("w2"); // heard in an earlier session
  ended("w4");
  expect(said).toStrictEqual([["The search timeout is fixed.", "said:w3"], ["Got it", "said:w4"]]);
});

