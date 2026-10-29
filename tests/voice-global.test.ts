import { expect, test } from "bun:test";
import { z } from "zod";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { ToolRegistry, ToolDispatcher } from "../src/server/modules/agent/tool-registry.js";
import { VoiceSessionOrchestrator } from "../src/server/modules/voice/voice-session-orchestrator.js";
import type { VoiceProvider, VoiceSession, VoiceSessionEvents, VoiceProviderConfig } from "../src/server/modules/voice/voice-provider.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { buildVoiceInstructions, contextChangesFrom } from "../src/server/app/voice.js";
import { SSE_EVENTS, type SseEventPayloadMap } from "../src/shared/api-contracts.js";
import { VOICE_TOOL_WAKE_ID } from "../src/server/modules/global/handoff-service.js";

class FakeProvider implements VoiceProvider {
  events: VoiceSessionEvents | null = null;
  config: VoiceProviderConfig | null = null;
  results: Array<{ callId: string; payload: unknown }> = [];
  async startSession(config: VoiceProviderConfig, events: VoiceSessionEvents): Promise<VoiceSession> {
    this.config = config;
    this.events = events;
    return {
      sendAudio: () => {}, sendContextMessage: () => {}, requestResponse: () => {}, updateInstructions: () => {}, cancelResponse: () => {}, truncateItem: () => {},
      preloadHistory: () => {}, close: async () => {},
      sendToolResult: (callId, payload) => { this.results.push({ callId, payload }); }
    } as VoiceSession;
  }
}

type Seen = Array<{ name: string; wakeId: string; threadId: string }>;

function globalDispatcher(seen: Seen) {
  const registry = new ToolRegistry();
  for (const name of ["list_threads", "message_feature"]) {
    registry.register({
      name, description: name, parameters: z.object({}).passthrough(),
      handler: async (_args, ctx) => { seen.push({ name, wakeId: ctx.wakeId, threadId: ctx.threadId }); return { ok: name }; }
    });
  }
  return {
    registry: { tools: registry.tools },
    definitions: registry.definitions,
    dispatch: (call: any, ctx: any) => new ToolDispatcher(registry).dispatch(call, ctx)
  };
}

function orchestrator(env: ReturnType<typeof freshAgentEnv>, provider: FakeProvider, seen: Seen) {
  const global = env.agentStore.getOrCreateGlobalThread();
  const dispatcher = globalDispatcher(seen);
  const orch = new VoiceSessionOrchestrator({
    agentStore: env.agentStore,
    threadId: global.id,
    provider,
    providerConfig: { apiKey: "k", model: "m", voice: "v", language: "auto", systemPrompt: "p", tools: dispatcher.definitions as never },
    dispatcher,
    buildToolScope: () => ({ kind: "manager", managerDir: "", projectWorkingDirs: [] }),
    sse: new AgentSseEmitter(),
    idleTimeoutMs: 60_000,
    maxSessionMs: 60_000,
    contextMessageCount: 10
  });
  return { orch, global };
}

test("a session registers exactly the global agent's tools and dispatches them in its thread, marked as spoken", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const seen: Seen = [];
  const { orch, global } = orchestrator(env, provider, seen);
  await orch.start();
  expect(provider.config!.tools!.map((t) => t.name).sort()).toEqual(["list_threads", "message_feature"]);
  provider.events!.onToolCall({ callId: "c1", name: "message_feature", args: { featureId: "f" } });
  await Bun.sleep(5);
  expect(seen).toStrictEqual([{ name: "message_feature", wakeId: VOICE_TOOL_WAKE_ID, threadId: global.id }]);
  const rows = env.agentStore.getMessages(global.id);
  expect(rows.map((m) => [m.role, m.source])).toEqual([["assistant", "voice"], ["tool", "voice"]]);
  provider.events!.onToolCall({ callId: "c2", name: "bash", args: {} });
  await Bun.sleep(5);
  expect(provider.results.at(-1)).toEqual({ callId: "c2", payload: { errorMessage: "tool 'bash' is not available" } });
  await orch.close();
});

test("every outbound listener hears close: the factory's and the gateway's both run", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const { orch } = orchestrator(env, provider, []);
  await orch.start();
  const heard: string[] = [];
  orch.on("onClose", () => heard.push("factory"));
  const off = orch.on("onClose", () => heard.push("gateway"));
  orch.on("onClose", () => heard.push("third"));
  off();
  await orch.close("client-closed");
  expect(heard).toStrictEqual(["factory", "third"]);
});

test("the voice instructions are the global agent's, with its name and the spoken style", () => {
  const text = buildVoiceInstructions({ name: "Jarvis", language: "Chinese", skillsManifest: "- house-style", memorySection: "## Memory\n\nUSER BRIEF" });
  expect(text).toContain("Your name is Jarvis.\n\n## Memory\n\nUSER BRIEF");
  expect(text).toContain("You do no sustained work yourself.");
  // A spoken session reads the same file: what it is for is one text.
  expect(text).toContain("You do not change the projects' code.");
  expect(text).toContain("A matter is something the user handed you to see through");
  expect(text).toContain("short sentences");
  expect(text).toContain("- house-style");
  expect(text).not.toContain("dispatch_to_manager");
});

test("what the global context shows changing reaches a voice session; chatter does not", () => {
  const sse = new AgentSseEmitter();
  let heard = 0;
  const stop = contextChangesFrom(sse)(() => { heard += 1; });
  const emit = (event: keyof typeof SSE_EVENTS) => sse.emit(SSE_EVENTS[event], {} as SseEventPayloadMap[typeof SSE_EVENTS[typeof event]]);
  for (const event of [
    "featureCreated", "featureArchived", "featureRestored", "featureOwnerChanged", "workItemCreated",
    "featurePlanUpdated", "managerThreadUpdated", "globalHandoffUpdated", "globalAgentUpdated",
    "projectCreated", "projectArchived", "projectAdopted"
  ] as const) emit(event);
  expect(heard).toBe(12);
  for (const event of ["agentReasoningHeading", "canvasUpdated", "agentWakeStarted", "paneCreated"] as const) emit(event);
  expect(heard).toBe(12);
  stop();
  emit("featureCreated");
  expect(heard).toBe(12);
});

