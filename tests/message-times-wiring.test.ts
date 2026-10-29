import { afterEach, expect, test } from "bun:test";
import * as os from "node:os";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore, type AgentMessage } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";
import { buildLocalCompressionMessages } from "../src/server/runtime/agent-compression-controller.js";
import { formatAgentTime } from "../src/server/platform/time/agent-time.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { withMessageTimes } from "../src/server/modules/agent/system-prompt.js";

// The times a wake's prompt carries, and the line that tells each agent of
// them: wired through the scheduler, the compaction sent on its own, and the
// runtime's system prompts.

const SCOPE = (_t: string): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] });
const NO_TOOLS: ToolDispatcher = { registry: { tools: {} }, dispatch: async () => ({ result: "ok" }) };

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

/** The text of the first user message a wake sent, with the message it was
 *  built from. */
async function firstUserTextOfAWake(timeZone: string | undefined): Promise<{ text: string; message: AgentMessage }> {
  const store = new MandateStore(tempDir("md-message-times-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("Release notes");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  const llm = createMockLLM([{ text: "Drafted.", finishReason: "stop" }]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => NO_TOOLS,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: SCOPE,
    ...(timeZone ? { timeZone } : {})
  });
  await wakeAndWait(thread.id, "user", ask.id);
  const prompt = llm.calls[0]!.options.prompt as Array<{ role: string; content: unknown }>;
  const user = prompt.find((m) => m.role === "user");
  const parts = Array.isArray(user?.content) ? user.content as Array<{ type: string; text?: string }> : [];
  return { text: parts.find((p) => p.type === "text")?.text ?? "", message: ask };
}

test("a wake's prompt opens each incoming message with its time, in the zone the scheduler is given", async () => {
  const { text, message } = await firstUserTextOfAWake("Asia/Shanghai");
  expect(text).toBe(`[${formatAgentTime(message.createdAt, "Asia/Shanghai")}]\nDraft the notes`);
});

test("a compaction sent on its own reads the same times", () => {
  const message: AgentMessage = {
    id: "msg-1", threadId: "thread-1", seq: 1, role: "user", source: "user", sourceThreadId: null, wakeId: null,
    content: { type: "text", text: "Draft the notes" }, createdAt: "2026-10-23T13:45:00.000Z"
  };
  const sent = buildLocalCompressionMessages([message], { compactPrompt: "Summarize.", includeImages: false, timeZone: "Asia/Shanghai" });
  expect(sent[0]).toEqual({ role: "user", content: "[Fri 2026-10-23 21:45 +08:00]\nDraft the notes" });
});

test("every agent's system prompt ends by saying how its messages carry times, naming the zone", async () => {
  env = freshStoresEnv("md-message-times-prompt-");
  const runtime = testAgentRuntime(env, { timeZone: "Asia/Shanghai" });
  try {
    const deps = (runtime.wakeScheduler as unknown as { deps: { buildSystemPrompt: (threadId: string) => Promise<string>; timeZone?: string } }).deps;
    expect(deps.timeZone).toBe("Asia/Shanghai");
    const manager = env.agentStore.createManagerThread("Docs overhaul");
    const global = env.agentStore.getOrCreateGlobalThread();
    const line = "Each message you receive opens with the time it arrived, in brackets, in the user's local time (Asia/Shanghai); a tool result that finished long after the last such time ends with its own. The newest of these is the latest time you know: time keeps passing while you work, so run `date` when you need the exact time.";
    for (const threadId of [manager.id, global.id]) {
      const prompt = await deps.buildSystemPrompt(threadId);
      expect(prompt.endsWith(`\n\n${line}`)).toBe(true);
      expect(prompt.length).toBeGreaterThan(line.length + 2);
    }
  } finally {
    runtime.dispose();
  }
});

test("Your agent's digest writes its times in the runtime's zone", async () => {
  env = freshStoresEnv("md-message-times-digest-");
  const runtime = testAgentRuntime(env, { timeZone: "Asia/Kathmandu" });
  try {
    env.agentStore.createManagerThread("Docs overhaul");
    const digest = (await runtime.scopes.global.buildRuntimeContext!(env.agentStore.getOrCreateGlobalThread().id)) ?? "";
    expect(digest).toMatch(/- Docs overhaul · .* · last activity [A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \+05:45/);
  } finally {
    runtime.dispose();
  }
});

test("a prompt that is empty gets no line about times", () => {
  expect(withMessageTimes("", "UTC")).toBe("");
  expect(withMessageTimes("  \n", "UTC")).toBe("  \n");
  expect(withMessageTimes("You are a worker.\n", "UTC")).toStartWith("You are a worker.\n\nEach message you receive opens with the time it arrived");
});

/** Runs `fn` with the process in a zone other than the UTC tests run in, so
 *  a default that fell back to "UTC" instead of the machine's zone shows. */
async function inZone<T>(zone: string, fn: () => Promise<T>): Promise<T> {
  // The zone in effect, not TZ: bun test runs in UTC with TZ unset, and
  // unsetting it after would drop the files after this one to the machine's.
  const before = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = zone;
  try {
    return await fn();
  } finally {
    process.env.TZ = before;
  }
}

test("a scheduler given no zone stamps in the machine's own, not in UTC", async () => {
  const { text, message } = await inZone("America/Los_Angeles", () => firstUserTextOfAWake(undefined));
  expect(text).toBe(`[${formatAgentTime(message.createdAt, "America/Los_Angeles")}]\nDraft the notes`);
});

test("a runtime given no zone hands its agents the machine's own, not UTC", async () => {
  env = freshStoresEnv("md-message-times-default-");
  await inZone("America/Los_Angeles", async () => {
    const runtime = testAgentRuntime(env!, {});
    try {
      const deps = (runtime.wakeScheduler as unknown as { deps: { timeZone?: string } }).deps;
      expect(deps.timeZone).toBe("America/Los_Angeles");
    } finally {
      await runtime.dispose();
    }
  });
});
