import { expect, test } from "bun:test";
import * as os from "node:os";
import { tool, jsonSchema } from "ai";
import type { ToolDispatcher } from "../../src/server/modules/agent/wake-loop.js";
import { WakeLock } from "../../src/server/modules/agent/wake-lock.js";
import type { AgentScope } from "../../src/server/modules/agent/tool-scope.js";
import { SSE_EVENTS } from "../../src/shared/api-contracts.js";
import { createTestWakeScheduler } from "../helpers/wake-scheduler.js";
import { freshAgentEnv } from "../helpers/fixtures.js";
import { codexEvents, codexSse, codexTestModel } from "../helpers/codex.js";

const STUB_SCOPE = (): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] });

const noTools: ToolDispatcher = {
  registry: { tools: {} },
  async dispatch() { throw new Error("Unexpected tool call"); }
};

test("Codex wake continues commentary, executes a tool, and replays persisted phase and reasoning", async () => {
  const { agentStore, cleanup } = freshAgentEnv("md-codex-wake-");
  try {
    const thread = agentStore.getOrCreateThread("worker", "feature");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "check it" }
    });
    const requests: any[] = [];
    const model = codexTestModel({
      async fetch(_input, init) {
        requests.push(JSON.parse(String(init?.body)));
        switch (requests.length) {
          case 1: return codexSse(codexEvents({
            id: "1", text: "Checking", phase: "commentary", encryptedReasoning: "cipher-1", endTurn: false
          }));
          case 2: return codexSse(codexEvents({
            id: "2", toolCall: { name: "lookup", callId: "call_lookup", args: '{"query":"test"}' }, endTurn: false
          }));
          case 3: return codexSse(codexEvents({ id: "3", text: "Done", phase: "final_answer", endTurn: true }));
          default: throw new Error("Unexpected continuation");
        }
      }
    });
    let toolCalls = 0;
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(), maxStepsPerWake: 5, llmModel: model,
      buildSystemPrompt: () => "system instructions",
      buildToolScope: STUB_SCOPE,
      sse: { emit() {} },
      toolDispatcherForThread: () => ({
        registry: { tools: { lookup: tool({
          description: "Look up a value",
          inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] })
        }) } },
        async dispatch(call) {
          toolCalls++;
          expect(call.args).toEqual({ query: "test" });
          return { result: "tool-result" };
        }
      })
    });
    const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
    expect(agentStore.getWakeById(wakeId)).toMatchObject({ status: "finished", stepCount: 3 });
    expect(requests).toHaveLength(3);
    expect(toolCalls).toBe(1);
    const replay = requests[1].input;
    expect(replay.find((item: any) => item.role === "assistant")).toMatchObject({ phase: "commentary" });
    expect(replay.find((item: any) => item.type === "reasoning")).toEqual({
      type: "reasoning", encrypted_content: "cipher-1", summary: []
    });
    expect(requests[2].input.find((item: any) => item.type === "function_call_output"))
      .toMatchObject({ call_id: "call_lookup", output: "tool-result" });
    expect(requests[2].input.find((item: any) => item.type === "function_call"))
      .toMatchObject({ call_id: "call_lookup", arguments: '{"query":"test"}' });
    const stored = agentStore.getActiveMessages(thread.id).filter(message => message.role === "assistant");
    expect(stored).toHaveLength(3);
    expect(JSON.stringify(stored[0]!.content)).toContain('"phase":"commentary"');
    expect(JSON.stringify(stored[2]!.content)).toContain('"phase":"final_answer"');
  } finally { cleanup(); }
});

for (const mode of ["budget", "cancel", "truncated"] as const) {
  test(`Codex continuation respects ${mode}`, async () => {
    const { agentStore, cleanup } = freshAgentEnv("md-codex-boundary-");
    try {
      const thread = agentStore.getOrCreateThread("worker", "feature");
      const trigger = agentStore.appendMessage({
        threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hello" }
      });
      let requests = 0;
      const model = codexTestModel({
        async fetch() {
          requests++;
          const events = codexEvents({ text: "Working", endTurn: false });
          return codexSse(mode === "truncated" ? events.slice(0, -1) : events);
        }
      });
      const { scheduler, wakeAndWait } = createTestWakeScheduler({
        agentStore, lock: new WakeLock(), maxStepsPerWake: 2, llmModel: model,
        buildSystemPrompt: () => "system instructions", buildToolScope: STUB_SCOPE,
        toolDispatcherForThread: () => noTools,
        sse: { emit(event, data: any) {
          if (mode === "cancel" && event === SSE_EVENTS.agentMessageAppended && data.message.role === "assistant") {
            scheduler.cancelWake(data.message.wakeId);
          }
        } }
      });
      const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
      const wake = agentStore.getWakeById(wakeId)!;
      expect(wake.status).toBe(mode === "budget" ? "limit_reached" : mode === "cancel" ? "canceled" : "error");
      expect(requests).toBe(mode === "budget" ? 3 : 1);
      if (mode === "truncated") {
        expect(agentStore.getActiveMessages(thread.id).some(message => message.role === "assistant")).toBe(false);
      }
    } finally { cleanup(); }
  });
}
