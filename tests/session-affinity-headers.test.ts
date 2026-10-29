import { expect, test } from "bun:test";
import * as os from "node:os";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";

// A proxy (a custom provider) that spreads requests over several upstreams
// keeps a conversation on one only when it knows which requests belong
// together: each wake step to a custom provider says so in x-session-id and
// x-session-affinity, the thread's id. The others (OpenAI, Anthropic, ...)
// get no such headers.

const SCOPE = (_t: string): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] });
const NO_TOOLS: ToolDispatcher = { registry: { tools: {} }, dispatch: async () => ({ result: "ok" }) };

test("a wake step to a custom provider names its thread in two headers; one to another provider does not", async () => {
  const store = new MandateStore(tempDir("md-affinity-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("project-1 3.22 release");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  // Claude on a custom provider's Messages protocol runs as the Anthropic family.
  const proxied = createMockLLM([{ error: "The operation timed out." }], { provider: "anthropic.messages", modelId: "anthropic/claude-opus-5-5" });
  const direct = createMockLLM([{ text: "Here is the draft.", finishReason: "stop" }], { provider: "openai.responses", modelId: "gpt-6.1-sol" });
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => NO_TOOLS,
    llmModel: proxied,
    llmForThread: () => ({
      model: proxied,
      candidates: [
        { model: proxied, meta: { provider: "anthropic", providerType: "openai-compatible", providerName: "provider-1", model: "anthropic/claude-opus-5-5" } },
        { model: direct, meta: { provider: "openai", providerType: "openai", providerName: "openai", model: "gpt-6.1-sol" } }
      ]
    }),
    sse: { emit: () => {} },
    buildToolScope: SCOPE
  });
  await wakeAndWait(thread.id, "user", ask.id);
  const headersOf = (llm: ReturnType<typeof createMockLLM>) => (llm.calls[0]!.options.headers ?? {}) as Record<string, string | undefined>;
  expect(headersOf(proxied)["x-session-id"]).toBe(thread.id);
  expect(headersOf(proxied)["x-session-affinity"]).toBe(thread.id);
  expect([headersOf(direct)["x-session-id"], headersOf(direct)["x-session-affinity"]]).toEqual([undefined, undefined]);
});
