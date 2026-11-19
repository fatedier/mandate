import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { Config } from "../src/server/config.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { ToolDispatcher, ToolRegistry } from "../src/server/modules/agent/tool-registry.js";
import { HandoffStore } from "../src/server/modules/personal/handoff-store.js";
import type { JudgementCandidate } from "../src/server/modules/manager-checks/judge.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { heldText, ToolReviewGate } from "../src/server/modules/tool-review/gate.js";
import type { VoiceProvider, VoiceProviderConfig, VoiceSession, VoiceSessionEvents } from "../src/server/modules/voice/voice-provider.js";
import { VoiceSessionOrchestrator } from "../src/server/modules/voice/voice-session-orchestrator.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { allMessages } from "./helpers/thread-messages.js";
import { onCleanup } from "./helpers/cleanup.js";

// What the personal agent does by voice is reviewed by the same rules as what it does
// in text. The realtime model can ask for a call before the transcript of the
// words it answers is stored, so a reviewed call waits for those words.

class FakeProvider implements VoiceProvider {
  events: VoiceSessionEvents | null = null;
  results: Array<{ callId: string; payload: unknown }> = [];
  async startSession(_config: VoiceProviderConfig, events: VoiceSessionEvents): Promise<VoiceSession> {
    this.events = events;
    return {
      sendAudio: () => {}, sendContextMessage: () => {}, requestResponse: () => {}, updateInstructions: () => {}, cancelResponse: () => {}, truncateItem: () => {},
      preloadHistory: () => {}, close: async () => {},
      sendToolResult: (callId, payload) => { this.results.push({ callId, payload }); }
    } as VoiceSession;
  }
}

let env: StoresEnv;
let root: string;
beforeEach(() => {
  env = freshStoresEnv("md-voice-review-");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "md-voice-review-root-")));
});
afterEach(() => {
  env.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

function config(): Config {
  return { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, toolReviewEnabled: true } };
}

function chat(texts: string[]) {
  const model = createMockLLM(texts.map((text) => ({ text, finishReason: "stop" as const })), { mode: "stream" });
  const recorder = new AgentLlmCallRecorder({ store: env.store, logRequests: "metadata", provider: "gw", model: "m", baseURL: "", apiMode: "streamText" });
  return { model, candidate: { kind: "chat", model, provider: "openai-compatible", supportsReasoning: false, recorder } as JudgementCandidate };
}

function voice(secondLook: JudgementCandidate, opts: { wordsWaitMs?: number } = {}) {
  const personal = env.agentStore.getOrCreatePersonalThread();
  const ran: string[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "bash", description: "bash", parameters: z.object({ command: z.string() }).passthrough(),
    handler: async (args) => { ran.push((args as { command: string }).command); return { ok: true }; }
  });
  const scope = { kind: "manager" as const, managerDir: path.join(root, "agent"), projectWorkingDirs: [] };
  const toolReview = new ToolReviewGate({
    config,
    available: () => true,
    agentStore: env.agentStore,
    workers: env.workers,
    projects: env.projects,
    handoffs: new HandoffStore(env.store.db),
    scopeOf: () => scope,
    models: () => ({ screen: [], secondLook: [secondLook], own: null }),
    paneFacts: async () => null,
    scratch: []
  });
  const provider = new FakeProvider();
  const orch = new VoiceSessionOrchestrator({
    agentStore: env.agentStore,
    threadId: personal.id,
    provider,
    providerConfig: { apiKey: "k", model: "m", voice: "v", language: "auto", systemPrompt: "p", tools: registry.definitions as never },
    dispatcher: { registry: { tools: registry.tools }, dispatch: (call, ctx) => new ToolDispatcher(registry).dispatch(call, ctx) } as never,
    buildToolScope: () => scope,
    sse: new AgentSseEmitter(),
    idleTimeoutMs: 60_000,
    maxSessionMs: 60_000,
    contextMessageCount: 10,
    reconnectDelaysMs: [0],
    ...(opts.wordsWaitMs !== undefined ? { spokenWordsWaitMs: opts.wordsWaitMs } : {}),
    toolReview
  });
  const answered = async (n: number) => {
    for (let i = 0; i < 300 && provider.results.length < n; i += 1) await Bun.sleep(10);
    return provider.results;
  };
  return { orch, provider, ran, answered, personal };
}

test("a spoken risky call is reviewed and a held one is not run", async () => {
  const second = chat(['{"hold": true, "reason": "Deletes the shared build."}']);
  const v = voice(second.candidate);
  await v.orch.start();
  v.provider.events!.onToolCall({ callId: "c1", name: "bash", args: { command: "rm -rf /srv/build" } });
  // A line the fast path proves read-only runs without a review.
  v.provider.events!.onToolCall({ callId: "c2", name: "bash", args: { command: "ls" } });
  const results = await v.answered(2);
  expect(results).toContainEqual({ callId: "c1", payload: { errorMessage: heldText("Deletes the shared build.") } });
  expect(results).toContainEqual({ callId: "c2", payload: { result: { ok: true } } });
  expect(v.ran).toEqual(["ls"]);
  expect(second.model.streamCalls).toHaveLength(1);
  const stored = allMessages(env.agentStore, v.personal.id).flatMap((m) => (m.content.type === "tool_result" && m.content.toolCallId === "c1" ? [m.content] : []));
  expect(stored).toEqual([expect.objectContaining({ isError: true, error: heldText("Deletes the shared build.") })]);
  await v.orch.close();
});

test("the review waits for the spoken words before judging", async () => {
  const second = chat(['{"hold": false, "reason": "The user asked for it."}']);
  const v = voice(second.candidate);
  await v.orch.start();
  // The user stopped speaking; the call comes before the transcript of what they said.
  v.provider.events!.onSpeechStopped();
  v.provider.events!.onToolCall({ callId: "c1", name: "bash", args: { command: "rm -rf /srv/build" } });
  await Bun.sleep(60);
  v.provider.events!.onTranscript({ speaker: "user", text: "Please clear out the old build folder now", isFinal: true });
  await v.answered(1);
  expect(v.ran).toEqual(["rm -rf /srv/build"]);
  expect(second.model.streamCalls).toHaveLength(1);
  expect(JSON.stringify(second.model.streamCalls[0]!.prompt)).toContain("Please clear out the old build folder now");
  await v.orch.close();
});

test("the review waits for the words of every speech that ended, not only the first", async () => {
  const second = chat(['{"hold": false, "reason": "Fine."}']);
  const v = voice(second.candidate);
  await v.orch.start();
  v.provider.events!.onSpeechStopped();
  v.provider.events!.onSpeechStopped();
  v.provider.events!.onToolCall({ callId: "c1", name: "bash", args: { command: "rm -rf /srv/build" } });
  await Bun.sleep(40);
  v.provider.events!.onTranscript({ speaker: "user", text: "Clear out the old build folder", isFinal: true });
  await Bun.sleep(40);
  v.provider.events!.onTranscript({ speaker: "user", text: "Wait, keep that folder after all", isFinal: true });
  await v.answered(1);
  expect(JSON.stringify(second.model.streamCalls[0]!.prompt)).toContain("Wait, keep that folder after all");
  await v.orch.close();
});

test("words stored in the same millisecond the review starts are read", async () => {
  setSystemTime(new Date("2026-11-01T10:00:00.123Z"));
  try {
    const second = chat(['{"hold": false, "reason": "Fine."}']);
    const v = voice(second.candidate);
    await v.orch.start();
    v.provider.events!.onSpeechStopped();
    v.provider.events!.onToolCall({ callId: "c1", name: "bash", args: { command: "rm -rf /srv/build" } });
    await Bun.sleep(40);
    v.provider.events!.onTranscript({ speaker: "user", text: "Clear out the old build folder now", isFinal: true });
    await v.answered(1);
    expect(JSON.stringify(second.model.streamCalls[0]!.prompt)).toContain("Clear out the old build folder now");
    await v.orch.close();
  } finally {
    setSystemTime();
  }
});

test("a speech that ends while a call waits is waited for too", async () => {
  const second = chat(['{"hold": false, "reason": "Fine."}']);
  const v = voice(second.candidate);
  await v.orch.start();
  v.provider.events!.onSpeechStopped();
  v.provider.events!.onToolCall({ callId: "c1", name: "bash", args: { command: "rm -rf /srv/build" } });
  await Bun.sleep(30);
  v.provider.events!.onSpeechStopped();
  v.provider.events!.onTranscript({ speaker: "user", text: "Clear out the old build folder", isFinal: true });
  await Bun.sleep(60);
  v.provider.events!.onTranscript({ speaker: "user", text: "Wait, keep that folder after all", isFinal: true });
  await v.answered(1);
  expect(JSON.stringify(second.model.streamCalls[0]!.prompt)).toContain("Wait, keep that folder after all");
  await v.orch.close();
});

test("a late transcript of a speech waited out is not taken for a later speech's", async () => {
  const second = chat(['{"hold": false, "reason": "Fine."}', '{"hold": false, "reason": "Fine."}']);
  const v = voice(second.candidate, { wordsWaitMs: 150 });
  await v.orch.start();
  v.provider.events!.onSpeechStopped();
  v.provider.events!.onToolCall({ callId: "c1", name: "bash", args: { command: "rm -rf /srv/build" } });
  await v.answered(1);
  v.provider.events!.onSpeechStopped();
  v.provider.events!.onToolCall({ callId: "c2", name: "bash", args: { command: "rm -rf /srv/cache" } });
  await Bun.sleep(30);
  v.provider.events!.onTranscript({ speaker: "user", text: "Clear out the old build folder", isFinal: true });
  await Bun.sleep(60);
  v.provider.events!.onTranscript({ speaker: "user", text: "And keep the cache folder as it is", isFinal: true });
  await v.answered(2);
  expect(JSON.stringify(second.model.streamCalls[1]!.prompt)).toContain("And keep the cache folder as it is");
  await v.orch.close();
});

test("a reopened session does not wait for the dropped session's words", async () => {
  const second = chat(['{"hold": false, "reason": "Fine."}']);
  const v = voice(second.candidate, { wordsWaitMs: 3000 });
  await v.orch.start();
  const first = v.provider.events!;
  first.onSpeechStopped();
  first.onClose();
  for (let i = 0; i < 100 && v.provider.events === first; i += 1) await Bun.sleep(10);
  const next = v.provider.events!;
  next.onSpeechStopped();
  next.onTranscript({ speaker: "user", text: "Clear out the old build folder", isFinal: true });
  const started = Date.now();
  next.onToolCall({ callId: "c1", name: "bash", args: { command: "rm -rf /srv/build" } });
  await v.answered(1);
  expect(Date.now() - started).toBeLessThan(1000);
  await v.orch.close();
});

test("a transcript is matched to its own speech: an earlier speech waited out does not hold a call", async () => {
  // The words' wait is read on the system time, held still at each moment:
  // a call held for words would wait for good.
  const at = Date.parse("2026-11-01T10:00:00.000Z");
  setSystemTime(at);
  onCleanup(() => setSystemTime());
  const second = chat(['{"hold": false, "reason": "Fine."}']);
  const v = voice(second.candidate, { wordsWaitMs: 600 });
  await v.orch.start();
  v.provider.events!.onSpeechStopped({ itemId: "item_a" });
  setSystemTime(at + 400);
  v.provider.events!.onSpeechStopped({ itemId: "item_b" });
  v.provider.events!.onTranscript({ speaker: "user", text: "Clear out the old build folder", isFinal: true }, { itemId: "item_b" });
  setSystemTime(at + 650);
  const started = performance.now();
  v.provider.events!.onToolCall({ callId: "c1", name: "bash", args: { command: "rm -rf /srv/build" } });
  await v.answered(1);
  expect(performance.now() - started).toBeLessThan(200);
  await v.orch.close();
});
