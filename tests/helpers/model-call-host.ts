import { expect } from "bun:test";
import type { ModelMessage } from "ai";
import { createAgentProvider, type AgentProviderSnapshot } from "../../src/server/modules/agent/llm-provider.js";
import { ModelCallHost, type HostStreamRequest } from "../../src/server/modules/agent/model-call-host.js";
import type { ModelStreamHooks } from "../../src/server/modules/agent/model-stream.js";
import type { OfferedToolSpec } from "../../src/server/modules/agent/tool-registry.js";
import type { WakeLlmCandidate } from "../../src/server/modules/agent/wake-llm-attempts.js";

// The model-call host's tests, in several files so they run side by side:
// a stub provider on this machine, a host over it, and what a stream asks
// and hears. Each test builds its own host and stub; a file disposes them
// after each test with `afterEach(disposeHosts)`.

/** Stand-ins for the worker: tests/helpers/fake-model-worker.ts and
 *  tests/helpers/model-worker-probe.ts. */
export const FAKE_WORKER = new URL("./fake-model-worker.ts", import.meta.url).href;
export const PROBE_WORKER = new URL("./model-worker-probe.ts", import.meta.url).href;

const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, number>) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An Anthropic Messages reply that thinks before it answers. */
function anthropicReply(): Response {
  const events: Array<[string, Record<string, unknown>]> = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-x", content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Weighing it" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " up." } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }]
  ];
  return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

/** A Chat Completions provider on this machine (and Anthropic Messages, which
 *  thinks first). The model id picks the reply: "slow" streams 20 words 50 ms
 *  apart, "quiet-tools" one tool call's arguments 900 ms apart, anything else
 *  answers at once. */
function stubProvider() {
  const bodies: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.text();
      bodies.push(body);
      const model = (JSON.parse(body) as { model: string }).model;
      if (new URL(req.url).pathname.endsWith("/messages")) return anthropicReply();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (s: string) => controller.enqueue(new TextEncoder().encode(s));
          try {
            if (model === "slow") {
              for (let i = 0; i < 20; i++) { send(chunk({ content: `w${i} ` })); await sleep(50); }
            } else if (model === "quiet-tools") {
              send(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }));
              for (const piece of ["{\"comm", "and\":", "\"ls -la", "\"}"]) { await sleep(900); send(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] })); }
              send(chunk({}, "tool_calls", { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }));
            } else {
              for (const piece of ["Hello", ", ", "world."]) send(chunk({ content: piece }));
            }
            if (model !== "quiet-tools") send(chunk({}, "stop", { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }));
            send("data: [DONE]\n\n");
            controller.close();
          } catch { /* the client went away */ }
        }
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
  });
  const fetchHere = ((input: RequestInfo | URL, init?: RequestInit) => server.fetch(new Request(input, init))) as typeof fetch;
  return { bodies, fetchHere, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

const toDispose: Array<() => unknown> = [];

/** Stops every host and stub the test built, newest first. */
export async function disposeHosts(): Promise<void> {
  for (const d of toDispose.splice(0).reverse()) await d();
}

/** A stub provider and a host, both disposed after the test. */
export function setup(opts: ConstructorParameters<typeof ModelCallHost>[0] = {}) {
  const provider = stubProvider();
  const host = new ModelCallHost(opts);
  toDispose.push(() => provider.stop(), () => host.dispose());
  return { provider, host };
}

export const snapshot = (url: string, model = "fast"): AgentProviderSnapshot => ({
  provider: "openai-compatible", providerType: "openai-compatible", providerName: "stub", model, apiKey: "k", baseURL: url,
  openaiModelApi: "chat", reasoningEffort: "provider-default"
});
export const anthropic = (url: string): AgentProviderSnapshot => ({ provider: "anthropic", model: "claude-x", apiKey: "k", baseURL: url, reasoningEffort: "high", supportsReasoning: true });
export const TOOLS: OfferedToolSpec[] = [{ name: "bash", description: "Run a command.", schemaKey: "agent/bash.params" }];
export const MESSAGES: ModelMessage[] = [{ role: "user", content: "Say hello." }];

export function request(snap: AgentProviderSnapshot, over: Partial<HostStreamRequest> = {}): HostStreamRequest {
  const model = createAgentProvider(snap);
  return {
    attemptId: `att_${Math.random()}`, threadId: "thr_1", wakeId: "wake_1",
    candidate: { model: model.model, construction: model.construction, meta: { provider: "openai-compatible", model: snap.model } },
    tools: TOOLS, system: "Be brief.", messages: MESSAGES, callOptions: { providerOptions: undefined, headers: undefined, reasoning: undefined },
    askSummary: false, timeout: {}, idleMs: 60_000, startedAt: Date.now(),
    diagnostics: { startedAt: Date.now(), callId: null, wakeId: "wake_1", candidateIndex: 0, attempt: 1, idleTimeoutMs: 60_000 },
    signal: new AbortController().signal,
    ...over
  };
}

export function recording() {
  const seen = { reasoning: 0, headings: [] as string[], deltas: [] as Array<[string, string]> };
  const hooks: ModelStreamHooks = {
    onReasoning: () => { seen.reasoning += 1; },
    onHeading: (h) => { seen.headings.push(h); },
    onTextDelta: (d, t) => { seen.deltas.push([d, t]); }
  };
  return { seen, hooks };
}

/** Waits for the host's worker to take this candidate's streams. */
export async function ready(host: ModelCallHost, candidate: WakeLlmCandidate) {
  for (let i = 0; i < 200 && !host.canStream(candidate, TOOLS); i++) await sleep(25);
  expect(host.canStream(candidate, TOOLS)).toBe(true);
}
