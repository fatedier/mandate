import { afterEach, expect, test } from "bun:test";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { createAgentProvider } from "../src/server/modules/agent/llm-provider.js";
import { ModelCallHost } from "../src/server/modules/agent/model-call-host.js";
import { buildToolSet, type OfferedToolSpec } from "../src/server/modules/agent/tool-set.js";
import { TOOL_INPUT_SCHEMAS } from "../src/server/modules/agent/tool-schema-catalog.js";
import { WakeLlmAttempts, type WakeLlmCandidate } from "../src/server/modules/agent/wake-llm-attempts.js";
import { mockFetch } from "./helpers/fetch.js";
import { startModelStub } from "./helpers/model-stub-server.js";
import { tempDir } from "./helpers/temp.js";
import { testStore } from "./helpers/test-store.js";

// A model stream on this thread is named in the stall log while it runs, so
// a stall it causes says so; one on the model-call worker leaves nothing here.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const TOOLS: OfferedToolSpec[] = [{ name: "bash", description: "Run a command.", schemaKey: "agent/bash.params" }];

async function labelsOf(worker: boolean) {
  const stub = startModelStub();
  const store = testStore(tempDir("md-stall-label-"));
  const host = new ModelCallHost();
  cleanups.push(() => stub.stop(), () => store.db.close(), () => host.dispose());
  mockFetch((call) => stub.fetchHere(call.url, call.init));
  const built = createAgentProvider({ provider: "openai-compatible", providerType: "openai-compatible", providerName: "proxy", model: "m-chat", apiKey: "k", baseURL: `${stub.url}/v1`, openaiModelApi: "chat", reasoningEffort: "provider-default" });
  const candidate: WakeLlmCandidate = {
    model: built.model, meta: built.meta, construction: built.construction,
    llmCallRecorder: new AgentLlmCallRecorder({ store, logRequests: "metadata", provider: built.meta.provider, model: built.meta.model, baseURL: built.meta.baseURL, apiMode: "streamText" })
  };
  if (worker) for (let i = 0; i < 200 && !host.canStream(candidate, TOOLS); i++) await sleep(25);
  const labels: string[] = [];
  const runner = new WakeLlmAttempts({
    sse: { emit: () => {} }, llmTimeout: () => ({}), streamIdleTimeoutMs: () => 60_000,
    ...(worker ? { modelCalls: host } : {}),
    stallWatch: { watched: (label, fn) => { labels.push(label); return fn(); } }
  });
  const signal = new AbortController().signal;
  await runner.run({
    candidates: [candidate], threadId: "thr_1", wakeId: "wake_1", requestPayload: {}, purpose: "agent_wake_step", metadata: {}, callId: null,
    streamArgs: { tools: buildToolSet(TOOLS, TOOL_INPUT_SCHEMAS), toolSpecs: TOOLS, messages: [{ role: "user", content: "hi" }], abortSignal: signal },
    signal, onAttemptFailed: () => {}
  });
  return labels;
}

test("a stream on this thread is named while it runs; one on the worker is not", async () => {
  expect(await labelsOf(false)).toEqual(["model stream (in process)"]);
  expect(await labelsOf(true)).toStrictEqual([]);
}, 30_000);
