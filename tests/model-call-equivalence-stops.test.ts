import { expect, test } from "bun:test";
import { slowChatReply, textReply } from "./helpers/model-stub-server.js";
import { TOOL_INPUT_SCHEMAS } from "../src/server/modules/agent/tool-schema-catalog.js";
import { buildToolSet } from "../src/server/modules/agent/tool-set.js";
import { WakeLlmAttempts } from "../src/server/modules/agent/wake-llm-attempts.js";
import { PATHS, TOOLS, candidateFor, env, portsHere, ready, releaseEnvsAfterEach, rows, sleep, step } from "./helpers/model-call-equivalence.js";

// A wake step's model call stopped, run beside another, or cut off behaves
// the same with its stream on the model-call worker as on this thread; a
// lost worker fails the stream as a dropped connection does. Requests and
// retries: model-call-equivalence.test.ts.

releaseEnvsAfterEach();

test("Stop mid-stream ends the step as a cancel, as on this thread", async () => {
  const outcome = async (worker: boolean) => {
    const e = env();
    const c = candidateFor(e.store, PATHS(e.stub.url)[2]![1]);
    if (worker) await ready(e, c);
    e.stub.next(() => slowChatReply(40, 40));
    const stop = new AbortController();
    setTimeout(() => stop.abort(new DOMException("Stopped by user.", "AbortError")), 250);
    const r = await step(e, c, { worker, signal: stop.signal });
    return { name: r.ok ? null : (r.error as Error).name, statuses: rows(e.store).map((row) => row.status) };
  };
  const here = await outcome(false);
  expect(here.name).toBe("WakeCanceledError");
  expect(await outcome(true)).toEqual(here);
}, 30_000);

test("concurrent streams keep their own deltas", async () => {
  const e = env();
  const c = candidateFor(e.store, PATHS(e.stub.url)[2]![1]);
  await ready(e, c);
  e.stub.next(() => textReply("chat", "one one one"), () => textReply("chat", "two two two"), () => textReply("chat", "three three three"));
  const runs = await Promise.all(["thr_a", "thr_b", "thr_c"].map((threadId) => step(e, c, { worker: true, threadId })));
  for (const run of runs) {
    expect(run.ok).toBe(true);
    const text = run.ok ? run.result.text : "";
    const deltas = run.events.filter((x) => x.name === "agentMessageDelta").map((x) => (x.data as { totalText: string }).totalText);
    expect(deltas.at(-1)).toBe(text);
    expect(new Set(text.split(" ")).size).toBe(1);
  }
});

test("a worker lost before any text: the step is retried and answers; the lost call's row says so", async () => {
  const e = env();
  const c = candidateFor(e.store, PATHS(e.stub.url)[2]![1]);
  await ready(e, c);
  e.stub.next(async () => { await sleep(400); return textReply("chat", "late reply"); });
  setTimeout(() => e.workers[0]!.terminate(), 150);
  const r = await step(e, c, { worker: true });
  expect(r.ok && r.result.text).toBeTruthy();
  const statuses = rows(e.store).map((row) => [row.status, String(row.error_json ?? "").includes("model worker was lost")]);
  expect(statuses).toEqual([["failed", true], ["succeeded", false]]);
}, 30_000);

test("a worker lost after text was shown fails the step as a dropped stream does", async () => {
  const e = env();
  const c = candidateFor(e.store, PATHS(e.stub.url)[2]![1]);
  await ready(e, c);
  e.stub.next(() => slowChatReply(40, 40));
  setTimeout(() => e.workers[0]!.terminate(), 300);
  const r = await step(e, c, { worker: true });
  expect(!r.ok && (r.error as Error).message).toContain("model worker was lost");
  const [row] = rows(e.store);
  expect([row!.status, row!.hasTtft]).toEqual(["failed", true]);
}, 30_000);

test("a server shutting down leaves the step as a process exit does: not ended (so a restart resumes it), nothing more tried", async () => {
  const e = env();
  const primary = candidateFor(e.store, PATHS(e.stub.url)[2]![1]);
  const fallback = candidateFor(e.store, { ...PATHS(e.stub.url)[2]![1], model: "m-fallback" });
  await ready(e, primary);
  e.stub.next(() => slowChatReply(40, 40));
  const runner = new WakeLlmAttempts({ sse: { emit: () => {} }, llmTimeout: () => ({}), streamIdleTimeoutMs: () => 60_000, modelCalls: e.host });
  const signal = new AbortController().signal;
  setTimeout(() => void e.host.dispose(), 250);
  let outcome = "pending";
  void runner.run({
    candidates: [primary, fallback], threadId: "thr_1", wakeId: "wake_1", requestPayload: {}, purpose: "agent_wake_step", metadata: {}, callId: null,
    streamArgs: { tools: buildToolSet(TOOLS, TOOL_INPUT_SCHEMAS), toolSpecs: TOOLS, messages: [{ role: "user", content: "hi" }], abortSignal: signal },
    signal, onAttemptFailed: () => {}
  }).then(() => { outcome = "answered"; }, () => { outcome = "failed"; });
  await sleep(1_000);
  expect(outcome).toBe("pending");
  expect(e.stub.bodies.map((b) => JSON.parse(b.body).model)).toEqual(["m-chat"]);
  expect(portsHere.size).toBe(0);
}, 30_000);
