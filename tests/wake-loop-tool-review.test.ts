import { expect, test } from "bun:test";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import type { ToolCallReview, ToolCallSpec, ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { tempDir } from "./helpers/temp.js";
import { onCleanup } from "./helpers/cleanup.js";
import { testStore } from "./helpers/test-store.js";

// The wake loop asks the review before it runs a step's calls. A held call is
// not run: its result tells the agent why, and it is no failure, so the
// repeat stop does not count it. The step's other calls run as before.

const HELD = "Held back by the tool-call review; this is not a failure. Deletes x.";

function setup(steps: Array<ToolCallSpec[] | string>, held: (call: ToolCallSpec) => boolean) {
  const store = testStore(tempDir("md-wl-review-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const ran: string[] = [];
  const dispatcher: ToolDispatcher = {
    registry: { tools: {} },
    async dispatch(call) {
      ran.push(call.toolCallId);
      return { result: { ok: true } };
    }
  };
  const asked: string[][] = [];
  const toolReview: ToolCallReview = {
    async reviewStep(_threadId, _wakeId, calls) {
      asked.push(calls.map((c) => c.toolCallId));
      return new Map(calls.filter(held).map((c) => [c.toolCallId, HELD]));
    }
  };
  const llm = createMockLLM(steps.map((step) => (typeof step === "string"
    ? { text: step, finishReason: "stop" as const }
    : { toolCalls: step.map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName, args: c.args })), finishReason: "tool-calls" as const })));
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, buildSystemPrompt: () => "stub", toolDispatcherForThread: () => dispatcher,
    llmModel: llm, toolReview
  });
  const thread = agentStore.getOrCreateThread("worker", "wkr-A");
  const trigger = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const results = () => agentStore.getMessagesSince(thread.id, 0)
    .flatMap((m) => (m.content.type === "tool_result" ? [{ id: m.content.toolCallId, isError: Boolean(m.content.isError), error: m.content.error }] : []));
  return { run: () => wakeAndWait(thread.id, "user", trigger.id), ran, asked, results, agentStore };
}

const bash = (command: string, id: string): ToolCallSpec => ({ toolCallId: id, toolName: "bash", args: { command } });

test("a held call is not run and its result is the reason", async () => {
  const t = setup([[bash("rm -rf x", "c1")], "Stopped."], () => true);
  await t.run();
  expect(t.ran).toStrictEqual([]);
  expect(t.results()).toStrictEqual([{ id: "c1", isError: true, error: HELD }]);
});

test("in a step with one held call the others run in order", async () => {
  const t = setup([[bash("ls", "c1"), bash("rm -rf x", "c2"), bash("pwd", "c3")], "Done."], (c) => c.toolCallId === "c2");
  await t.run();
  expect(t.asked).toStrictEqual([["c1", "c2", "c3"]]);
  expect(t.ran).toStrictEqual(["c1", "c3"]);
  expect(t.results().map((r) => [r.id, r.isError])).toStrictEqual([["c1", false], ["c2", true], ["c3", false]]);
});

test("a held call is not counted by the repeat stop", async () => {
  // Six steps holding the same call: the repeat stop would end the wake at the fifth failure.
  const steps: Array<ToolCallSpec[] | string> = [...Array.from({ length: 6 }, (_, i) => [bash("rm -rf x", `c${i}`)]), "Gave up on it."];
  const t = setup(steps, () => true);
  const wakeId = await t.run();
  const results = t.results();
  expect(results).toHaveLength(6);
  for (const result of results) expect(result.error).toBe(HELD);
  expect(t.agentStore.getWakeById(wakeId)?.status).toBe("finished");
});
