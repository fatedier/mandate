import { expect, test } from "bun:test";
import { jsonSchema, tool, type JSONSchema7, type ModelMessage } from "ai";
import { z } from "zod";
import { idleCacheLifetimeMinutes, isCompactableThread } from "../src/server/modules/agent/idle-compaction/cache-lifetime.js";
import { IdleCompactor } from "../src/server/modules/agent/idle-compaction/idle-compactor.js";
import type { IdleCompactOptions } from "../src/server/modules/agent/idle-compaction/types.js";
import { systemFingerprint, toolSetFingerprint } from "../src/server/modules/agent/cache-seal/seal-request.js";
import type { SealStep } from "../src/server/modules/agent/cache-seal/cache-sealer.js";
import type { StepPrompt } from "../src/server/modules/agent/wake-loop.js";
import type { WakeLlmCandidate } from "../src/server/modules/agent/wake-llm-attempts.js";

// The idle clock: armed by a call that kept the thread's cache, it fires a
// few minutes before that cache expires and asks for a compaction on the warm
// model, unless anything changed since.

const MIN = 60_000;
const THREAD = "thr_a";
const candidate = (meta: Partial<NonNullable<WakeLlmCandidate["meta"]>>): WakeLlmCandidate =>
  ({ model: { provider: "mock", modelId: meta.model ?? "m" } as never, meta: { providerName: "provider-1", reasoningEffort: "high", ...meta } });
const claude = candidate({ provider: "anthropic", model: "anthropic/claude-sonnet-5-5" });
const claudeLow = candidate({ provider: "anthropic", model: "anthropic/claude-sonnet-5-5", reasoningEffort: "low" });
const gpt = candidate({ provider: "openai-compatible", model: "openai/gpt-6.1-sol" });
const deepseek = candidate({ provider: "openai-compatible", model: "deepseek/deepseek-v4-flash" });
const history: ModelMessage[] = [{ role: "user", content: "Draft the 3.22 notes" }];

function promptOf(candidates: WakeLlmCandidate[], opts: { ttl?: "5m" | "1h"; system?: string; tools?: StepPrompt["tools"] } = {}): StepPrompt {
  return {
    tools: opts.tools ?? {}, systemContent: opts.system ?? "You manage the project-1 release.", system: opts.system ?? "You manage the project-1 release.",
    candidates, messagesFor: () => history, messages: history, promptMaxSeq: 1,
    cacheTtlFor: (c) => (c === candidates[0] ? opts.ttl ?? "5m" : "1h")
  };
}
const step = (prompt: StepPrompt, served: WakeLlmCandidate, at: number, counts: Partial<Pick<SealStep, "cacheReadTokens" | "cacheWriteTokens" | "cacheWrite1hTokens">>): SealStep =>
  ({ prompt, served, startedAt: at, finishedAt: at + 10_000, cacheReadTokens: 0, ...counts });

function harness(opts: { prompt?: () => StepPrompt; typed?: (c: WakeLlmCandidate) => number | undefined; lead?: number } = {}) {
  const clock = { t: 0 };
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const compacted: Array<{ threadId: string; opts: IdleCompactOptions }> = [];
  const flags = { enabled: true, compactable: true, alarm: false };
  const box: { idle?: IdleCompactor } = {};
  const idle = new IdleCompactor({
    settings: () => ({ enabled: flags.enabled, leadMinutes: opts.lead ?? 5, minTokens: 200_000 }),
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const timer = { at: clock.t + ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    typedLifetime: opts.typed ?? (() => undefined),
    stepPromptFor: async () => (opts.prompt ?? (() => promptOf([claude], { ttl: "5m" })))(),
    threadCompactable: () => flags.compactable,
    alarmDueBy: () => flags.alarm,
    compact: (threadId, o) => { compacted.push({ threadId, opts: o }); return "started"; }
  });
  box.idle = idle;
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const pending = () => timers.filter((t) => !t.cancelled);
  const advance = async (to: number) => {
    clock.t = to;
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= to) { timer.cancelled = true; timer.fn(); }
    }
    await settle();
  };
  /** A seal of `c` that wrote for an hour, as the sealer tells it. */
  const seal = async (c: WakeLlmCandidate, startedAt: number, prompt = promptOf([c])) => {
    idle.noteSeal(THREAD, { candidate: c, startedAt, systemFingerprint: systemFingerprint(prompt.system), toolsFingerprint: await toolSetFingerprint(prompt.tools) });
  };
  return { idle, clock, timers, pending, compacted, flags, advance, settle, seal };
}

test("lifetimes by family: Claude 60 at most, GPT 30, any other off unless typed", () => {
  expect([undefined, 30, 90, 0].map((typed) => idleCacheLifetimeMinutes(claude.meta, typed))).toEqual([60, 30, 60, 0]);
  expect([undefined, 45, 0].map((typed) => idleCacheLifetimeMinutes(gpt.meta, typed))).toEqual([30, 45, 0]);
  expect(idleCacheLifetimeMinutes({ provider: "openai", model: "gpt-5.5" }, undefined)).toBe(30);
  expect([undefined, 45].map((typed) => idleCacheLifetimeMinutes(deepseek.meta, typed))).toEqual([0, 45]);
  // A ChatGPT sign-in's models and a Kilo model on Chat are not among the two GPT cases.
  expect([idleCacheLifetimeMinutes({ provider: "codex", model: "gpt-5.6-sol" }, undefined), idleCacheLifetimeMinutes({ provider: "kilo", model: "openai/gpt-6.1-sol" }, undefined)]).toEqual([0, 0]);
});

test("a thread is compactable unless gone, archived, or a retired worker", () => {
  expect(isCompactableThread(null, false)).toBe(false);
  expect(isCompactableThread({ archivedAt: "2026-01-01T00:00:00.000Z", scope: "manager" }, false)).toBe(false);
  expect(isCompactableThread({ archivedAt: null, scope: "worker" }, true)).toBe(false);
  expect(isCompactableThread({ archivedAt: null, scope: "worker" }, false)).toBe(true);
  expect(isCompactableThread({ archivedAt: null, scope: "manager" }, false)).toBe(true);
});

test("a seal that wrote for an hour arms the clock 55 minutes after it started", async () => {
  const h = harness();
  await h.seal(claude, 270_000);
  expect(h.pending().map((t) => t.at)).toEqual([270_000 + 55 * MIN]);
  await h.advance(270_000 + 55 * MIN - 1);
  expect(h.compacted).toHaveLength(0);
  await h.advance(270_000 + 55 * MIN);
  expect(h.compacted).toHaveLength(1);
  const { opts } = h.compacted[0]!;
  expect([opts.idleMinutes, opts.minTokens, opts.only(claude), opts.only(claudeLow)]).toEqual([55, 200_000, true, false]);
});

test("a Claude step with hour-long marks and an hour-long write arms it; five-minute marks or no hour write do not", async () => {
  const cases: Array<[ttl: "5m" | "1h", write1h: number, arms: boolean]> = [["1h", 500, true], ["5m", 0, false], ["5m", 500, false], ["1h", 0, false]];
  for (const [ttl, write1h, arms] of cases) {
    const h = harness();
    h.idle.noteStep(THREAD, step(promptOf([claude], { ttl }), claude, 0, { cacheWriteTokens: 500, cacheWrite1hTokens: write1h }));
    await h.settle();
    expect([ttl, write1h, h.pending().map((t) => t.at)]).toEqual([ttl, write1h, arms ? [55 * MIN] : []]);
  }
});

test("a GPT step that read the cache arms it at 25 minutes; one that read and wrote nothing does not", async () => {
  const read = harness();
  read.idle.noteStep(THREAD, step(promptOf([gpt]), gpt, 0, { cacheReadTokens: 180_000 }));
  await read.settle();
  expect(read.pending().map((t) => t.at)).toEqual([25 * MIN]);
  const none = harness();
  none.idle.noteStep(THREAD, step(promptOf([gpt]), gpt, 0, {}));
  await none.settle();
  expect(none.pending()).toHaveLength(0);
});

test("only the step's leading model arms it", async () => {
  const h = harness();
  h.idle.noteStep(THREAD, step(promptOf([claude, gpt]), gpt, 0, { cacheReadTokens: 180_000 }));
  await h.settle();
  expect(h.pending()).toHaveLength(0);
});

test("a model off by default or typed 0 never arms; a typed lifetime arms at lifetime − lead", async () => {
  const off = harness();
  off.idle.noteStep(THREAD, step(promptOf([deepseek]), deepseek, 0, { cacheReadTokens: 180_000 }));
  const zero = harness({ typed: () => 0 });
  zero.idle.noteStep(THREAD, step(promptOf([gpt]), gpt, 0, { cacheReadTokens: 180_000 }));
  const typed = harness({ typed: () => 45 });
  typed.idle.noteStep(THREAD, step(promptOf([deepseek]), deepseek, 0, { cacheReadTokens: 180_000 }));
  await Promise.all([off.settle(), zero.settle(), typed.settle()]);
  expect([off.pending().length, zero.pending().length, typed.pending().map((t) => t.at)]).toEqual([0, 0, [40 * MIN]]);
});

test("a lifetime not longer than the lead never arms", async () => {
  const five = harness({ typed: () => 5 });
  five.idle.noteStep(THREAD, step(promptOf([gpt]), gpt, 0, { cacheReadTokens: 180_000 }));
  const lead59 = harness({ lead: 59 });
  lead59.idle.noteStep(THREAD, step(promptOf([gpt]), gpt, 0, { cacheReadTokens: 180_000 }));
  await Promise.all([five.settle(), lead59.settle()]);
  expect([five.pending().length, lead59.pending().length]).toEqual([0, 0]);
});

test("any call on the thread drops the clock", async () => {
  const h = harness();
  await h.seal(claude, 0);
  h.idle.noteCallStarted(THREAD);
  await h.advance(55 * MIN);
  expect(h.compacted).toHaveLength(0);
});

test("it gives up when switched off, the thread is gone, an alarm is due, or the model, effort, system or tools changed", async () => {
  const search = { web_search: tool({ description: "Searches the web.", inputSchema: z.object({ query: z.string() }) }) };
  const variants: Array<[string, (h: ReturnType<typeof harness>) => void, (() => StepPrompt) | undefined]> = [
    ["control", () => {}, undefined],
    ["off", (h) => { h.flags.enabled = false; }, undefined],
    ["gone", (h) => { h.flags.compactable = false; }, undefined],
    ["alarm", (h) => { h.flags.alarm = true; }, undefined],
    ["effort", () => {}, () => promptOf([claudeLow])],
    ["model", () => {}, () => promptOf([gpt])],
    ["system", () => {}, () => promptOf([claude], { system: "You manage the project-2 release." })],
    ["tools", () => {}, () => promptOf([claude], { tools: search })]
  ];
  for (const [name, change, prompt] of variants) {
    const h = harness(prompt ? { prompt } : {});
    await h.seal(claude, 0);
    change(h);
    await h.advance(55 * MIN);
    expect([name, h.compacted.length]).toEqual([name, name === "control" ? 1 : 0]);
  }
});

test("a call while the prompt is built drops it", async () => {
  const box: { h?: ReturnType<typeof harness> } = {};
  box.h = harness({ prompt: () => { box.h!.idle.noteCallStarted(THREAD); return promptOf([claude]); } });
  await box.h.seal(claude, 0);
  await box.h.advance(55 * MIN);
  expect(box.h.compacted).toHaveLength(0);
});

test("dispose cancels every clock", async () => {
  const h = harness();
  await h.seal(claude, 0);
  h.idle.dispose();
  await h.advance(55 * MIN);
  expect([h.pending().length, h.compacted.length]).toEqual([0, 0]);
});

test("a call before a step's clock is armed drops it", async () => {
  const h = harness();
  h.idle.noteStep(THREAD, step(promptOf([claude], { ttl: "1h" }), claude, 0, { cacheWriteTokens: 500, cacheWrite1hTokens: 500 }));
  h.idle.noteCallStarted(THREAD);
  await h.settle();
  expect(h.pending()).toHaveLength(0);
});

// The checks hold right up to the compaction.
test("a timer that runs past the cache's expiry does nothing", async () => {
  const h = harness();
  await h.seal(claude, 0);
  await h.advance(61 * MIN);
  expect(h.compacted).toHaveLength(0);
});

test("switched off or the thread archived while the prompt is built: nothing", async () => {
  for (const flag of ["enabled", "compactable"] as const) {
    const box: { h?: ReturnType<typeof harness> } = {};
    box.h = harness({ prompt: () => { box.h!.flags[flag] = false; return promptOf([claude]); } });
    await box.h.seal(claude, 0);
    await box.h.advance(55 * MIN);
    expect([flag, box.h.compacted.length]).toEqual([flag, 0]);
  }
});

test("a model turned off after its clock was armed is not compacted", async () => {
  const typed = { value: undefined as number | undefined };
  const h = harness({ typed: () => typed.value });
  await h.seal(claude, 0);
  typed.value = 0;
  await h.advance(55 * MIN);
  expect(h.compacted).toHaveLength(0);
});

// The model's lifetime as it is now bounds the cache too, and a step whose
// tools cannot be fingerprinted leaves nothing behind.
test("a GPT lifetime shortened after its clock was armed ends the cache sooner: nothing", async () => {
  const typed = { value: undefined as number | undefined };
  const h = harness({ typed: () => typed.value, prompt: () => promptOf([gpt]) });
  h.idle.noteStep(THREAD, step(promptOf([gpt]), gpt, 0, { cacheReadTokens: 180_000 }));
  await h.settle();
  typed.value = 10;
  await h.advance(25 * MIN);
  expect(h.compacted).toHaveLength(0);
});

test("a lifetime lengthened after arming does not stretch the cache: a late timer does nothing", async () => {
  const typed = { value: undefined as number | undefined };
  const h = harness({ typed: () => typed.value, prompt: () => promptOf([gpt]) });
  h.idle.noteStep(THREAD, step(promptOf([gpt]), gpt, 0, { cacheReadTokens: 180_000 }));
  await h.settle();
  typed.value = 120;
  await h.advance(31 * MIN);
  expect(h.compacted).toHaveLength(0);
});

test("a step whose tools cannot be fingerprinted keeps nothing of the thread", async () => {
  const h = harness();
  const broken = { get description(): string { throw new Error("tool description unreadable"); } } as unknown as StepPrompt["tools"][string];
  h.idle.noteStep(THREAD, step(promptOf([claude], { ttl: "1h", tools: { broken } }), claude, 0, { cacheWriteTokens: 500, cacheWrite1hTokens: 500 }));
  await h.settle();
  const kept = h.idle as unknown as { armed: Map<string, unknown>; arming: Map<string, unknown>; firing: Map<string, unknown> };
  expect([kept.armed.size, kept.arming.size, kept.firing.size]).toEqual([0, 0, 0]);
});

test("an older step's failed fingerprint leaves the newer step's clock to arm", async () => {
  const h = harness();
  const broken = { get description(): string { throw new Error("tool description unreadable"); } } as unknown as StepPrompt["tools"][string];
  h.idle.noteStep(THREAD, step(promptOf([claude], { ttl: "1h", tools: { broken } }), claude, 0, { cacheWriteTokens: 500, cacheWrite1hTokens: 500 }));
  h.idle.noteCallStarted(THREAD);
  // The newer step's tools take a while to read, so the older step fails first.
  const schema = Promise.withResolvers<JSONSchema7>();
  const read = tool({ description: "Read a file", inputSchema: jsonSchema(schema.promise) });
  h.idle.noteStep(THREAD, step(promptOf([claude], { ttl: "1h", tools: { read } }), claude, MIN, { cacheWriteTokens: 500, cacheWrite1hTokens: 500 }));
  await h.settle();
  schema.resolve({ type: "object", properties: { path: { type: "string" } } });
  await h.settle();
  expect(h.pending().map((t) => t.at)).toEqual([56 * MIN]);
});
