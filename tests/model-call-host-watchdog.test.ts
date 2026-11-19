import { afterEach, expect, test } from "bun:test";
import { ModelWorkerLostError } from "../src/server/modules/agent/model-call-host.js";
import { disposeHosts, FAKE_WORKER, recording, ready, request, setup, sleep, snapshot } from "./helpers/model-call-host.js";

// The model-call host's watchdog: a worker that says it is alive keeps
// its streams however quiet they are toward this thread, and a jump of
// the host's own clock (a machine that slept, a thread held) does not
// take it for a silent one, while a stuck worker is still found. The
// harness is tests/helpers/model-call-host.ts.

afterEach(disposeHosts);

test("a stream silent toward this thread, streaming tool arguments for longer than the alive bound, completes", async () => {
  const { provider, host } = setup({ aliveLimitMs: 2_500 });
  const req = request(snapshot(provider.url, "quiet-tools"));
  await ready(host, req.candidate);
  const result = await host.stream(req, recording().hooks);
  expect(result.ok && result.output.collected.toolCalls.map((c) => c.toolName)).toEqual(["bash"]);
}, 15_000);

test("a machine that slept (the host's clock jumped between two of its looks) does not take the worker for a silent one", async () => {
  let offset = 0;
  const { provider, host } = setup({ aliveLimitMs: 2_000, now: () => performance.now() + offset });
  const req = request(snapshot(provider.url, "slow"));
  await ready(host, req.candidate);
  const pending = host.stream(req, recording().hooks);
  await sleep(200);
  offset += 15_000;
  expect((await pending).ok).toBe(true);
}, 15_000);

test("late looks give a silent worker one grace, not one per look: a stuck worker is still found", async () => {
  let offset = 0;
  const { provider, host } = setup({
    aliveLimitMs: 2_000, now: () => performance.now() + offset,
    spawn: (_spec, options) => new Worker(FAKE_WORKER, { ...options, env: { ...options.env as Record<string, string>, FAKE_MODEL_WORKER_MODE: "late" } })
  });
  const req = request(snapshot(provider.url));
  await ready(host, req.candidate);
  const pending = host.stream(req, recording().hooks);
  // This thread held past half the bound before every look, again and again.
  const holds = setInterval(() => { offset += 2_500; }, 400);
  try {
    const result = await Promise.race([pending, sleep(6_000).then(() => "still pending" as const)]);
    expect(result !== "still pending" && !result.ok && result.error instanceof ModelWorkerLostError).toBe(true);
  } finally {
    clearInterval(holds);
  }
}, 15_000);
