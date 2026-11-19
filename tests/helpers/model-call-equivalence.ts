import { afterEach } from "bun:test";
import type { ModelMessage } from "ai";
import type { MandateStore } from "../../src/server/app/store.js";
import { AgentLlmCallRecorder } from "../../src/server/modules/activity/llm-call-recorder.js";
import { createAgentProvider, type AgentProviderSnapshot } from "../../src/server/modules/agent/llm-provider.js";
import { ModelCallHost } from "../../src/server/modules/agent/model-call-host.js";
import { buildToolSet, type OfferedToolSpec } from "../../src/server/modules/agent/tool-set.js";
import { TOOL_INPUT_SCHEMAS } from "../../src/server/modules/agent/tool-schema-catalog.js";
import { WakeLlmAttempts, type WakeLlmCandidate } from "../../src/server/modules/agent/wake-llm-attempts.js";
import { mockFetch } from "./fetch.js";
import { startModelStub } from "./model-stub-server.js";
import { tempDir } from "./temp.js";
import { waitUntil } from "./wait.js";
import { testStore } from "./test-store.js";

// What the model-call equivalence files share: a step run as a wake step runs
// it, on this thread or on the model-call worker, against a stub of its own.

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => unknown> = [];
/** This thread's own requests, to the handler of the stub they are for;
 *  a worker's go over loopback. */
const stubsByPort = new Map<string, typeof fetch>();
/** The ports this thread sent requests to: a run on the worker sends none. */
export const portsHere = new Set<string>();
let routed = false;
/** Stops every stub, store and host made since the last release. */
export async function releaseEnvs(): Promise<void> {
  for (const c of cleanups.splice(0).reverse()) await c();
  stubsByPort.clear();
  portsHere.clear();
  routed = false;
}

/** Releases after each test of the file that calls it: a hook registered when
 *  this module loads would reach only the first file to import it in a
 *  process. */
export function releaseEnvsAfterEach(): void {
  afterEach(releaseEnvs);
}

export function env() {
  const stub = startModelStub();
  const store = testStore(tempDir("md-equivalence-"));
  stubsByPort.set(new URL(stub.url).port, stub.fetchHere);
  if (!routed) {
    routed = true;
    mockFetch((call) => {
      const port = new URL(call.url).port;
      portsHere.add(port);
      return stubsByPort.get(port)!(call.url, call.init);
    });
  }
  const workers: Worker[] = [];
  const host = new ModelCallHost({ spawn: (spec, options) => { const w = new Worker(spec, options); workers.push(w); return w; } });
  cleanups.push(() => stub.stop(), () => store.db.close(), () => host.dispose());
  return { stub, store, host, workers };
}

export const TOOLS: OfferedToolSpec[] = [{ name: "bash", description: "Run a command.", schemaKey: "agent/bash.params" }];
export const PATHS = (url: string): Array<[string, AgentProviderSnapshot]> => [
  ["anthropic messages", { provider: "anthropic", model: "claude-x", apiKey: "k", baseURL: `${url}/v1`, reasoningEffort: "high", supportsReasoning: true }],
  ["openai responses", { provider: "openai", model: "gpt-5.5", apiKey: "k", baseURL: `${url}/v1`, reasoningEffort: "medium", supportsReasoning: true }],
  ["custom chat", { provider: "openai-compatible", providerType: "openai-compatible", providerName: "proxy", model: "m-chat", apiKey: "k", baseURL: `${url}/v1`, openaiModelApi: "chat", reasoningEffort: "provider-default" }],
  ["open responses", { provider: "openai-compatible", providerType: "openai-compatible", providerName: "proxy", model: "vendor/model-r", apiKey: "k", baseURL: `${url}/v1`, reasoningEffort: "high", supportsReasoning: true }],
  ["google", { provider: "google", model: "gemini-x", apiKey: "k", baseURL: `${url}/v1beta`, reasoningEffort: "provider-default" }],
  ["kilo chat", { provider: "kilo", providerType: "kilo", model: "vendor/model-k", apiKey: "k", baseURL: `${url}/api`, organizationId: "org-1", reasoningEffort: "low" }],
  ["kilo messages", { provider: "anthropic", providerType: "kilo", model: "claude-x", apiKey: "k", baseURL: `${url}/api`, organizationId: "org-1", reasoningEffort: "high", supportsReasoning: true }]
];

export function candidateFor(store: MandateStore, snapshot: AgentProviderSnapshot): WakeLlmCandidate {
  const built = createAgentProvider(snapshot);
  return {
    model: built.model, meta: built.meta, ...(built.construction ? { construction: built.construction } : {}),
    llmCallRecorder: new AgentLlmCallRecorder({ store, logRequests: "metadata", provider: built.meta.provider, providerName: built.meta.providerName, model: built.meta.model, baseURL: built.meta.baseURL, apiMode: "streamText" })
  };
}

/** One attempt run as a wake step runs it, with or without the worker. */
export async function step(e: ReturnType<typeof env>, candidate: WakeLlmCandidate, opts: { worker: boolean; attempts?: WakeLlmAttempts; messages?: ModelMessage[]; signal?: AbortSignal; threadId?: string; tools?: OfferedToolSpec[] } ) {
  const events: Array<{ name: string; data: unknown }> = [];
  const runner = opts.attempts ?? new WakeLlmAttempts({
    sse: { emit: (name, data) => events.push({ name, data }), flushMessageDelta: () => events.push({ name: "flush", data: null }) },
    llmTimeout: () => ({}), streamIdleTimeoutMs: () => 60_000,
    // The retries' order and counts are compared, not their waits.
    retryWait: async () => {},
    ...(opts.worker ? { modelCalls: e.host } : {})
  });
  const threadId = opts.threadId ?? "thr_1";
  const callId = candidate.llmCallRecorder!.startCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: threadId, metadata: {} });
  const signal = opts.signal ?? new AbortController().signal;
  try {
    const result = await runner.run({
      candidates: [candidate], threadId, wakeId: `wake_${threadId}`, requestPayload: {}, purpose: "agent_wake_step", metadata: {}, callId,
      streamArgs: { tools: buildToolSet(opts.tools ?? TOOLS, TOOL_INPUT_SCHEMAS), toolSpecs: opts.tools ?? TOOLS, system: "Be brief.", messages: opts.messages ?? [{ role: "user", content: "Say hello." }], abortSignal: signal },
      signal, onAttemptFailed: () => {}
    });
    return { ok: true as const, result, events };
  } catch (error) {
    return { ok: false as const, error, events };
  }
}

export async function ready(e: ReturnType<typeof env>, candidate: WakeLlmCandidate, tools: OfferedToolSpec[] = TOOLS) {
  await waitUntil(() => e.host.canStream(candidate, tools), { interval: 25, label: "the model worker can stream" });
}

const TIMING = new Set(["elapsedMs", "firstPartAtMs", "firstModelDataAtMs", "lastPartAtMs", "lastTimeoutActivityAtMs", "lastVisibleOutputAtMs", "latencyMs"]);
export function rows(store: MandateStore): Array<Record<string, unknown>> {
  return (store.db.prepare("select * from llm_calls order by rowid").all() as Array<Record<string, unknown>>).map((row) => {
    const { id: _i, created_at: _c, updated_at: _u, started_at: _s, finished_at: _f, latency_ms: _l, ttft_ms: ttft, ...rest } = row;
    const metadata = typeof rest.metadata_json === "string" ? JSON.parse(rest.metadata_json) as Record<string, unknown> : null;
    const stream = metadata?.stream as Record<string, unknown> | undefined;
    if (stream) for (const k of Object.keys(stream)) if (TIMING.has(k)) delete stream[k];
    // Each run has a stub of its own, on its own port.
    return JSON.parse(JSON.stringify({ ...rest, metadata_json: metadata, hasTtft: ttft !== null }).replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT")) as Record<string, unknown>;
  });
}
export const untimed = (r: Awaited<ReturnType<typeof step>>) => r.ok
  ? { ...r.result, answeredBy: undefined, firstOutputMs: null, ...(r.result.reasoning ? { reasoning: { ...r.result.reasoning, ms: 0 } } : {}) }
  : { error: (r.error as Error).message };
