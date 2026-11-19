import { afterEach, expect, test } from "bun:test";
import { ModelWorkerLostError } from "../src/server/modules/agent/model-call-host.js";
import { isRetryableLlmError } from "../src/server/modules/llm/retry-policy.js";
import { disposeHosts, FAKE_WORKER, recording, ready, request, setup, sleep, snapshot, TOOLS } from "./helpers/model-call-host.js";

// A model stream through the model-call worker, stopped or cut off: Stop
// ends it with what the worker or this thread saw; a worker that is killed,
// stuck, never ready or disposed fails or leaves its streams as a dropped
// connection or a process exit would, and nothing it sends after that
// reaches the step; the worker started again gets its own grace. The
// harness is tests/helpers/model-call-host.ts.

afterEach(disposeHosts);

test("Stop mid-stream: the worker's own answer comes back, with its diagnostics", async () => {
  const { provider, host } = setup();
  const stop = new AbortController();
  const req = request(snapshot(provider.url, "slow"), { signal: stop.signal });
  await ready(host, req.candidate);
  const pending = host.stream(req, recording().hooks);
  await sleep(300);
  stop.abort(new DOMException("Stopped by user.", "AbortError"));
  const result = await pending;
  expect(result.ok).toBe(false);
  expect((await host.endAttempt(req.attemptId, "failed"))?.summary.status).toBe("failed");
});

test("Stop that the worker does not answer still ends the stream, with what this thread saw of it", async () => {
  const { provider, host } = setup({
    abortAnswerMs: 200,
    spawn: (_spec, options) => new Worker(FAKE_WORKER, { ...options, env: { ...options.env as Record<string, string>, FAKE_MODEL_WORKER_MODE: "late" } })
  });
  const stop = new AbortController();
  const req = request(snapshot(provider.url), { signal: stop.signal });
  await ready(host, req.candidate);
  const pending = host.stream(req, recording().hooks);
  await sleep(150);
  stop.abort(new DOMException("Stopped by user.", "AbortError"));
  const result = await pending;
  expect(!result.ok && (result.error as Error).name).toBe("AbortError");
  expect(!result.ok && result.observed?.firstOutputAt).toBeGreaterThan(0);
  expect(!result.ok && result.observed?.emittedText).toBe(true);
});

test("a stream asked for with Stop already pressed ends at once", async () => {
  const { provider, host } = setup();
  const stop = new AbortController();
  stop.abort(new DOMException("Stopped by user.", "AbortError"));
  const result = await host.stream(request(snapshot(provider.url), { signal: stop.signal }), recording().hooks);
  expect(result.ok).toBe(false);
  expect(!result.ok && (result.error as Error).name).toBe("AbortError");
});

test("a worker killed mid-stream fails it as a dropped connection, which the retry policy retries", async () => {
  const workers: Worker[] = [];
  const { provider, host } = setup({ spawn: (spec, options) => { const w = new Worker(spec, options); workers.push(w); return w; } });
  const req = request(snapshot(provider.url, "slow"));
  await ready(host, req.candidate);
  const { seen, hooks } = recording();
  const pending = host.stream(req, hooks);
  await sleep(300);
  workers[0]!.terminate();
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error instanceof ModelWorkerLostError).toBe(true);
  expect(!result.ok && isRetryableLlmError(result.error)).toBe(true);
  expect(!result.ok && result.observed?.firstOutputAt).toBeGreaterThan(0);
  expect(await host.endAttempt(req.attemptId, "failed")).toBeNull();
  const after = seen.deltas.length;
  await sleep(200);
  expect(seen.deltas.length).toBe(after);
});

test("a stuck worker (no alive) is replaced, and a late worker's messages never reach the step", async () => {
  const spawned: string[] = [];
  const { provider, host } = setup({
    aliveLimitMs: 300, restartBackoffMs: [50],
    spawn: (spec, options) => {
      spawned.push("worker");
      return spawned.length === 1 ? new Worker(FAKE_WORKER, { ...options, env: { ...options.env as Record<string, string>, FAKE_MODEL_WORKER_MODE: "late" } }) : new Worker(spec, options);
    }
  });
  const req = request(snapshot(provider.url));
  await ready(host, req.candidate);
  const { seen, hooks } = recording();
  const result = await host.stream(req, hooks);
  expect(!result.ok && result.error instanceof ModelWorkerLostError).toBe(true);
  const heard = seen.deltas.length;
  await sleep(200);
  expect(seen.deltas.length).toBe(heard);
  // Its replacement is the real worker: the next stream goes through.
  await ready(host, req.candidate);
  expect((await host.stream(request(snapshot(provider.url)), recording().hooks)).ok).toBe(true);
  expect(spawned.length).toBe(2);
}, 15_000);

test("not ready within the bound: no stream is offered to it, and it is started again", async () => {
  const spawned: number[] = [];
  const { provider, host } = setup({ readyWaitMs: 100, restartBackoffMs: [50], spawn: (_s, options) => { spawned.push(1); return new Worker(FAKE_WORKER, { ...options, env: { ...options.env as Record<string, string>, FAKE_MODEL_WORKER_MODE: "never-ready" } }); } });
  const req = request(snapshot(provider.url));
  // The first stream it could take starts it.
  expect(host.canStream(req.candidate, TOOLS)).toBe(false);
  await sleep(400);
  expect(host.canStream(req.candidate, TOOLS)).toBe(false);
  expect(spawned.length).toBeGreaterThan(1);
});

test("dispose (the server going away) leaves a pending stream as a process exit would: unsettled, nothing more sent", async () => {
  const { provider, host } = setup();
  const req = request(snapshot(provider.url, "slow"));
  await ready(host, req.candidate);
  let settled = false;
  void host.stream(req, recording().hooks).then(() => { settled = true; });
  await sleep(150);
  await host.dispose();
  await sleep(300);
  expect(settled).toBe(false);
  expect(host.canStream(req.candidate, TOOLS)).toBe(false);
  expect(provider.bodies.length).toBe(1);
});

test("a new worker gets its own grace: one used up before it started does not count against it", async () => {
  let offset = 0;
  const { provider, host } = setup({ aliveLimitMs: 2_000, now: () => performance.now() + offset });
  // Late looks while no worker runs yet.
  offset += 5_000;
  await sleep(700);
  offset += 5_000;
  await sleep(700);
  const req = request(snapshot(provider.url, "slow"));
  await ready(host, req.candidate);
  const pending = host.stream(req, recording().hooks);
  offset += 15_000;
  expect((await pending).ok).toBe(true);
}, 20_000);
