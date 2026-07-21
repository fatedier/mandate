import { expect, test } from "bun:test";
import { z } from "zod";
import { WakeLock } from "../../src/server/modules/agent/wake-lock.js";
import { ToolRegistry, ToolDispatcher } from "../../src/server/modules/agent/tool-registry.js";
import { createTestWakeScheduler } from "../helpers/wake-scheduler.js";
import { createMockLLM } from "../helpers/mock-llm.js";
import { freshAgentEnv } from "../helpers/fixtures.js";

class CapturingSse {
  events: Array<{ name: string; data: any }> = [];
  emit(name: string, data: any) { this.events.push({ name, data }); }
}

const fresh = () => freshAgentEnv("md-mflow-");

test("end-to-end: user message → tool call → tool result → agent final, SSE events emitted in order", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const reg = new ToolRegistry();
    reg.register({
      name: "echo", description: "Echo",
      parameters: z.object({ text: z.string() }),
      approval: "never",
      handler: async ({ text }) => ({ echoed: text })
    });
    const dispatcher = new ToolDispatcher(reg);
    const sse = new CapturingSse();
    const llm = createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "echo", args: { text: "yo" } }],
        finishReason: "tool-calls" },
      { text: "Echoed.", finishReason: "stop" }
    ]);
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(), maxStepsPerWake: 5,
      buildSystemPrompt: () => "stub", toolDispatcherForThread: () => dispatcher as any,
      llmModel: llm, sse: sse,
      buildToolScope: () => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } })
    });

    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "say yo" }
    });
    const wakeId = await wakeAndWait(thread.id, "user", trigger.id);

    const names = sse.events.map((e) => e.name);
    expect(names[0]).toBe("agentWakeStarted");
    expect(names.filter((n) => n === "agentMessageAppended").length >= 3).toBeTruthy();
    expect(names.at(-1)).toBe("agentWakeFinished");

    const wake = agentStore.getWakeById(wakeId)!;
    expect(wake.status).toBe("finished");

    // Check that delta events carry the expected payload shape (when present).
    const deltas = sse.events.filter((e) => e.name === "agentMessageDelta");
    for (const d of deltas) {
      expect("threadId" in d.data).toBeTruthy();
      expect("wakeId" in d.data).toBeTruthy();
      expect("deltaText" in d.data).toBeTruthy();
      expect("totalText" in d.data).toBeTruthy();
    }
  } finally { cleanup(); }
});
