import { expect, test } from "bun:test";
import { WakeLock } from "../../src/server/modules/agent/wake-lock.js";
import { ToolRegistry, ToolDispatcher } from "../../src/server/modules/agent/tool-registry.js";
import { buildUiNavigateTool } from "../../src/server/modules/ui-context/tools/ui-navigate.js";
import { createTestWakeScheduler } from "../helpers/wake-scheduler.js";
import { createMockLLM } from "../helpers/mock-llm.js";
import { freshAgentEnv } from "../helpers/fixtures.js";

class CapturingSse {
  events: Array<{ name: string; data: any }> = [];
  emit(name: string, data: any) { this.events.push({ name, data }); }
}

const fresh = () => freshAgentEnv("md-uitool-");

test("end-to-end: agent calls ui_navigate → SSE agentUiAction emitted", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const sse = new CapturingSse();
    const reg = new ToolRegistry();
    reg.register(buildUiNavigateTool({
      projectsStore: { listActive: () => [] } as any,
      featuresStore: { listActiveByProject: () => [] } as any,
      emit: (action, payload) => sse.emit("agentUiAction", { action, payload })
    }));
    const dispatcher = new ToolDispatcher(reg);
    const llm = createMockLLM([
      {
        toolCalls: [{ toolCallId: "c1", toolName: "ui_navigate",
                       args: { path: "/activity" } }],
        finishReason: "tool-calls"
      },
      { text: "Navigated.", finishReason: "stop" }
    ]);
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(), maxStepsPerWake: 5,
      buildSystemPrompt: () => "stub", toolDispatcherForThread: () => dispatcher as any,
      llmModel: llm, sse: sse,
      buildToolScope: () => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } })
    });
    const thread = agentStore.getOrCreateThread("worker", "f1");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "open xyz" }
    });
    await wakeAndWait(thread.id, "user", trigger.id);

    const uiActions = sse.events.filter((e) => e.name === "agentUiAction");
    expect(uiActions.length).toBe(1);
    expect(uiActions[0].data.action).toBe("navigate");
    expect(uiActions[0].data.payload.path).toBe("/activity");
  } finally { cleanup(); }
});
