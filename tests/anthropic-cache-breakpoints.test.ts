import { expect, test } from "bun:test";
import * as os from "node:os";
import type { ModelMessage } from "ai";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { withAnthropicCacheBreakpoints, withoutAnthropicCacheMarks } from "../src/server/modules/llm/anthropic-cache.js";
import { withCacheMarksFor } from "../src/server/modules/agent/replay-target.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";

// Anthropic caches a prompt only up to a block marked for it. A wake step
// marks the system instruction, the end of the previous step's prompt (the
// message before the latest assistant message) and its last message, each for
// an hour. Other models cache by prefix on their own and get no marks.

const HOUR = { type: "ephemeral", ttl: "1h" };
const FIVE = { type: "ephemeral", ttl: "5m" };
const marks = (messages: readonly ModelMessage[]) =>
  messages.map((m) => (m.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl ?? null);
const user = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const tool = (id: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: "ok" } }] });

test("the last message and the end of the previous step's prompt are marked for an hour; nothing else", () => {
  const messages = [user("Draft the notes"), assistant("Reading"), tool("c1"), assistant("More"), tool("c2"), user("[Thread notice] asked")];
  expect(marks(withAnthropicCacheBreakpoints(messages))).toEqual([null, null, HOUR, null, null, HOUR]);
  // The input is left as it was.
  expect(marks(messages)).toEqual([null, null, null, null, null, null]);
});

test("a first step, with no assistant message yet, marks only its last message", () => {
  expect(marks(withAnthropicCacheBreakpoints([user("hello")]))).toEqual([HOUR]);
  expect(marks(withAnthropicCacheBreakpoints([assistant("hi"), user("hello")]))).toEqual([null, HOUR]);
  expect(withAnthropicCacheBreakpoints([])).toEqual([]);
});

test("a mark keeps the message's other provider options", () => {
  const withOptions: ModelMessage = { ...user("Go on"), providerOptions: { anthropic: { other: 1 }, openai: { x: 2 } } };
  expect(withAnthropicCacheBreakpoints([withOptions])[0]!.providerOptions).toEqual({ anthropic: { other: 1, cacheControl: HOUR }, openai: { x: 2 } });
});

const SCOPE = (_t: string): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] });
const NO_TOOLS: ToolDispatcher = { registry: { tools: {} }, dispatch: async () => ({ result: "ok" }) };

// A step whose cache a seal will keep writes its own for five minutes, at
// the same places.
test("five-minute marks sit where the hour-long ones do", () => {
  expect(marks(withAnthropicCacheBreakpoints([user("a"), assistant("b"), tool("t1")], "5m"))).toEqual([FIVE, null, FIVE]);
});

// A seal re-marks a step's prompt its own way: every mark comes off first.
test("taking the marks off leaves the other provider options", () => {
  const both: ModelMessage = { ...user("a"), providerOptions: { anthropic: { cacheControl: HOUR, other: 1 }, openai: { x: 2 } } };
  const markOnly: ModelMessage = { ...assistant("b"), providerOptions: { anthropic: { cacheControl: HOUR } } };
  const [first, second] = withoutAnthropicCacheMarks([both, markOnly]);
  expect(first!.providerOptions).toEqual({ anthropic: { other: 1 }, openai: { x: 2 } });
  // Nothing left: no provider options at all, as a message never marked.
  expect("providerOptions" in second!).toBe(false);
});

test("a candidate's marks take the lifetime asked for; another family gets none", () => {
  const msgs = [user("a"), assistant("b"), tool("t1")];
  expect(marks(withCacheMarksFor({ meta: { provider: "anthropic" } } as never, msgs, "5m"))).toEqual([FIVE, null, FIVE]);
  expect(marks(withCacheMarksFor({ meta: { provider: "openai-compatible" } } as never, msgs, "5m"))).toEqual([null, null, null]);
});

test("a wake step marks Claude's prompt; a fallback of another family gets none on its messages", async () => {
  const store = new MandateStore(tempDir("md-anthropic-cache-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("project-1 3.22 release");
  agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Looked at the changelog." } });
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Go on" } });
  const claude = createMockLLM([{ error: "The operation timed out." }], { provider: "anthropic.messages", modelId: "anthropic/claude-opus-5-5" });
  const gpt = createMockLLM([{ text: "Here is the draft.", finishReason: "stop" }], { provider: "openai.responses", modelId: "openai/gpt-6.1-sol" });
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => NO_TOOLS,
    llmModel: claude,
    llmForThread: () => ({
      model: claude,
      candidates: [
        { model: claude, meta: { provider: "anthropic", providerName: "provider-1", model: "anthropic/claude-opus-5-5" } },
        { model: gpt, meta: { provider: "openai-compatible", providerName: "provider-1", model: "openai/gpt-6.1-sol" } }
      ]
    }),
    sse: { emit: () => {} },
    buildToolScope: SCOPE
  });
  await wakeAndWait(thread.id, "user", ask.id);
  const promptOf = (llm: ReturnType<typeof createMockLLM>) => llm.calls[0]!.options.prompt as Array<{ role: string; providerOptions?: { anthropic?: { cacheControl?: unknown } } }>;
  const claudePrompt = promptOf(claude);
  expect(claudePrompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  expect(claudePrompt.map((m) => m.providerOptions?.anthropic?.cacheControl ?? null)).toEqual([HOUR, HOUR, null, HOUR]);
  const gptPrompt = promptOf(gpt);
  expect(gptPrompt.slice(1).map((m) => m.providerOptions?.anthropic?.cacheControl ?? null)).toEqual([null, null, null]);
});
