import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { waitUntil } from "./helpers/wait.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { configJson } from "./helpers/config-file.js";
import { llmCallDetails } from "./helpers/llm-calls.js";
import type { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { SKILL_NUDGE_NOTE } from "../src/server/modules/skills/skill-nudge.js";
import { mockFetch } from "./helpers/fetch.js";

const config = {
  models: {
    default: { model: "gw/chat-1" },
    providers: { gw: { type: "openai-compatible", baseURL: "https://gw.example.test/v1", apiKey: "sk-test", models: [{ id: "chat-1", input: ["text"] }] } }
  }
};

// A manager's turn of ten tool calls ends: one call follows on its own
// prompt, filed as the skill-review nudge in its thread (the test cannot
// reach the model, so the attempt fails), and nothing is written to the
// conversation.
test("the runtime follows a manager's finished piece of work with one call on its thread's prompt, writing nothing to the conversation", async () => {
  const env = freshStoresEnv("md-skill-nudge-runtime-");
  fs.writeFileSync(path.join(env.dir, "config.json"), configJson(config));
  const runtime = testAgentRuntime(env);
  try {
    const thread = env.agentStore.createManagerThread("Releases");
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Ship it" } });
    const turn = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    const calls = Array.from({ length: 10 }, (_, i) => ({ toolCallId: `c${i}`, toolName: "bash", args: { command: `step ${i}` } }));
    env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "", toolCalls: calls } });
    for (const call of calls) {
      env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "tool", wakeId: turn.id, content: { type: "tool_result", toolCallId: call.toolCallId, toolName: "bash", result: "ok" } } as never);
    }
    env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "Shipped.", toolCalls: [] } });
    env.agentStore.finishWake(turn.id, "finished");
    const before = env.agentStore.lastSeq(thread.id);
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    await deps.postWakeHook!(thread.id, { wakeId: turn.id, status: "finished" });
    const nudged = () => llmCallDetails(env.store, 20).filter((call) => call.purpose === "skill_review_nudge" && call.scopeId === thread.id);
    await waitUntil(() => nudged().length > 0 && nudged().every((c) => c.status !== "running"), { timeout: 5000, label: "a skill_review_nudge attempt" });
    expect(nudged()).toHaveLength(1);
    expect(env.agentStore.lastSeq(thread.id)).toBe(before);
  } finally {
    runtime.dispose();
    env.cleanup();
  }
});

const claudeConfig = {
  models: {
    default: { model: "claude/claude-sonnet-5-5" },
    providers: { claude: { type: "anthropic", baseURL: "https://claude.example.test/v1", apiKey: "sk-test", models: [{ id: "claude-sonnet-5-5", input: ["text"] }] } }
  }
};

/** A manager's turn of ten tool calls, finished: a piece of work the nudge follows. */
function finishedTurn(agentStore: AgentStore, title: string) {
  const thread = agentStore.createManagerThread(title);
  agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Ship it" } });
  const turn = agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  const calls = Array.from({ length: 10 }, (_, i) => ({ toolCallId: `c${i}`, toolName: "bash", args: { command: `step ${i}` } }));
  agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "", toolCalls: calls } });
  for (const call of calls) {
    agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "tool", wakeId: turn.id, content: { type: "tool_result", toolCallId: call.toolCallId, toolName: "bash", result: "ok" } } as never);
  }
  agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "Shipped.", toolCalls: [] } });
  agentStore.finishWake(turn.id, "finished");
  return { thread, turn };
}

// The nudge reads the thread's cache and writes its own tail for five
// minutes: it never keeps the thread's prompt for the hour, so the seal its
// last step left waiting still goes. (Its attempts fail here: the test
// cannot reach the model; each is recorded all the same.)
test("a nudge after a Claude thread's last step leaves its waiting seal: the seal still goes when due", async () => {
  const env = freshStoresEnv("md-skill-nudge-seal-");
  fs.writeFileSync(path.join(env.dir, "config.json"), configJson(claudeConfig));
  const runtime = testAgentRuntime(env);
  try {
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const callsOf = (threadId: string, purpose: string) => llmCallDetails(env.store, 50).filter((call) => call.purpose === purpose && call.scopeId === threadId);
    // The step that ended the turn wrote its messages for five minutes, as a
    // Claude step does, and answered nearly 270 s ago: its seal is due in
    // about a second.
    const stepEnded = async (threadId: string) => {
      const prompt = { ...(await runtime.wakeScheduler.stepPromptFor(threadId)), cacheTtlFor: () => "5m" as const };
      const startedAt = Date.now() - 269_000;
      deps.cacheSeal!.noteStepSucceeded(threadId, { prompt, served: prompt.candidates[0]!, startedAt, finishedAt: startedAt + 1000, cacheReadTokens: 0, cacheWriteTokens: 1000 });
    };
    // Without a nudge (a short turn): the seal goes, as for any quiet thread.
    const plain = env.agentStore.createManagerThread("Notes");
    env.agentStore.appendMessage({ threadId: plain.id, role: "user", source: "user", content: { type: "text", text: "Hi" } });
    env.agentStore.appendMessage({ threadId: plain.id, role: "assistant", source: "self", content: { type: "assistant", text: "Hello.", toolCalls: [] } });
    await stepEnded(plain.id);
    await waitUntil(() => callsOf(plain.id, "agent_cache_seal").length > 0, { timeout: 5000, label: "the plain thread's seal" });
    // After a finished piece of work: the nudge, then the seal all the same.
    const { thread, turn } = finishedTurn(env.agentStore, "Releases");
    await stepEnded(thread.id);
    await deps.postWakeHook!(thread.id, { wakeId: turn.id, status: "finished" });
    await waitUntil(() => callsOf(thread.id, "skill_review_nudge").length > 0, { timeout: 5000, label: "a skill_review_nudge attempt" });
    await waitUntil(() => callsOf(thread.id, "agent_cache_seal").length > 0, { timeout: 5000, label: "the seal after the nudge" });
  } finally {
    runtime.dispose();
    env.cleanup();
  }
}, 20_000);

/** Every cache mark in a request's messages (the system's are its own). */
function messageMarks(body: { messages?: unknown }): Array<{ type?: string; ttl?: string }> {
  const marks: Array<{ type?: string; ttl?: string }> = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "cache_control") marks.push(inner as { type?: string; ttl?: string });
      else walk(inner);
    }
  };
  walk(body.messages);
  return marks;
}

// The nudge goes the moment the turn ends, before anyone knows whether the
// thread goes quiet. It reads what the turn's last step wrote, marked as that
// step marked it (for five minutes while the model is sealed), and writes
// nothing from the turn's last reply on: that is where the seal writes the
// hour, and a request that reads a five-minute entry there would only restart
// its five minutes.
test("a nudge marks a Claude thread's messages as its step did: the end of the step's prompt for five minutes, nothing from the reply on", async () => {
  const env = freshStoresEnv("md-skill-nudge-marks-");
  fs.writeFileSync(path.join(env.dir, "config.json"), configJson(claudeConfig));
  const bodies: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
  mockFetch((call) => {
    bodies.push(JSON.parse(String(call.init?.body ?? "{}")) as { messages?: Array<{ role: string; content: unknown }> });
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "refused in the test" } }), { status: 400, headers: { "content-type": "application/json" } });
  });
  const runtime = testAgentRuntime(env);
  try {
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const { thread, turn } = finishedTurn(env.agentStore, "Releases");
    await deps.postWakeHook!(thread.id, { wakeId: turn.id, status: "finished" });
    const nudge = await waitUntil(() => bodies.find((body) => JSON.stringify(body.messages ?? null).includes("request_skill_review")), { timeout: 5000, label: "the nudge's request" });
    const messages = nudge.messages!;
    expect(JSON.stringify(messages.at(-1))).toContain(JSON.stringify(SKILL_NUDGE_NOTE).slice(1, -1));
    const reply = messages.findLastIndex((message) => message.role === "assistant");
    expect(JSON.stringify(messages[reply])).toContain("Shipped.");
    // The step's own prompt ended with the tool results before the reply.
    expect(messageMarks({ messages: messages.slice(reply - 1, reply) }).map((mark) => mark.ttl ?? "5m")).toEqual(["5m"]);
    expect(messageMarks({ messages: messages.slice(reply) })).toEqual([]);
    expect(messageMarks(nudge).every((mark) => (mark.ttl ?? "5m") === "5m")).toBe(true);
  } finally {
    runtime.dispose();
    env.cleanup();
  }
}, 20_000);
