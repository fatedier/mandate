import { expect, test } from "bun:test";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { freshAgentEnv } from "./helpers/fixtures.js";

// A Google model that hits its per-request output cap is continued in further
// requests, and the SDK sums their usage. The call keeps the sum (what is
// billed) and, beside it, the first prompt: the size of the context, which
// the context meter and the compaction gate read.

const SCOPE = (): AgentScope => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
const NO_TOOLS: ToolDispatcher = { registry: { tools: {} }, async dispatch() { return { result: {} }; } };

test("a continued Google step records the sum it was billed and the context it read", async () => {
  const env = freshAgentEnv("md-google-continued-");
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-google");
    const trigger = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "write it all" } });
    const model = {
      specificationVersion: "v4" as const, provider: "google.generative-ai", modelId: "gemini-4-argon", supportedUrls: {},
      doGenerate: async () => { throw new Error("streams only"); },
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "done" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish", finishReason: { unified: "stop", raw: "STOP" },
              usage: { inputTokens: { total: 272_768, noCache: 272_768, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 9, text: 9, reasoning: 0 } },
              providerMetadata: { google: { initialPromptTokenCount: 120_000 } }
            });
            controller.close();
          }
        })
      })
    };
    const recorder = new AgentLlmCallRecorder({ store: env.store, logRequests: "metadata", provider: "google", model: "gemini-4-argon", baseURL: "", apiMode: "streamText" });
    await createTestWakeScheduler({
      agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system", toolDispatcherForThread: () => NO_TOOLS,
      llmModel: model as never, llmCallRecorder: recorder, sse: { emit: () => {} }, buildToolScope: SCOPE
    } as never).wakeAndWait(thread.id, "user", trigger.id);
    const row = env.store.db.prepare("select input_tokens, metadata_json from llm_calls where purpose = 'agent_wake_step'").get() as { input_tokens: number; metadata_json: string };
    expect(row.input_tokens).toBe(272_768);
    expect(JSON.parse(row.metadata_json).contextInputTokens).toBe(120_000);
    // The context meter shows what the model read.
    expect(env.store.db.prepare("select last_input_tokens from agent_wakes where thread_id = ?").get(thread.id)).toEqual({ last_input_tokens: 120_000 });
  } finally { env.cleanup(); }
});
