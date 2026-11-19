import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createAgentProvider, type AgentProviderSnapshot } from "../src/server/modules/agent/llm-provider.js";
import type { HostStreamResult } from "../src/server/modules/agent/model-call-host.js";
import { openAttemptStreamState, streamModelOnce } from "../src/server/modules/agent/model-stream.js";
import { buildToolSet } from "../src/server/modules/agent/tool-set.js";
import { TOOL_INPUT_SCHEMAS } from "../src/server/modules/agent/tool-schema-catalog.js";
import { getLogLevel, logStacks, setLogLevel, setLogStacks } from "../src/server/platform/logger.js";
import { llmStreamTrace, setLlmStreamTrace } from "../src/server/modules/agent/llm-stream-diagnostics.js";
import { mockFetch } from "./helpers/fetch.js";
import { disposeHosts, PROBE_WORKER, anthropic, recording, ready, request, setup, sleep, snapshot, TOOLS, MESSAGES } from "./helpers/model-call-host.js";

// A model stream run by the model-call worker: what it sends and returns is
// what the same stream does on this thread, the worker logs at this thread's
// level, and an attempt's end brings back the worker's diagnostics. Stop and
// a lost, stuck or late worker are in model-call-host-stop, the watchdog's
// bound and clock in model-call-host-watchdog: the three files run side by
// side. The harness is tests/helpers/model-call-host.ts.

afterEach(disposeHosts);

async function inProcess(snap: AgentProviderSnapshot, fetchHere: typeof fetch) {
  // This thread's fetch is closed to the network in tests: its requests go
  // to the stub's handler directly (the worker's go over loopback).
  mockFetch((call) => fetchHere(call.url, call.init));
  const model = createAgentProvider(snap).model;
  const state = openAttemptStreamState({ model, timeout: {}, idleMs: 60_000, diagnostics: { startedAt: Date.now(), callId: null, wakeId: "wake_1", candidateIndex: 0, attempt: 1, idleTimeoutMs: 60_000 } });
  const { seen, hooks } = recording();
  try {
    const output = await streamModelOnce({ model, tools: buildToolSet(TOOLS, TOOL_INPUT_SCHEMAS), system: "Be brief.", messages: MESSAGES, callOptions: { providerOptions: undefined, headers: undefined, reasoning: undefined }, askSummary: false }, state, hooks);
    return { output, seen };
  } finally {
    state.idle.cleanup();
  }
}

const untimed = (r: HostStreamResult) => r.ok ? { ...r.output, collected: { ...r.output.collected, firstOutputMs: null } } : r;

test("a stream through the worker sends the same request and returns what it returns on this thread", async () => {
  const { provider, host } = setup();
  const req = request(snapshot(provider.url));
  await ready(host, req.candidate);
  const { seen, hooks } = recording();
  const viaWorker = await host.stream(req, hooks);
  const here = await inProcess(snapshot(provider.url), provider.fetchHere);
  expect(viaWorker.ok).toBe(true);
  expect(untimed(viaWorker)).toEqual({ ...here.output, collected: { ...here.output.collected, firstOutputMs: null } });
  expect(seen.deltas).toEqual(here.seen.deltas);
  expect(provider.bodies[0]).toBe(provider.bodies[1]!);
  const diagnostics = await host.endAttempt(req.attemptId, "succeeded");
  expect([diagnostics?.summary.status, typeof diagnostics?.ttftMs]).toEqual(["succeeded", "number"]);
});

test("reasoning is heard once, as on this thread", async () => {
  const { provider, host } = setup();
  const req = request(anthropic(provider.url));
  await ready(host, req.candidate);
  const { seen, hooks } = recording();
  expect((await host.stream(req, hooks)).ok).toBe(true);
  expect(seen.reasoning).toBe((await inProcess(anthropic(provider.url), provider.fetchHere)).seen.reasoning);
  expect(seen.reasoning).toBe(1);
});

test("nothing is offered for a candidate without a snapshot or tools outside the catalog", async () => {
  const { provider, host } = setup();
  const req = request(snapshot(provider.url));
  await ready(host, req.candidate);
  expect(host.canStream({ ...req.candidate, construction: undefined }, TOOLS)).toBe(false);
  expect(host.canStream(req.candidate, null)).toBe(false);
  expect(host.canStream(req.candidate, TOOLS)).toBe(true);
});

test("two streams with different snapshots at once each get their own model", async () => {
  const { provider, host } = setup();
  const a = request(snapshot(provider.url, "slow"));
  await ready(host, a.candidate);
  const first = host.stream(a, recording().hooks);
  await sleep(100);
  const second = await host.stream(request(snapshot(provider.url, "fast")), recording().hooks);
  expect(second.ok && second.output.collected.text).toBe("Hello, world.");
  const done = await first;
  expect(done.ok && done.output.collected.text.startsWith("w0 w1")).toBe(true);
  expect(provider.bodies.map((b) => (JSON.parse(b) as { model: string }).model).sort()).toEqual(["fast", "slow"]);
});

test("the worker's first import keeps a stray rejection or throw from ending it", () => {
  // bun test turns any unhandled error in a worker into the worker's error,
  // so the behaviour itself is checked outside it (the ledger's probe); this
  // keeps the handlers where they hold from the start of the worker.
  const source = readFileSync(new URL("../src/server/modules/agent/model-call-worker.ts", import.meta.url), "utf8");
  const firstImport = source.split("\n").find((line) => line.startsWith("import "));
  expect(firstImport).toBe('import "./model-call-worker-errors.js";');
  const handlers = readFileSync(new URL("../src/server/modules/agent/model-call-worker-errors.ts", import.meta.url), "utf8");
  expect(handlers).toContain('process.on("unhandledRejection"');
  expect(handlers).toContain('process.on("uncaughtException"');
  expect(handlers).not.toContain("exit");
});

/** A worker that reports, after each message, the type it was sent and the
 *  level, stacks and stream trace settings it then uses. */
function probing(posted: string[], seen: string[]) {
  return (_spec: string | URL, options: WorkerOptions) => {
    const worker = new Worker(PROBE_WORKER, options);
    const post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: { type: string }) => { posted.push(message.type); post(message); }) as typeof worker.postMessage;
    worker.addEventListener("message", (event: MessageEvent<{ type: string; level?: string; stacks?: boolean; trace?: boolean }>) => {
      if (event.data.type === "probeLevel") seen.push(`${event.data.level} ${event.data.stacks ? "stacks" : "no stacks"} ${event.data.trace ? "trace" : "no trace"}`);
    });
    return worker;
  };
}

test("the worker logs at this thread's level, stacks and stream trace settings from its first message", async () => {
  const [level, stacks, trace] = [getLogLevel(), logStacks(), llmStreamTrace()];
  setLogLevel("silent");
  setLogStacks(true);
  setLlmStreamTrace(false);
  const posted: string[] = [];
  const seen: string[] = [];
  try {
    const { provider, host } = setup({ spawn: probing(posted, seen) });
    const req = request(snapshot(provider.url));
    await ready(host, req.candidate);
    expect((await host.stream(req, recording().hooks)).ok).toBe(true);
    expect(posted.slice(0, 2)).toEqual(["logging", "stream"]);
    expect(seen.slice(0, 2)).toEqual(["silent stacks no trace", "silent stacks no trace"]);
  } finally {
    setLogLevel(level);
    setLogStacks(stacks);
    setLlmStreamTrace(trace);
  }
});

test("a log level changed after the worker started is the worker's level for its next stream", async () => {
  const before = getLogLevel();
  setLogLevel("silent");
  const posted: string[] = [];
  const seen: string[] = [];
  try {
    const { provider, host } = setup({ spawn: probing(posted, seen) });
    const req = request(snapshot(provider.url));
    await ready(host, req.candidate);
    setLogLevel("debug");
    expect((await host.stream(req, recording().hooks)).ok).toBe(true);
    expect(posted.slice(0, 3)).toEqual(["logging", "logging", "stream"]);
    expect(seen.slice(0, 3)).toEqual(["silent no stacks trace", "debug no stacks trace", "debug no stacks trace"]);
  } finally {
    setLogLevel(before);
  }
});

test("a stacks or stream trace change alone reaches a running worker before its next stream", async () => {
  const [level, stacks, trace] = [getLogLevel(), logStacks(), llmStreamTrace()];
  setLogLevel("silent");
  setLogStacks(false);
  setLlmStreamTrace(true);
  const posted: string[] = [];
  const seen: string[] = [];
  try {
    const { provider, host } = setup({ spawn: probing(posted, seen) });
    const req = request(snapshot(provider.url));
    await ready(host, req.candidate);
    setLogStacks(true);
    expect((await host.stream(req, recording().hooks)).ok).toBe(true);
    setLlmStreamTrace(false);
    expect((await host.stream(request(snapshot(provider.url)), recording().hooks)).ok).toBe(true);
    expect(posted.slice(0, 5)).toEqual(["logging", "logging", "stream", "logging", "stream"]);
    expect(seen.slice(0, 5)).toEqual(["silent no stacks trace", "silent stacks trace", "silent stacks trace", "silent stacks no trace", "silent stacks no trace"]);
  } finally {
    setLogLevel(level);
    setLogStacks(stacks);
    setLlmStreamTrace(trace);
  }
});

test("an attempt's end waits for a worker slow to answer it, and gets its diagnostics", async () => {
  const { provider, host } = setup({ spawn: (_spec, options) =>
    new Worker(PROBE_WORKER, { ...options, env: { ...options.env as Record<string, string>, MODEL_WORKER_PROBE_END_DELAY_MS: "2500" } }) });
  const req = request(snapshot(provider.url));
  await ready(host, req.candidate);
  expect((await host.stream(req, recording().hooks)).ok).toBe(true);
  const diagnostics = await host.endAttempt(req.attemptId, "succeeded");
  expect(diagnostics?.summary.status).toBe("succeeded");
  expect(diagnostics?.ttftMs).not.toBeNull();
}, 20_000);

test("an attempt's end still waiting when the worker is lost ends at once, with nothing", async () => {
  const workers: Worker[] = [];
  const { provider, host } = setup({ spawn: (_spec, options) => {
    const worker = new Worker(PROBE_WORKER, { ...options, env: { ...options.env as Record<string, string>, MODEL_WORKER_PROBE_END_DELAY_MS: "60000" } });
    workers.push(worker);
    return worker;
  } });
  const req = request(snapshot(provider.url));
  await ready(host, req.candidate);
  expect((await host.stream(req, recording().hooks)).ok).toBe(true);
  const ending = host.endAttempt(req.attemptId, "succeeded");
  const startedAt = performance.now();
  workers[0]!.terminate();
  expect(await ending).toBeNull();
  expect(performance.now() - startedAt).toBeLessThan(2_000);
}, 20_000);
