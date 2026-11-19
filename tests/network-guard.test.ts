import { afterEach, expect, test } from "bun:test";
import { waitUntil } from "./helpers/wait.js";
import { createAgentProvider, type AgentProviderSnapshot } from "../src/server/modules/agent/llm-provider.js";
import { ModelCallHost } from "../src/server/modules/agent/model-call-host.js";
import type { OfferedToolSpec } from "../src/server/modules/agent/tool-registry.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

test("test setup blocks real network requests by default", async () => {
  await expect(fetch("https://example.com")).rejects.toThrow("Test attempted a real network request");
});

/** A server on this machine's loopback that answers every request (by
 *  default with "ok"). */
function loopbackServer(answer: () => Response = () => new Response("ok")) {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => { requests.push(req.url); return answer(); } });
  cleanups.push(() => server.stop(true));
  return { port: server.port, requests };
}

async function fetchInWorker(url: string): Promise<{ ok: boolean; status?: number; message?: string }> {
  const worker = new Worker(new URL("./helpers/fetch-in-worker.ts", import.meta.url).href);
  cleanups.push(() => worker.terminate());
  const answers: Array<Record<string, unknown>> = [];
  worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => { answers.push(event.data); };
  await waitUntil(() => answers.length > 0, { interval: 25, label: "the worker's first message" });
  worker.postMessage({ url });
  await waitUntil(() => answers.length > 1, { timeout: 10_000, interval: 25, label: "the worker's answer" });
  return answers[1] as { ok: boolean; status?: number; message?: string };
}

test("a worker a test starts reaches nothing but this machine's loopback", async () => {
  const local = loopbackServer();
  const refused = await fetchInWorker(`http://0.0.0.0:${local.port}/`);
  expect(refused.ok).toBe(false);
  expect(refused.message).toContain("Test attempted a real network request");
  expect(local.requests).toStrictEqual([]);
  expect((await fetchInWorker("https://example.com/")).message).toContain("Test attempted a real network request");
  expect(await fetchInWorker(`http://127.0.0.1:${local.port}/`)).toEqual({ ok: true, status: 200 });
}, 30_000);

test("a redirect a worker's request meets is refused, wherever it points; other answers pass as they are", async () => {
  const target = loopbackServer();
  for (const to of [`http://0.0.0.0:${target.port}/`, `http://127.0.0.1:${target.port}/`]) {
    const redirecting = loopbackServer(() => Response.redirect(to, 302));
    const refused = await fetchInWorker(`http://127.0.0.1:${redirecting.port}/`);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("Test attempted to follow a redirect");
  }
  expect(target.requests).toStrictEqual([]);
  // A 3xx fetch does not follow comes back as it is.
  const notModified = loopbackServer(() => new Response(null, { status: 304, headers: { location: `http://0.0.0.0:${target.port}/` } }));
  expect(await fetchInWorker(`http://127.0.0.1:${notModified.port}/`)).toEqual({ ok: true, status: 304 });
}, 30_000);

test("a model-call worker started in a test, as the server starts it, is held to the same", async () => {
  const local = loopbackServer();
  const host = new ModelCallHost();
  cleanups.push(() => host.dispose());
  const tools: OfferedToolSpec[] = [];
  const snapshot: AgentProviderSnapshot = { provider: "openai-compatible", providerType: "openai-compatible", providerName: "stub", model: "m", apiKey: "k", baseURL: `http://0.0.0.0:${local.port}/v1`, openaiModelApi: "chat", reasoningEffort: "provider-default" };
  const built = createAgentProvider(snapshot);
  const candidate = { model: built.model, construction: built.construction, meta: { provider: "openai-compatible", model: "m" } };
  await waitUntil(() => host.canStream(candidate, tools), { interval: 25, label: "the model worker can stream" });
  const result = await host.stream({
    attemptId: "att_1", threadId: "thr_1", wakeId: "wake_1", candidate, tools, messages: [{ role: "user", content: "Say hello." }],
    callOptions: { providerOptions: undefined, headers: undefined, reasoning: undefined }, askSummary: false, timeout: {}, idleMs: 60_000, startedAt: Date.now(),
    diagnostics: { startedAt: Date.now(), callId: null, wakeId: "wake_1", candidateIndex: 0, attempt: 1, idleTimeoutMs: 60_000 },
    signal: new AbortController().signal
  }, { onReasoning: () => {}, onHeading: () => {}, onTextDelta: () => {} });
  expect(result.ok).toBe(false);
  const error = !result.ok ? result.error as Error & { cause?: Error } : null;
  expect(`${error?.message} ${error?.cause?.message}`).toContain("Test attempted a real network request");
  expect(local.requests).toStrictEqual([]);
}, 30_000);
