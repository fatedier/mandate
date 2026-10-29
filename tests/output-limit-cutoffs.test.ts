import { expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import {
  OUTPUT_LIMIT_CALL_NOT_RUN,
  OUTPUT_LIMIT_CALL_DROPPED,
  OUTPUT_LIMIT_REASONING_ONLY,
  OUTPUT_LIMIT_STOPPED,
  OUTPUT_LIMIT_TEXT_CUT
} from "../src/server/modules/agent/output-limit.js";
import { isModelOnlySource, type AiSdkAssistantMessage } from "../src/shared/agent-message-types.js";
import { withoutTrailingReasoning } from "../src/server/modules/agent/reasoning-replay.js";
import { formatAgentTime, localTimeZone } from "../src/server/platform/time/agent-time.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createScriptedStreamLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";

// A reply the model wrote up to its output token limit (finish reason
// "length"): a cut tool call is not run and says why, a cut reply is
// continued after a note only the model reads, and a third cut in a row
// ends the turn with a stop line.

type Part = LanguageModelV3StreamPart;

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined }
};
const finish = (reason: "stop" | "length" | "tool-calls"): Part => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
const text = (body: string, id = "t"): Part[] => [
  { type: "text-start", id }, { type: "text-delta", id, delta: body }, { type: "text-end", id }
];
const reasoning = (body: string, id = "r"): Part[] => [
  { type: "reasoning-start", id }, { type: "reasoning-delta", id, delta: body }, { type: "reasoning-end", id }
];
const call = (id: string, toolName: string, input: string): Part[] => [
  { type: "tool-input-start", id, toolName },
  { type: "tool-input-delta", id, delta: input },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName, input }
];
// A call the provider never finished (the Responses API's, at the limit):
// its input started, no tool-call part.
const startedCall = (id: string, toolName: string, partial: string): Part[] => [
  { type: "tool-input-start", id, toolName },
  { type: "tool-input-delta", id, delta: partial }
];
const step = (...parts: Array<Part | Part[]>): Part[] => [{ type: "stream-start", warnings: [] }, ...parts.flat()];

function fresh() {
  const store = new MandateStore(tempDir("md-cutoff-"));
  onCleanup(() => store.db.close());
  return { agentStore: new AgentStore(store.db) };
}

const STUB_SCOPE = (_t: string): AgentScope => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
// Validated by the SDK, as Mandate's own tools are (a zod schema).
const writeTool = tool({ inputSchema: z.object({ path: z.string(), content: z.string() }) });

function run(steps: Part[][]) {
  const { agentStore } = fresh();
  const dispatched: Array<{ toolName: string; args: unknown }> = [];
  const dispatcher: ToolDispatcher = {
    registry: { tools: { write: writeTool } },
    dispatch: async (spec) => {
      dispatched.push({ toolName: spec.toolName, args: spec.args });
      return { result: "ok" };
    }
  };
  const llm = createScriptedStreamLLM(steps);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => dispatcher,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE
  });
  const thread = agentStore.getOrCreateThread("worker", "feat-cut");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  return {
    agentStore, llm, dispatched,
    wake: () => wakeAndWait(thread.id, "user", ask.id),
    rows: () => agentStore.getMessages(thread.id).filter((m) => m.role !== "system" || m.source === "wake-failure")
  };
}

/** The user-role text the model was sent last, in a recorded call's prompt. */
function lastUserText(prompt: unknown): string {
  const messages = prompt as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  const user = messages.filter((m) => m.role === "user").at(-1);
  return (user?.content ?? []).map((part) => part.text ?? "").join("");
}

const notes = (rows: ReturnType<ReturnType<typeof run>["rows"]>) =>
  rows.filter((m) => m.source === "output-limit").map((m) => (m.content as { text: string }).text);

test("a reply cut off at the limit is continued after a note only the model reads", async () => {
  const t = run([
    step(text("The plan has three par"), finish("length")),
    step(text("The plan has three parts."), finish("stop"))
  ]);
  const wakeId = await t.wake();
  expect(t.agentStore.getWakeById(wakeId)?.status).toBe("finished");
  const rows = t.rows();
  expect(rows.map((m) => [m.role, m.source])).toEqual([
    ["user", "user"], ["assistant", "self"], ["user", "output-limit"], ["assistant", "self"]
  ]);
  expect(notes(rows)).toEqual([OUTPUT_LIMIT_TEXT_CUT]);
  // The cut reply does not end the turn (the page keeps it running, Stop
  // included); the one that finishes it does.
  expect((rows[1]!.content as { endTurn?: boolean }).endTurn).toBe(false);
  expect((rows[3]!.content as { endTurn?: boolean }).endTurn).toBeUndefined();
  expect(isModelOnlySource("output-limit")).toBe(true);
  // The model reads it as it reads every message it is given: after its time.
  expect(lastUserText(t.llm.streamCalls[1]!.prompt)).toBe(`[${formatAgentTime(rows[2]!.createdAt, localTimeZone())}]\n${OUTPUT_LIMIT_TEXT_CUT}`);
});

test("a reply cut off while still reasoning keeps nothing and says so", async () => {
  const t = run([
    step(reasoning("Let me think about every case"), finish("length")),
    step(text("Done."), finish("stop"))
  ]);
  await t.wake();
  const rows = t.rows();
  expect(rows.map((m) => [m.role, m.source])).toEqual([["user", "user"], ["user", "output-limit"], ["assistant", "self"]]);
  expect(notes(rows)).toEqual([OUTPUT_LIMIT_REASONING_ONLY]);
});

test("a tool call cut off mid-arguments is not run, and its result says why; a whole call before it runs", async () => {
  const t = run([
    step(
      call("c1", "write", JSON.stringify({ path: "a.txt", content: "one" })),
      call("c2", "write", '{"path":"b.txt","content":"two thousand lines'),
      finish("length")
    ),
    step(text("Written in two calls."), finish("stop"))
  ]);
  await t.wake();
  expect(t.dispatched).toStrictEqual([{ toolName: "write", args: { path: "a.txt", content: "one" } }]);
  const rows = t.rows();
  const results = rows.filter((m) => m.content.type === "tool_result").map((m) => m.content);
  expect(results).toMatchObject([
    { toolCallId: "c1", result: "ok" },
    { toolCallId: "c2", isError: true, error: OUTPUT_LIMIT_CALL_NOT_RUN }
  ]);
  // The cut call is stored without its broken arguments; no note: its
  // result tells the model.
  const assistant = rows.find((m) => m.role === "assistant")!.content as { toolCalls: Array<{ toolCallId: string; args: unknown }> };
  expect(assistant.toolCalls.find((c) => c.toolCallId === "c2")?.args).toEqual({});
  expect(notes(rows)).toEqual([]);
});

test("a complete call whose arguments break its schema is not taken for a cut one", async () => {
  const t = run([
    step(
      call("c1", "write", JSON.stringify({ path: 123, content: "ok" })),
      call("c2", "write", '{"path":"b.txt","content":"tw'),
      finish("length")
    ),
    step(text("Done."), finish("stop"))
  ]);
  await t.wake();
  // The first goes to its tool, which answers its own validation error.
  expect(t.dispatched).toStrictEqual([{ toolName: "write", args: { path: 123, content: "ok" } }]);
  const results = t.rows().filter((m) => m.content.type === "tool_result").map((m) => m.content);
  expect(results).toMatchObject([{ toolCallId: "c1", result: "ok" }, { toolCallId: "c2", error: OUTPUT_LIMIT_CALL_NOT_RUN }]);
});

test("nor is a complete call whose arguments came as a JSON string (encoded twice)", async () => {
  const encodedTwice = JSON.stringify(JSON.stringify({ path: "a.txt", content: "one" }));
  const t = run([
    step(call("c1", "write", encodedTwice), call("c2", "write", '{"path":"b.txt","content":"tw'), finish("length")),
    step(text("Done."), finish("stop"))
  ]);
  await t.wake();
  expect(t.dispatched).toStrictEqual([{ toolName: "write", args: JSON.parse(encodedTwice) }]);
});

test("a cut reply kept for replay drops the reasoning it ended on, keeping what came before its text", async () => {
  const t = run([
    step(reasoning("Plan it", "r1"), text("Writing the file now."), reasoning("Now the content", "r2"), startedCall("c1", "write", '{"path":"a'), finish("length")),
    step(text("Done."), finish("stop"))
  ]);
  await t.wake();
  const assistant = t.rows().find((m) => m.role === "assistant")!.content as { sdkAssistantMessages?: Array<{ content: Array<{ type: string }> }> };
  expect(assistant.sdkAssistantMessages?.map((m) => m.content.map((part) => part.type))).toEqual([["reasoning", "text"]]);
});

test("a tool call the provider dropped at the limit gets a note after the text", async () => {
  const t = run([
    step(text("Writing the file now."), startedCall("c1", "write", '{"path":"a.txt","content":"lo'), finish("length")),
    step(text("Done."), finish("stop"))
  ]);
  await t.wake();
  const rows = t.rows();
  expect(rows.map((m) => [m.role, m.source])).toEqual([
    ["user", "user"], ["assistant", "self"], ["user", "output-limit"], ["assistant", "self"]
  ]);
  expect((rows[1]!.content as { text?: string; toolCalls?: unknown }).toolCalls).toBeUndefined();
  expect(notes(rows)).toEqual([OUTPUT_LIMIT_CALL_DROPPED]);
  expect(t.dispatched).toStrictEqual([]);
});

test("a whole call runs and a dropped one after it still gets the note, after the results", async () => {
  const t = run([
    step(
      call("c1", "write", JSON.stringify({ path: "a.txt", content: "one" })),
      startedCall("c2", "write", '{"path":"b.txt","content":"tw'),
      finish("length")
    ),
    step(text("Done."), finish("stop"))
  ]);
  await t.wake();
  expect(t.dispatched).toStrictEqual([{ toolName: "write", args: { path: "a.txt", content: "one" } }]);
  const rows = t.rows();
  expect(rows.map((m) => [m.role, m.source])).toEqual([
    ["user", "user"], ["assistant", "self"], ["tool", "self"], ["user", "output-limit"], ["assistant", "self"]
  ]);
  expect(notes(rows)).toEqual([OUTPUT_LIMIT_CALL_DROPPED]);
});

test("the third cut in a row ends the turn with a stop line, after two notes", async () => {
  const cut = () => step(text("Still going"), finish("length"));
  const t = run([cut(), cut(), cut()]);
  const wakeId = await t.wake();
  expect(t.llm.callsMade).toBe(3);
  expect(t.agentStore.getWakeById(wakeId)?.status).toBe("finished");
  const rows = t.rows();
  expect(notes(rows)).toEqual([OUTPUT_LIMIT_TEXT_CUT, OUTPUT_LIMIT_TEXT_CUT]);
  // Only the last cut reply ends the turn.
  expect(rows.filter((m) => m.role === "assistant").map((m) => (m.content as { endTurn?: boolean }).endTurn)).toStrictEqual([false, false, undefined]);
  expect(rows.at(-1)).toMatchObject({
    role: "system", source: "wake-failure", wakeId,
    content: { type: "wake_failure", status: "cut_off", message: OUTPUT_LIMIT_STOPPED, stepCount: 3 }
  });
  expect(OUTPUT_LIMIT_STOPPED).toBe("Cut off at the output token limit.");
});

test("the third cut still answers its cut call before the turn stops", async () => {
  const cutCall = (id: string) => step(call(id, "write", '{"path":"a.txt","content":"x'), finish("length"));
  const t = run([cutCall("c1"), cutCall("c2"), cutCall("c3")]);
  await t.wake();
  const rows = t.rows();
  expect(rows.filter((m) => m.content.type === "tool_result").map((m) => (m.content as { error?: string }).error))
    .toStrictEqual([OUTPUT_LIMIT_CALL_NOT_RUN, OUTPUT_LIMIT_CALL_NOT_RUN, OUTPUT_LIMIT_CALL_NOT_RUN]);
  expect(rows.at(-1)?.content).toMatchObject({ type: "wake_failure", status: "cut_off" });
  expect(t.dispatched).toStrictEqual([]);
});

test("cuts count only in a row: a whole step between them starts the count again", async () => {
  const cut = () => step(text("Part"), finish("length"));
  const t = run([
    cut(),
    step(call("c1", "write", JSON.stringify({ path: "a.txt", content: "one" })), finish("tool-calls")),
    cut(),
    cut(),
    step(text("Finished."), finish("stop"))
  ]);
  const wakeId = await t.wake();
  const rows = t.rows();
  expect(notes(rows)).toHaveLength(3);
  expect(rows.some((m) => m.content.type === "wake_failure")).toBe(false);
  expect(t.agentStore.getWakeById(wakeId)?.status).toBe("finished");
});

test("trailing reasoning goes from the end of the kept messages, and a message left empty goes with it", () => {
  const reasoningPart = { type: "reasoning" as const, text: "" };
  const messages: AiSdkAssistantMessage[] = [
    { role: "assistant", content: [reasoningPart, { type: "text", text: "Writing it." }] },
    { role: "assistant", content: [reasoningPart, reasoningPart] }
  ];
  expect(withoutTrailingReasoning(messages)).toEqual([messages[0]!]);
  expect(withoutTrailingReasoning([{ role: "assistant", content: "plain text" }])).toEqual([{ role: "assistant", content: "plain text" }]);
  expect(withoutTrailingReasoning([])).toEqual([]);
});
