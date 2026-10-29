import { expect, test } from "bun:test";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { CacheSealer, type CacheSealerDeps, type SealResult, type SealSend } from "../src/server/modules/agent/cache-seal/cache-sealer.js";
import { CacheSealLedger } from "../src/server/modules/agent/cache-seal/seal-ledger.js";
import { sealMessages, systemFingerprint } from "../src/server/modules/agent/cache-seal/seal-request.js";
import { withCacheMarksFor } from "../src/server/modules/agent/replay-target.js";
import type { StepPrompt } from "../src/server/modules/agent/wake-loop.js";
import type { WakeLlmCandidate } from "../src/server/modules/agent/wake-llm-attempts.js";

// When a quiet thread is sealed, what drops a seal, and how both layers of
// the safety net reach the ledger.

const HOUR = { type: "ephemeral", ttl: "1h" } as const;
const THREAD = "thr_a";
const user = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
const reply = (text: string, calls: string[] = []): ModelMessage => ({
  role: "assistant",
  content: [{ type: "text", text }, ...calls.map((id) => ({ type: "tool-call" as const, toolCallId: id, toolName: "read", input: { path: `notes/${id}.md` } }))]
});
const result = (id: string, value: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value } }] });

const candidate = (meta: Partial<NonNullable<WakeLlmCandidate["meta"]>> = {}): WakeLlmCandidate => {
  const full = { provider: "anthropic", providerType: "openai-compatible", providerName: "provider-1", model: "anthropic/claude-sonnet-5-5", reasoningEffort: "high" as const, ...meta };
  // As the SDK names its models: the call options read the model's provider.
  return { model: { provider: full.provider === "anthropic" ? "anthropic.messages" : "openai.responses", modelId: full.model } as never, meta: full };
};
const claude = candidate();
const gpt = candidate({ provider: "openai-compatible", model: "openai/gpt-6.1-sol" });

function promptOf(history: ModelMessage[], candidates: WakeLlmCandidate[] = [claude], tools: StepPrompt["tools"] = {}, systemText = "You manage the project-1 release."): StepPrompt {
  const messagesFor = (c: WakeLlmCandidate) => withCacheMarksFor(c, history, "5m");
  return {
    tools,
    systemContent: systemText,
    system: { role: "system", content: systemText, providerOptions: { anthropic: { cacheControl: HOUR } } },
    candidates,
    messagesFor,
    messages: messagesFor(candidates[0]!),
    promptMaxSeq: history.length,
    // As a wake step's prompt says it: its first candidate wrote for five minutes.
    cacheTtlFor: (c) => (c === candidates[0] ? "5m" : "1h")
  };
}

const sealed = (writes = 53): SealResult => ({ ok: true, outputTokens: 1, cacheReadTokens: 20_000, cacheWriteTokens: writes, cacheWrite1h: writes, finishedAt: 0 });

function harness(opts: { prompt: () => StepPrompt; results?: Array<SealResult | "throw">; beforeAnswer?: () => void; idle?: CacheSealerDeps["idle"] }) {
  const clock = { t: 0 };
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const sends: SealSend[] = [];
  const results = [...(opts.results ?? [])];
  const flags = { enabled: true, sealable: true, archived: new Set<string>() };
  const ledger = new CacheSealLedger(() => clock.t);
  const sealer = new CacheSealer({
    enabled: () => flags.enabled,
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const timer = { at: clock.t + ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    stepPromptFor: async () => opts.prompt(),
    threadSealable: (threadId) => flags.sealable && !flags.archived.has(threadId),
    sendSeal: async (send) => {
      sends.push(send);
      opts.beforeAnswer?.();
      const next = results.shift() ?? sealed();
      if (next === "throw") throw new Error("socket hang up");
      return next.ok ? { ...next, finishedAt: clock.t } : next;
    },
    ledger,
    ...(opts.idle ? { idle: opts.idle } : {})
  });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (to: number) => {
    clock.t = to;
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= to) { timer.cancelled = true; timer.fn(); }
    }
    await settle();
  };
  return { clock, sends, flags, ledger, sealer, advance, settle };
}

const HISTORY = [user("Draft the notes"), reply("Reading the changelog.", ["c1"])];

test("a quiet thread is sealed 270 s after its step's call started, for its first candidate", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.clock.t = 60_000;
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  await h.advance(269_999);
  expect(h.sends).toHaveLength(0);
  await h.advance(270_000);
  expect(h.sends).toHaveLength(1);
  expect(h.sends[0]!.candidate).toBe(claude);
  expect(h.sends[0]!.messages).toEqual(sealMessages(promptOf(HISTORY).messagesFor(claude))!.messages);
});

test("a timer that fires after the step's entries have expired sends nothing", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  // The process slept: the timer runs long after it was due.
  await h.advance(600_000);
  expect(h.sends).toHaveLength(0);
});

test("another call on the thread drops the seal before anything is built", async () => {
  let built = 0;
  const h = harness({ prompt: () => { built += 1; return promptOf(HISTORY); } });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  h.sealer.noteCallStarted(THREAD);
  await h.advance(300_000);
  expect([h.sends.length, built]).toEqual([0, 0]);
});

test("a call that starts while the seal is being built drops it", async () => {
  const box: { h?: ReturnType<typeof harness> } = {};
  box.h = harness({ prompt: () => { box.h!.sealer.noteCallStarted(THREAD); return promptOf(HISTORY); } });
  const h = box.h;
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  expect(h.sends).toHaveLength(0);
});

test("no seal after a call that ran past 290 s, after a fallback served it, or for a model that does not take part", async () => {
  const cases = [
    { prompt: promptOf(HISTORY), served: claude, finishedAt: 290_001 },
    { prompt: promptOf(HISTORY, [claude, gpt]), served: gpt, finishedAt: 60_000 },
    { prompt: promptOf(HISTORY, [gpt]), served: gpt, finishedAt: 60_000 },
    { prompt: promptOf(HISTORY, [candidate({ model: "anthropic/claude-sonnet-4-5" })]), served: candidate({ model: "anthropic/claude-sonnet-4-5" }), finishedAt: 60_000 }
  ];
  for (const c of cases) {
    const h = harness({ prompt: () => c.prompt });
    h.sealer.noteStepSucceeded(THREAD, { prompt: c.prompt, served: c.served, startedAt: 0, finishedAt: c.finishedAt, cacheReadTokens: 0 });
    await h.advance(600_000);
    expect(h.sends).toHaveLength(0);
  }
});

test("switched off, archived or paused: no seal and no ledger change", async () => {
  for (const setup of ["off", "archived", "paused"] as const) {
    const h = harness({ prompt: () => promptOf(HISTORY) });
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
    if (setup === "off") h.flags.enabled = false;
    if (setup === "archived") h.flags.sealable = false;
    if (setup === "paused") h.ledger.layer1(h.ledger.startSeal("provider-1", "anthropic/claude-sonnet-5-5")!, "short_write");
    const before = h.ledger.pauses();
    await h.advance(270_000);
    expect(h.sends).toHaveLength(0);
    expect(h.ledger.pauses()).toEqual(before);
  }
});

test("a model or effort changed since the step: the seal is dropped", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY, [candidate({ reasoningEffort: "low" })]) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  expect(h.sends).toHaveLength(0);
});

test("reasoning switched off since the step: the seal is dropped; switched after it, the next step is excused", async () => {
  const off = candidate({ supportsReasoning: false });
  const h = harness({ prompt: () => promptOf(HISTORY, [off]) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  expect(h.sends).toHaveLength(0);

  const later = harness({ prompt: () => promptOf(HISTORY) });
  later.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  await later.advance(270_000);
  later.clock.t = 270_000 + 400_000;
  later.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(NEXT, [off]), served: off, startedAt: later.clock.t, finishedAt: later.clock.t + 5_000, cacheReadTokens: 0 });
  await later.settle();
  expect(later.sealer.pauses()).toEqual([]);
});

test("layer 1 is judged when the seal returns", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY), results: [{ ok: true, outputTokens: 1, cacheReadTokens: 20_000, cacheWriteTokens: 53, cacheWrite1h: 0, finishedAt: 0 }] });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  expect(h.sealer.pauses().map((p) => p.failure)).toEqual(["short_write"]);
  expect(h.sealer.shortMarksFor(claude)).toBe(false);
});

test("a failed seal request is not a failure of sealing until the third in a row", async () => {
  const failed: SealResult = { ok: false, error: new Error("The operation timed out.") };
  const h = harness({ prompt: () => promptOf(HISTORY), results: [failed, failed, failed] });
  for (let i = 0; i < 3; i++) {
    const start = i * 1_000_000;
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: start, finishedAt: start + 1_000, cacheReadTokens: 0 });
    await h.advance(start + 270_000);
    expect(h.sealer.pauses().map((p) => p.failure)).toEqual(i < 2 ? [] : ["errors"]);
  }
  expect(h.sends).toHaveLength(3);
});

test("switched off or archived while the seal is built: nothing is sent", async () => {
  for (const flag of ["enabled", "sealable"] as const) {
    const box: { h?: ReturnType<typeof harness> } = {};
    box.h = harness({ prompt: () => { box.h!.flags[flag] = false; return promptOf(HISTORY); } });
    const h = box.h;
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
    await h.advance(270_000);
    expect([h.sends.length, h.ledger.pauses()]).toEqual([0, []]);
  }
});

test("a seal request that throws is a failed request", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY), results: ["throw", "throw", "throw"] });
  for (let i = 0; i < 3; i++) {
    const start = i * 1_000_000;
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: start, finishedAt: start + 1_000, cacheReadTokens: 0 });
    await h.advance(start + 270_000);
  }
  expect(h.sealer.pauses().map((p) => p.failure)).toEqual(["errors"]);
});

const NEXT = [...HISTORY, result("c1", "the changelog"), user("[Runtime context] 15:04")];

test("a step its first candidate did not answer is excused, even when the sealed model answered it", async () => {
  const kilo = candidate({ providerName: "kilo", model: "anthropic/claude-sonnet-5.5" });
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  h.clock.t = 270_000 + 400_000;
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(NEXT, [kilo, claude]), served: claude, startedAt: h.clock.t, finishedAt: h.clock.t + 5_000, cacheReadTokens: 0 });
  await h.settle();
  expect(h.sealer.pauses()).toEqual([]);
});

test("a refreshed system instruction excuses the next step", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  h.clock.t = 270_000 + 400_000;
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(NEXT, [claude], {}, "You manage the project-1 release, today's rules."), served: claude, startedAt: h.clock.t, finishedAt: h.clock.t + 5_000, cacheReadTokens: 0 });
  await h.settle();
  expect(h.sealer.pauses()).toEqual([]);
});

// What happens while the seal's request is out: a step of the thread, or a
// compaction, is after the seal in time but not the step it is judged by.
test("a step or a compaction while the seal is out: the seal is not judged by a later step", async () => {
  for (const meanwhile of ["step", "compaction"] as const) {
    const box: { h?: ReturnType<typeof harness> } = {};
    box.h = harness({
      prompt: () => promptOf(HISTORY),
      beforeAnswer: () => {
        const h = box.h!;
        if (meanwhile === "step") {
          h.sealer.noteCallStarted(THREAD);
          h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(NEXT), served: claude, startedAt: h.clock.t, finishedAt: h.clock.t + 1_000, cacheReadTokens: 20_000 });
        } else {
          h.sealer.noteCallStarted(THREAD);
          h.sealer.noteCompacted(THREAD);
        }
      }
    });
    const h = box.h;
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
    await h.advance(270_000);
    expect(h.sends).toHaveLength(1);
    // A later step whose prefix is not the sealed one (a summary first): not judged against the seal.
    h.clock.t = 270_000 + 400_000;
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf([user("Summary of earlier work"), ...NEXT.slice(1)]), served: claude, startedAt: h.clock.t, finishedAt: h.clock.t + 5_000, cacheReadTokens: 0 });
    await h.settle();
    expect(h.sealer.pauses()).toEqual([]);
  }
});

test("a change in the tools offered excuses the next step", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  h.clock.t = 270_000 + 400_000;
  const withSearch = { web_search: tool({ description: "Searches the web.", inputSchema: z.object({ query: z.string() }) }) };
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(NEXT, [claude], withSearch), served: claude, startedAt: h.clock.t, finishedAt: h.clock.t + 5_000, cacheReadTokens: 0 });
  await h.settle();
  expect(h.sealer.pauses()).toEqual([]);
});

test("layer 2 at the next step: same prefix passes; another prefix fails; a compaction excuses", async () => {
  for (const variant of ["same", "changed", "compacted"] as const) {
    const h = harness({ prompt: () => promptOf(HISTORY) });
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
    await h.advance(270_000);
    expect(h.sends).toHaveLength(1);
    const next = variant === "same" ? NEXT : [user("Summary of earlier work"), ...NEXT.slice(1)];
    if (variant === "compacted") h.sealer.noteCompacted(THREAD);
    h.clock.t = 330_000;
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(next), served: claude, startedAt: 330_000, finishedAt: 340_000, cacheReadTokens: 20_000 });
    await h.settle();
    expect(h.sealer.pauses().map((p) => p.failure)).toEqual(variant === "changed" ? ["prefix_changed"] : []);
    expect(h.sealer.shortMarksFor(claude)).toBe(variant !== "changed");
  }
});

test("a read under 80% after a 5-60 minute pause fails layer 2", async () => {
  for (const [read, failure] of [[1_000, ["not_read"]], [16_100, []]] as const) {
    const h = harness({ prompt: () => promptOf(HISTORY) });
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
    await h.advance(270_000);
    h.clock.t = 270_000 + 400_000;
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(NEXT), served: claude, startedAt: h.clock.t, finishedAt: h.clock.t + 5_000, cacheReadTokens: read });
    await h.settle();
    expect(h.sealer.pauses().map((p) => p.failure)).toEqual([...failure]);
  }
});

test("after dispose nothing is scheduled or sent", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 60_000, cacheReadTokens: 0 });
  h.sealer.dispose();
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 1_000, finishedAt: 61_000, cacheReadTokens: 0 });
  await h.advance(600_000);
  expect(h.sends).toHaveLength(0);
});

test("shortMarksFor follows the switch, the family and the ledger", () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  expect([h.sealer.shortMarksFor(claude), h.sealer.shortMarksFor(gpt), h.sealer.shortMarksFor(candidate({ model: "anthropic/claude-sonnet-4-5" }))]).toEqual([true, false, false]);
  h.flags.enabled = false;
  expect(h.sealer.shortMarksFor(claude)).toBe(false);
  h.flags.enabled = true;
  h.ledger.layer1(h.ledger.startSeal("provider-1", "anthropic/claude-sonnet-5-5")!, "short_write");
  expect(h.sealer.shortMarksFor(claude)).toBe(false);
});

// A step whose messages were written for an hour needs no seal: its first
// candidate was not the one marked short (the primary was left out for the
// images), or its model is paused — then only a try that is due goes out.
test("a step marked for an hour gets no seal, unless it is a paused model's due try", async () => {
  const hourLong = (): StepPrompt => ({ ...promptOf(HISTORY), cacheTtlFor: () => "1h" });
  const h = harness({ prompt: hourLong });
  h.sealer.noteStepSucceeded(THREAD, { prompt: hourLong(), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  expect(h.sends).toHaveLength(0);

  const paused = harness({ prompt: hourLong });
  paused.ledger.layer1(paused.ledger.startSeal("provider-1", "anthropic/claude-sonnet-5-5")!, "short_write");
  const at = 3_600_000;
  paused.clock.t = at;
  paused.sealer.noteStepSucceeded(THREAD, { prompt: hourLong(), served: claude, startedAt: at, finishedAt: at + 10_000, cacheReadTokens: 0 });
  await paused.advance(at + 270_000);
  expect(paused.sends).toHaveLength(1);
});

// A step that did not answer (Stop, a failure) still sent its prompt with
// five-minute marks: its quiet thread is sealed as after a step that did.
test("a step that did not answer seals when the seal its call dropped was due", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  h.clock.t = 60_000;
  h.sealer.noteCallStarted(THREAD);
  h.clock.t = 70_000;
  h.sealer.noteStepFailed(THREAD, { prompt: promptOf(HISTORY), startedAt: 60_000 });
  await h.advance(269_999);
  expect(h.sends).toHaveLength(0);
  await h.advance(270_000);
  expect(h.sends).toHaveLength(1);
});

test("with no seal waiting, a step that did not answer is sealed 270 s after its own call", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.clock.t = 1_000_000;
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteStepFailed(THREAD, { prompt: promptOf(HISTORY), startedAt: 1_000_000 });
  await h.advance(1_269_999);
  expect(h.sends).toHaveLength(0);
  await h.advance(1_270_000);
  expect(h.sends).toHaveLength(1);
});

test("a step that did not answer: no seal past the dropped seal's time, for hour-long marks, or switched off", async () => {
  const late = harness({ prompt: () => promptOf(HISTORY) });
  late.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  late.clock.t = 60_000;
  late.sealer.noteCallStarted(THREAD);
  late.clock.t = 295_000;
  late.sealer.noteStepFailed(THREAD, { prompt: promptOf(HISTORY), startedAt: 60_000 });
  await late.advance(330_000);
  expect(late.sends).toHaveLength(0);

  const hourLong = harness({ prompt: () => promptOf(HISTORY) });
  hourLong.sealer.noteCallStarted(THREAD);
  hourLong.sealer.noteStepFailed(THREAD, { prompt: { ...promptOf(HISTORY), cacheTtlFor: () => "1h" }, startedAt: 0 });
  await hourLong.advance(270_000);
  expect(hourLong.sends).toHaveLength(0);

  const off = harness({ prompt: () => promptOf(HISTORY) });
  off.flags.enabled = false;
  off.sealer.noteCallStarted(THREAD);
  off.sealer.noteStepFailed(THREAD, { prompt: promptOf(HISTORY), startedAt: 0 });
  off.flags.enabled = true;
  await off.advance(270_000);
  expect(off.sends).toHaveLength(0);
});

// A compaction since the dropped seal rewrote the thread: the step after it
// sent the new prompt, so its own call times the seal.
test("after a compaction, a step that did not answer is sealed from its own call", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  h.clock.t = 60_000;
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteCompacted(THREAD);
  h.clock.t = 120_000;
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteStepFailed(THREAD, { prompt: promptOf(HISTORY), startedAt: 120_000 });
  await h.advance(270_000);
  expect(h.sends).toHaveLength(0);
  await h.advance(390_000);
  expect(h.sends).toHaveLength(1);
});

// A step that answered moved the thread on: a seal its call had dropped is
// not brought back by a later step that does not answer.
test("a dropped seal is forgotten once a step answers", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  h.clock.t = 30_000;
  h.sealer.noteCallStarted(THREAD);
  // The fallback answered: no seal of its own.
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY, [claude, gpt]), served: gpt, startedAt: 30_000, finishedAt: 40_000, cacheReadTokens: 0 });
  h.clock.t = 100_000;
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteStepFailed(THREAD, { prompt: promptOf(HISTORY), startedAt: 100_000 });
  await h.advance(270_000);
  expect(h.sends).toHaveLength(0);
  await h.advance(370_000);
  expect(h.sends).toHaveLength(1);
});

// A seal being built is waiting all the same: a step that starts then and
// does not answer keeps that seal's time.
test("a step that starts and fails while the seal is built keeps that seal's time", async () => {
  const box: { h?: ReturnType<typeof harness>; once: boolean } = { once: true };
  box.h = harness({
    prompt: () => {
      if (box.once) {
        box.once = false;
        const h = box.h!;
        h.sealer.noteCallStarted(THREAD);
        h.clock.t = 271_000;
        h.sealer.noteStepFailed(THREAD, { prompt: promptOf(HISTORY), startedAt: 271_000 });
      }
      return promptOf(HISTORY);
    }
  });
  const h = box.h;
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  await h.advance(275_000);
  expect(h.sends).toHaveLength(1);
});

// The seal a call dropped was for another model or effort: the step that did
// not answer is sealed for its own.
test("a step of another model that does not answer is sealed for itself, not by the seal it dropped", async () => {
  const low = candidate({ reasoningEffort: "low" });
  const h = harness({ prompt: () => promptOf(HISTORY, [low]) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  h.clock.t = 60_000;
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteStepFailed(THREAD, { prompt: promptOf(HISTORY, [low]), startedAt: 60_000 });
  await h.advance(270_000);
  expect(h.sends).toHaveLength(0);
  await h.advance(330_000);
  expect(h.sends.map((s) => s.candidate)).toEqual([low]);
});

// A paused model's steps write for an hour: one that does not answer adds
// nothing to seal, and a try that passed layer 1 waits for its next step.
test("a paused model's step that does not answer leaves its passed try to be judged", async () => {
  const neutral: SealResult = { ok: true, outputTokens: 1, cacheReadTokens: 20_053, cacheWriteTokens: 0, cacheWrite1h: 0, finishedAt: 0 };
  const hourLong = (history = HISTORY): StepPrompt => ({ ...promptOf(history), cacheTtlFor: () => "1h" });
  const h = harness({ prompt: () => hourLong(), results: [sealed(), neutral] });
  h.ledger.layer1(h.ledger.startSeal("provider-1", "anthropic/claude-sonnet-5-5")!, "short_write");
  const at = 3_600_000;
  h.clock.t = at;
  h.sealer.noteStepSucceeded(THREAD, { prompt: hourLong(), served: claude, startedAt: at, finishedAt: at + 10_000, cacheReadTokens: 0 });
  await h.advance(at + 270_000);
  expect(h.sends).toHaveLength(1);
  h.clock.t = at + 300_000;
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteStepFailed(THREAD, { prompt: hourLong(), startedAt: at + 300_000 });
  await h.advance(at + 570_000);
  expect(h.sends).toHaveLength(1);
  h.clock.t = at + 600_000;
  h.sealer.noteStepSucceeded(THREAD, { prompt: hourLong(NEXT), served: claude, startedAt: h.clock.t, finishedAt: h.clock.t + 5_000, cacheReadTokens: 20_000 });
  await h.settle();
  expect(h.sealer.shortMarksFor(claude)).toBe(true);
});

// A seal already sent is not dropped by a call that starts then: one that
// fails does not bring it back as a second seal.
test("a step that starts and fails while the seal is out does not send it again", async () => {
  const box: { h?: ReturnType<typeof harness> } = {};
  box.h = harness({
    prompt: () => promptOf(HISTORY),
    beforeAnswer: () => {
      const h = box.h!;
      h.sealer.noteCallStarted(THREAD);
      h.sealer.noteStepFailed(THREAD, { prompt: promptOf(HISTORY), startedAt: h.clock.t });
    }
  });
  const h = box.h;
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  await h.advance(280_000);
  expect(h.sends).toHaveLength(1);
});

// Each build of a seal is its own: an earlier build that gives up does not
// clear the mark of the one that replaced it.
test("two calls that start and fail while seals are built keep the first seal's time", async () => {
  const gates: Array<() => void> = [];
  const box: { h?: ReturnType<typeof harness>; deferring: boolean } = { deferring: true };
  const prompt = () => (box.deferring ? new Promise<StepPrompt>((resolve) => gates.push(() => resolve(promptOf(HISTORY)))) : promptOf(HISTORY));
  box.h = harness({ prompt: prompt as unknown as () => StepPrompt });
  const h = box.h;
  const failNow = (at: number) => {
    h.clock.t = at;
    h.sealer.noteCallStarted(THREAD);
    h.sealer.noteStepFailed(THREAD, { prompt: promptOf(HISTORY), startedAt: at });
  };
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  failNow(271_000);
  await h.advance(271_000);
  gates.shift()!();
  await h.settle();
  failNow(272_000);
  box.deferring = false;
  gates.shift()!();
  await h.settle();
  await h.advance(280_000);
  expect(h.sends).toHaveLength(1);
});

// A step drops a waiting seal at its start; when its work before the call
// fails, the seal goes back with its own time and deadline.
test("a step that fails before its call puts the seal it dropped back as it was", async () => {
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  h.clock.t = 60_000;
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteStepNotCalled(THREAD);
  await h.advance(269_999);
  expect(h.sends).toHaveLength(0);
  await h.advance(270_000);
  expect(h.sends).toHaveLength(1);

  const off = harness({ prompt: () => promptOf(HISTORY) });
  off.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  off.sealer.noteCallStarted(THREAD);
  off.flags.enabled = false;
  off.sealer.noteStepNotCalled(THREAD);
  off.flags.enabled = true;
  await off.advance(270_000);
  expect(off.sends).toHaveLength(0);
});

// What the sealer keeps of a thread goes once the thread is archived or
// deleted — swept at most once an hour, on a call of any thread.
test("once an hour, an archived or deleted thread is forgotten; a live one is kept", async () => {
  const OTHER = "thr_b";
  const changed = [user("Summary of earlier work"), ...NEXT.slice(1)];
  for (const archived of [true, false]) {
    const h = harness({ prompt: () => promptOf(HISTORY) });
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
    await h.advance(270_000);
    expect(h.sends).toHaveLength(1);
    if (archived) h.flags.archived.add(THREAD);
    // Within the hour no sweep; past it, a call of another thread sweeps.
    h.clock.t = 30 * 60_000;
    h.sealer.noteCallStarted(OTHER);
    h.clock.t = 270_000 + 3_600_000;
    h.sealer.noteCallStarted(OTHER);
    // Restored, the thread's next step is judged only if its seal was kept.
    h.flags.archived.delete(THREAD);
    h.clock.t += 60_000;
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(changed), served: claude, startedAt: h.clock.t, finishedAt: h.clock.t + 5_000, cacheReadTokens: 0 });
    await h.settle();
    expect(h.sealer.pauses().map((p) => p.failure)).toEqual(archived ? [] : ["prefix_changed"]);
  }
});

test("the first sweep waits an hour from the sealer's start", async () => {
  const OTHER = "thr_b";
  const changed = [user("Summary of earlier work"), ...NEXT.slice(1)];
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
  await h.advance(270_000);
  h.flags.archived.add(THREAD);
  h.clock.t = 3_000_000;
  h.sealer.noteCallStarted(OTHER);
  h.flags.archived.delete(THREAD);
  h.clock.t = 3_100_000;
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(changed), served: claude, startedAt: h.clock.t, finishedAt: h.clock.t + 5_000, cacheReadTokens: 0 });
  await h.settle();
  expect(h.sealer.pauses().map((p) => p.failure)).toEqual(["prefix_changed"]);
});

// A thread archived and restored while its seal waits keeps that seal.
test("the sweep keeps a thread whose seal is still due", async () => {
  const OTHER = "thr_b";
  // Just before the first sweep is due, so the other thread's call sweeps.
  const at = 3_590_000;
  const h = harness({ prompt: () => promptOf(HISTORY) });
  h.clock.t = at;
  // As a step does: its call is counted, then it answers.
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: at, finishedAt: at + 10_000, cacheReadTokens: 0 });
  h.flags.archived.add(THREAD);
  h.clock.t = at + 20_000;
  h.sealer.noteCallStarted(OTHER);
  h.flags.archived.delete(THREAD);
  await h.advance(at + 270_000);
  expect(h.sends).toHaveLength(1);
});

test("the sweep keeps a thread whose seal is being built", async () => {
  const OTHER = "thr_b";
  const at = 3_590_000;
  const box: { h?: ReturnType<typeof harness>; once: boolean } = { once: true };
  box.h = harness({
    prompt: () => {
      const h = box.h!;
      if (box.once) {
        box.once = false;
        h.flags.archived.add(THREAD);
        h.clock.t = at + 275_000;
        h.sealer.noteCallStarted(OTHER);
        h.flags.archived.delete(THREAD);
      }
      return promptOf(HISTORY);
    }
  });
  const h = box.h;
  h.clock.t = at;
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: at, finishedAt: at + 10_000, cacheReadTokens: 0 });
  await h.advance(at + 270_000);
  expect(h.sends).toHaveLength(1);
});

// A thread swept while its seal is out, then restored and called again, does
// not count its calls from where it began: the seal sees the call and keeps no
// record a later step is judged by.
test("a call on a thread swept and restored while its seal is out is still seen", async () => {
  const OTHER = "thr_b";
  const at = 3_590_000;
  const changed = [user("Summary of earlier work"), ...NEXT.slice(1)];
  const box: { h?: ReturnType<typeof harness> } = {};
  box.h = harness({
    prompt: () => promptOf(HISTORY),
    beforeAnswer: () => {
      const h = box.h!;
      h.flags.archived.add(THREAD);
      h.sealer.noteCallStarted(OTHER);
      h.flags.archived.delete(THREAD);
      // A compaction of the restored thread starts and ends while the seal is out.
      h.sealer.noteCallStarted(THREAD);
      h.sealer.noteCompacted(THREAD);
    }
  });
  const h = box.h;
  h.clock.t = at;
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: at, finishedAt: at + 10_000, cacheReadTokens: 0 });
  await h.advance(at + 270_000);
  expect(h.sends).toHaveLength(1);
  h.clock.t = at + 600_000;
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(changed), served: claude, startedAt: h.clock.t, finishedAt: h.clock.t + 5_000, cacheReadTokens: 0 });
  await h.settle();
  expect(h.sealer.pauses()).toEqual([]);
});

// Idle compaction: the sealer tells the idle clock of every call, every step
// and every seal that wrote for an hour, with the seal's start.
test("the sealer tells the idle clock: calls, steps, and a seal that wrote for an hour", async () => {
  const told: string[] = [];
  const seals: Array<{ startedAt: number; candidate: WakeLlmCandidate; systemFingerprint: string }> = [];
  const idle: NonNullable<CacheSealerDeps["idle"]> = {
    noteCallStarted: (threadId) => { told.push(`call ${threadId}`); },
    noteStep: (_threadId, s) => { told.push(`step ${s.cacheWriteTokens ?? "-"}/${s.cacheWrite1hTokens ?? "-"}`); },
    noteSeal: (_threadId, s) => { told.push("seal"); seals.push(s); }
  };
  const h = harness({ prompt: () => promptOf(HISTORY), idle });
  h.sealer.noteCallStarted(THREAD);
  h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0, cacheWriteTokens: 300, cacheWrite1hTokens: 0 });
  await h.advance(270_000);
  expect(told).toEqual([`call ${THREAD}`, "step 300/0", "seal"]);
  expect(seals[0]).toMatchObject({ startedAt: 270_000, candidate: claude, systemFingerprint: systemFingerprint(promptOf(HISTORY).system) });
});

test("a seal that wrote for five minutes, or nothing, is not told to the idle clock", async () => {
  for (const write1h of [0, undefined]) {
    const told: string[] = [];
    const idle: NonNullable<CacheSealerDeps["idle"]> = { noteCallStarted: () => {}, noteStep: () => {}, noteSeal: () => { told.push("seal"); } };
    const writes = write1h === 0 ? 53 : 0;
    const h = harness({ prompt: () => promptOf(HISTORY), idle, results: [{ ok: true, outputTokens: 1, cacheReadTokens: 20_000, cacheWriteTokens: writes, cacheWrite1h: write1h, finishedAt: 0 }] });
    h.sealer.noteStepSucceeded(THREAD, { prompt: promptOf(HISTORY), served: claude, startedAt: 0, finishedAt: 10_000, cacheReadTokens: 0 });
    await h.advance(270_000);
    expect([write1h, told]).toEqual([write1h, []]);
  }
});
