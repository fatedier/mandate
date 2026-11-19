import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { chatToolCallReply } from "./helpers/model-stub-server.js";
import { WakeLlmAttempts } from "../src/server/modules/agent/wake-llm-attempts.js";
import { PATHS, candidateFor, env, portsHere, ready, releaseEnvs, releaseEnvsAfterEach, rows, step, untimed } from "./helpers/model-call-equivalence.js";

// A wake step's model call behaves the same with its stream on the
// model-call worker as on this thread: the same request on the wire, the
// same result, the same push events, the same Activity row, and the same
// retries. Stops, concurrent streams and lost workers:
// model-call-equivalence-stops.test.ts.

releaseEnvsAfterEach();

test("every provider path: the same request, result, events and Activity row with the stream on the worker", async () => {
  for (const [label, snapshot] of PATHS("")) {
    const here = env(); const there = env();
    const a = candidateFor(here.store, { ...snapshot, baseURL: here.stub.url + snapshot.baseURL! });
    const b = candidateFor(there.store, { ...snapshot, baseURL: there.stub.url + snapshot.baseURL! });
    await ready(there, b);
    const inProcess = await step(here, a, { worker: false });
    const viaWorker = await step(there, b, { worker: true });
    expect([label, inProcess.ok]).toEqual([label, true]);
    expect([label, untimed(viaWorker)]).toEqual([label, untimed(inProcess)]);
    expect([label, viaWorker.events]).toEqual([label, inProcess.events]);
    expect([label, there.stub.bodies.map((x) => x.body)]).toEqual([label, here.stub.bodies.map((x) => x.body)]);
    expect([label, rows(there.store)]).toEqual([label, rows(here.store)]);
    expect([label, portsHere.has(new URL(there.stub.url).port), portsHere.has(new URL(here.stub.url).port)]).toEqual([label, false, true]);
    await releaseEnvs();
  }
}, 60_000);

test("a refused summary request is retried without it and not asked again, as on this thread", async () => {
  const refusal = () => new Response(JSON.stringify({ error: { message: "Invalid value: 'auto'.", type: "invalid_request_error", param: "reasoning.summary" } }), { status: 400, headers: { "content-type": "application/json" } });
  const outcome = async (worker: boolean) => {
    const e = env();
    const c = candidateFor(e.store, PATHS(e.stub.url)[1]![1]);
    if (worker) await ready(e, c);
    const runner = new WakeLlmAttempts({ sse: { emit: () => {} }, llmTimeout: () => ({}), streamIdleTimeoutMs: () => 60_000, ...(worker ? { modelCalls: e.host } : {}) });
    e.stub.next(refusal);
    const first = await step(e, c, { worker, attempts: runner });
    const second = await step(e, c, { worker, attempts: runner });
    return { first: untimed(first), second: untimed(second), bodies: e.stub.bodies.map((x) => JSON.parse(x.body).reasoning ?? null), rows: rows(e.store) };
  };
  const here = await outcome(false);
  expect(here.bodies.map((r: { summary?: unknown } | null) => r?.summary ?? null)).toEqual(["auto", null, null]);
  expect(await outcome(true)).toEqual(here);
}, 30_000);

test("an overloaded provider is retried, as on this thread", async () => {
  const outcome = async (worker: boolean) => {
    const e = env();
    const c = candidateFor(e.store, PATHS(e.stub.url)[2]![1]);
    if (worker) await ready(e, c);
    e.stub.next(() => new Response(JSON.stringify({ error: { message: "Overloaded" } }), { status: 503, headers: { "content-type": "application/json" } }));
    const r = await step(e, c, { worker });
    return { r: untimed(r), requests: e.stub.bodies.length, rows: rows(e.store) };
  };
  const here = await outcome(false);
  expect(here.requests).toBe(2);
  expect(await outcome(true)).toEqual(here);
}, 30_000);

test("a stream error with no words, only a status and a kind, is retried, as on this thread", async () => {
  const overloaded = { code: 503, type: "overloaded_error" };
  // The custom chat path hands the error on as the provider's raw body; the
  // Kilo one as a stream error whose fields a step's wrapping drops.
  const cases: Array<[number, { code: number; type: string }]> = [[2, overloaded], [5, overloaded], [5, { code: 429, type: "rate_limit_error" }], [5, { code: 500, type: "server_error" }]];
  for (const [path, shape] of cases) {
    {
      const outcome = async (worker: boolean) => {
        const e = env();
        const c = candidateFor(e.store, PATHS(e.stub.url)[path]![1]);
        if (worker) await ready(e, c);
        e.stub.next(() => new Response(`data: ${JSON.stringify({ error: { message: "", ...shape } })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
        const r = await step(e, c, { worker });
        return { r: untimed(r), requests: e.stub.bodies.length, rows: rows(e.store) };
      };
      const here = await outcome(false);
      expect([path, shape.code, here.requests]).toEqual([path, shape.code, 2]);
      expect(await outcome(true)).toEqual(here);
    }
  }
}, 60_000);

test("an image window streams identically, and a retry sends it whole again", async () => {
  const image = new Uint8Array(1_000_000).fill(7);
  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "file", data: image, mediaType: "image/png" }] }];
  // Anthropic's own words for it, which both paths read the same way.
  const overloaded = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json" } });
  const here = env(); const there = env();
  const a = candidateFor(here.store, PATHS(here.stub.url)[0]![1]);
  const b = candidateFor(there.store, PATHS(there.stub.url)[0]![1]);
  await ready(there, b);
  here.stub.next(overloaded);
  there.stub.next(overloaded);
  const inProcess = await step(here, a, { worker: false, messages });
  const viaWorker = await step(there, b, { worker: true, messages });
  expect(untimed(viaWorker)).toEqual(untimed(inProcess));
  expect(rows(there.store)).toEqual(rows(here.store));
  expect([here.stub.bodies.length, there.stub.bodies.length]).toEqual([2, 2]);
  expect(there.stub.bodies[1]!.body).toBe(here.stub.bodies[1]!.body);
  expect(there.stub.bodies[1]!.body).toBe(there.stub.bodies[0]!.body);
  expect(there.stub.bodies[1]!.body).toContain(Buffer.from(image).toString("base64"));
  expect(portsHere.has(new URL(there.stub.url).port)).toBe(false);
  expect([image.byteLength, image.every((byte) => byte === 7)]).toEqual([1_000_000, true]);
}, 30_000);

test("a step offered no tools sends the same request on every provider path", async () => {
  for (const [name, snapshot] of PATHS("http://127.0.0.1:1")) {
    const here = env(); const there = env();
    const a = candidateFor(here.store, { ...snapshot, baseURL: snapshot.baseURL!.replace("http://127.0.0.1:1", here.stub.url) });
    const b = candidateFor(there.store, { ...snapshot, baseURL: snapshot.baseURL!.replace("http://127.0.0.1:1", there.stub.url) });
    await ready(there, b, []);
    const inProcess = await step(here, a, { worker: false, tools: [] });
    const viaWorker = await step(there, b, { worker: true, tools: [] });
    expect([name, untimed(viaWorker)]).toEqual([name, untimed(inProcess)]);
    expect([name, there.stub.bodies[0]!.body]).toEqual([name, here.stub.bodies[0]!.body]);
  }
}, 60_000);

test("a step offered no tools: a tool call the model makes up ends as it does on this thread", async () => {
  const outcome = async (worker: boolean) => {
    const e = env();
    const c = candidateFor(e.store, PATHS(e.stub.url)[2]![1]);
    if (worker) await ready(e, c, []);
    e.stub.next(() => chatToolCallReply("bash", { command: "ls" }));
    const r = await step(e, c, { worker, tools: [] });
    return { r: untimed(r), body: e.stub.bodies[0]!.body, rows: rows(e.store) };
  };
  const here = await outcome(false);
  expect(JSON.stringify(here.r)).toContain("bash");
  expect(await outcome(true)).toEqual(here);
}, 30_000);
