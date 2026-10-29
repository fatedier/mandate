import { expect, test } from "bun:test";
import * as os from "node:os";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";
import { createAiSdkLanguageModel } from "../src/server/modules/llm/ai-sdk-model-factory.js";
import { sseFrame } from "./helpers/sse.js";

// kilo sends OpenAI's cyber_policy refusal inside an ordinary chat chunk
// (these chunks have the shape the gateway sends). The AI SDK parsed
// it as content and dropped the error, so the step read as an empty reply
// that ended the worker's turn in silence. Now it is a failed attempt: tried
// once more, and if the flag holds, the wake fails with the provider's words.

const created = 1791480000;
const chunk = (rest: object) => ({ id: "gen_01ABCDEFGHJKMNPQRSTVWXYZ12", object: "chat.completion.chunk", created, model: "openai/gpt-6.1-sol", system_fingerprint: "fp_0a1b2c3d4e", ...rest });
const FLAGGED = [
  chunk({ choices: [{ index: 0, delta: { role: "assistant" }, logprobs: null, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { reasoning: "**Thinking it through**\n\nI", reasoning_details: [{ type: "reasoning.summary", summary: "**Thinking it through**\n\nI", id: "rs_0123456789abcdef0123456789abcdef", format: "openai-responses-v1", index: 0 }] }, logprobs: null, finish_reason: null }] }),
  chunk({
    error: {
      code: "cyber_policy",
      message: "This request has been flagged for potentially high-risk cyber activity. Learn more here: https://platform.openai.com/docs/guides/safety-checks/cybersecurity",
      type: "invalid_request", statusCode: 400, isRetryable: false,
      data: { type: "error", sequence_number: 3, error: { type: "invalid_request", code: "cyber_policy", message: "This request has been flagged for potentially high-risk cyber activity. Learn more here: https://platform.openai.com/docs/guides/safety-checks/cybersecurity", param: null } }
    },
    choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }]
  })
];
const ANSWERED = [
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Here is the answer." }, logprobs: null, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }], usage: { prompt_tokens: 85_000, completion_tokens: 12, total_tokens: 85_012 } })
];
const sse = (chunks: object[]) => new Response(chunks.map((data) => sseFrame({ data })).join(""), { headers: { "content-type": "text/event-stream" } });

function onKilo(answer: (n: number) => object[]) {
  const store = new MandateStore(tempDir("md-kilo-in-band-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("project-1 issue 72");
  let sent = 0;
  const events: Array<{ event: string; data: unknown }> = [];
  const model = createAiSdkLanguageModel({
    provider: "kilo", model: "openai/gpt-6.1-sol", apiKey: "k", baseURL: "https://kilo.example/api/gateway",
    fetch: (async () => sse(answer(++sent))) as unknown as typeof fetch
  })!;
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: (): ToolDispatcher => ({ registry: { tools: {} }, dispatch: async () => ({ result: "ok" }) }),
    llmModel: model,
    llmForThread: () => ({ model, candidates: [{ model, meta: { provider: "kilo", model: "openai/gpt-6.1-sol", reasoningEffort: "xhigh", supportsReasoning: true } }] }),
    sse: { emit: (event: string, data: unknown) => { events.push({ event, data }); } },
    buildToolScope: (_t: string): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] })
  });
  const say = async (text: string) => {
    const m = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text } });
    return agentStore.getWakeById(await wakeAndWait(thread.id, "user", m.id))!;
  };
  const replies = () => agentStore.getMessages(thread.id).filter((m) => m.role === "assistant");
  // What the page's live bubble showed, in order.
  const bubble = () => events.filter((e) => e.event === "agentMessageDelta").map((e) => (e.data as { totalText: string }).totalText);
  return { say, replies, sent: () => sent, bubble };
}

test("a cyber_policy refusal kilo sends in band fails the attempt; when it holds, the wake fails with the provider's words and no empty reply", async () => {
  const k = onKilo(() => FLAGGED);
  const wake = await k.say("Say hello");
  expect(wake.status).toBe("error");
  expect(wake.errorMessage).toContain("This request has been flagged for potentially high-risk cyber activity");
  expect(wake.errorMessage).toContain("cyber_policy");
  // Tried once more before giving up, as a transient error is.
  expect(k.sent()).toBe(2);
  expect(k.replies()).toEqual([]);
});

test("a cyber_policy refusal that does not hold on the retry: the wake goes on with the answer", async () => {
  const k = onKilo((n) => (n === 1 ? FLAGGED : ANSWERED));
  const wake = await k.say("Say hello");
  expect(wake.status).toBe("finished");
  expect(k.sent()).toBe(2);
  expect(k.replies().map((m) => (m.content as { text?: string }).text)).toStrictEqual(["Here is the answer."]);
});

// Flagged after part of the reply streamed: a cyber_policy flag still gets
// its retry, the bubble starting over, where
// another failure after shown text only moves to the next model.
test("a cyber_policy flag after part of the reply streamed is retried with the bubble cleared, and the reply is the retry's alone", async () => {
  const partial = [FLAGGED[0]!, chunk({ choices: [{ index: 0, delta: { content: "Saying hello" }, logprobs: null, finish_reason: null }] }), FLAGGED[2]!];
  const k = onKilo((n) => (n === 1 ? partial : ANSWERED));
  const wake = await k.say("Say hello");
  expect(wake.status).toBe("finished");
  expect(k.sent()).toBe(2);
  expect(k.bubble()).toEqual(["Saying hello", "", "Here is the answer."]);
  expect(k.replies().map((m) => (m.content as { text?: string }).text)).toStrictEqual(["Here is the answer."]);
});
