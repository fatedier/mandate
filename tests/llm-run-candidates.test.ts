import { describe, expect, test } from "bun:test";
import {
  llmAttemptMetadata,
  runLlmCandidates,
  type LlmAttempt
} from "../src/server/modules/llm/run-candidates.js";
import { decideLlmFailure, LLM_ATTEMPTS_PER_CANDIDATE } from "../src/server/modules/llm/retry-policy.js";

const overloaded = () => Object.assign(new Error("Overloaded"), { status: 529 });
const rateLimited = () => Object.assign(new Error("Too Many Requests"), { status: 429 });
const timedOut = () => new Error("The operation timed out.");
const refused = () => new Error("This content was flagged for possible cybersecurity risk.");
const contextTooLong = () => new Error("This model's maximum context length is 200000 tokens.");

type Script = Record<string, Array<Error | string>>;

/** Runs the candidates against a per-candidate script: an Error entry fails that
 *  attempt, a string entry succeeds with that value. Returns the value (or the
 *  thrown error) plus every attempt in order, so a test can assert the path. */
async function run(
  script: Script,
  options: {
    onFailure?: Parameters<typeof runLlmCandidates<string, string>>[0]["onFailure"];
    signal?: AbortSignal;
    /** Runs inside the retry wait, after it is recorded. */
    duringWait?: () => void;
  } = {}
) {
  const calls: string[] = [];
  const waits: number[] = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  let value: string | undefined;
  let error: unknown;
  try {
    value = await runLlmCandidates<string, string>({
      candidates: Object.keys(script),
      attempt: async (candidate, at) => {
        calls.push(`${candidate}#${at.attempt}`);
        const next = queues[candidate]!.shift();
        if (next === undefined) throw new Error(`script for ${candidate} ran out`);
        if (next instanceof Error) throw next;
        return next;
      },
      onFailure: options.onFailure,
      signal: options.signal,
      wait: async (ms) => { waits.push(ms); options.duringWait?.(); }
    });
  } catch (err) {
    error = err;
  }
  return { value, error, calls, waits };
}

describe("runLlmCandidates — the shared policy", () => {
  test("a first attempt that succeeds is the only call", async () => {
    const r = await run({ primary: ["ok"], backup: ["unused"] });
    expect(r.value).toBe("ok");
    expect(r.calls).toEqual(["primary#1"]);
  });

  test("a retryable failure is retried once on the same model before any fallback", async () => {
    const r = await run({ primary: [overloaded(), "primary ok"], backup: ["backup ok"] });
    expect(r.value).toBe("primary ok");
    expect(r.calls).toEqual(["primary#1", "primary#2"]);
  });

  test("a rate limit is retried on the same model too", async () => {
    const r = await run({ primary: [rateLimited(), "primary ok"], backup: ["backup ok"] });
    expect(r.calls).toEqual(["primary#1", "primary#2"]);
  });

  test("after the same-model retry also fails, it moves to the fallback", async () => {
    const r = await run({ primary: [overloaded(), overloaded()], backup: ["backup ok"] });
    expect(r.value).toBe("backup ok");
    expect(r.calls).toEqual(["primary#1", "primary#2", "backup#1"]);
  });

  test("a timeout goes straight to the fallback — the failed attempt already waited", async () => {
    const r = await run({ primary: [timedOut()], backup: ["backup ok"] });
    expect(r.value).toBe("backup ok");
    expect(r.calls).toEqual(["primary#1", "backup#1"]);
  });

  test("a content refusal goes straight to the fallback — the same bytes get the same answer", async () => {
    const r = await run({ primary: [refused()], backup: ["backup ok"] });
    expect(r.value).toBe("backup ok");
    expect(r.calls).toEqual(["primary#1", "backup#1"]);
  });

  test("a request the next model would reject too ends the run without falling back", async () => {
    const error = contextTooLong();
    const r = await run({ primary: [error], backup: ["unused"] });
    expect(r.error).toBe(error);
    expect(r.calls).toEqual(["primary#1"]);
  });

  test("with no fallback, a retryable failure still gets its one retry, then throws the last error", async () => {
    const last = overloaded();
    const r = await run({ only: [overloaded(), last] });
    expect(r.error).toBe(last);
    expect(r.calls).toEqual(["only#1", "only#2"]);
  });

  test("the last candidate's error is thrown as is, not wrapped", async () => {
    const last = timedOut();
    const r = await run({ primary: [timedOut()], backup: [last] });
    expect(r.error).toBe(last);
    expect(r.calls).toEqual(["primary#1", "backup#1"]);
  });

  test("the retry waits the shared backoff before trying again", async () => {
    const r = await run({ primary: [overloaded(), "ok"] });
    expect(r.waits).toHaveLength(1);
    expect(r.waits[0]).toBeGreaterThanOrEqual(250);
    expect(r.waits[0]).toBeLessThan(500);
  });

  test("a fallback does not wait", async () => {
    const r = await run({ primary: [timedOut()], backup: ["ok"] });
    expect(r.waits).toEqual([]);
  });
});

describe("runLlmCandidates — caller hooks", () => {
  test("onFailure can turn a retry into a fallback", async () => {
    const r = await run(
      { primary: [overloaded()], backup: ["backup ok"] },
      { onFailure: (f) => (f.decision === "retry" ? "fallback" : undefined) }
    );
    expect(r.value).toBe("backup ok");
    expect(r.calls).toEqual(["primary#1", "backup#1"]);
  });

  test("onFailure sees the policy's decision and whether a fallback is allowed", async () => {
    const seen: Array<[string, boolean]> = [];
    await run(
      { primary: [overloaded(), contextTooLong()], backup: ["unused"] },
      { onFailure: (f) => { seen.push([f.decision, f.canFallback]); } }
    );
    expect(seen).toEqual([["retry", true], ["throw", false]]);
  });

  test("onFailure can end the run", async () => {
    const error = overloaded();
    const r = await run(
      { primary: [error], backup: ["unused"] },
      { onFailure: () => "throw" }
    );
    expect(r.error).toBe(error);
    expect(r.calls).toEqual(["primary#1"]);
  });

  test("an error thrown by onFailure replaces the attempt's error", async () => {
    const replacement = new Error("replaced");
    const r = await run(
      { primary: [overloaded()], backup: ["unused"] },
      { onFailure: () => { throw replacement; } }
    );
    expect(r.error).toBe(replacement);
  });

  test("onFailure cannot buy a third attempt on the same model", async () => {
    const r = await run(
      { primary: [overloaded(), overloaded(), "never"], backup: ["backup ok"] },
      { onFailure: () => "retry" }
    );
    expect(r.value).toBe("backup ok");
    expect(r.calls).toEqual(["primary#1", "primary#2", "backup#1"]);
  });

  test("a fallback asked for with nothing left to fall back to ends the run with that error", async () => {
    const first = overloaded();
    const r = await run({ only: [first, "never"] }, { onFailure: () => "fallback" });
    expect(r.error).toBe(first);
    expect(r.calls).toEqual(["only#1"]);
  });

  test("once the signal is aborted, a failure neither retries nor falls back", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = overloaded();
    const r = await run(
      { primary: [error], backup: ["unused"] },
      {
        signal: controller.signal,
        onFailure: () => { throw new Error("onFailure must not run after abort"); }
      }
    );
    // The attempt owns turning an abort into its own error type; the runner
    // only guarantees nothing else is tried once the signal has fired.
    expect(r.error).toBe(error);
    expect(r.calls).toEqual(["primary#1"]);
  });
});

describe("runLlmCandidates — cancellation during the retry wait", () => {
  test("an abort that lands while waiting to retry ends the run before the retry", async () => {
    const controller = new AbortController();
    const error = overloaded();
    const r = await run(
      { primary: [error, "must not be reached"], backup: ["unused"] },
      { signal: controller.signal, duringWait: () => controller.abort() }
    );
    expect(r.waits).toHaveLength(1);
    expect(r.calls).toEqual(["primary#1"]);
    expect(r.error).toBe(error);
  });
});

describe("decideLlmFailure", () => {
  const at = (attempt: number, hasNext: boolean): LlmAttempt => ({ candidateIndex: 0, attempt, hasNext });

  test("one retry per candidate, with or without a fallback", () => {
    expect(LLM_ATTEMPTS_PER_CANDIDATE).toBe(2);
    expect(decideLlmFailure(overloaded(), at(1, true)).decision).toBe("retry");
    expect(decideLlmFailure(overloaded(), at(1, false)).decision).toBe("retry");
    expect(decideLlmFailure(overloaded(), at(2, true)).decision).toBe("fallback");
    expect(decideLlmFailure(overloaded(), at(2, false)).decision).toBe("throw");
  });

  test("a timeout and a refusal skip the retry but may fall back", () => {
    expect(decideLlmFailure(timedOut(), at(1, true))).toEqual({ decision: "fallback", canFallback: true });
    expect(decideLlmFailure(refused(), at(1, true))).toEqual({ decision: "fallback", canFallback: true });
  });

  test("a request-shape error may not fall back", () => {
    expect(decideLlmFailure(contextTooLong(), at(1, true))).toEqual({ decision: "throw", canFallback: false });
  });

  test("a request-shape error behind a gateway's 500 is not retried either", () => {
    // litellm stamps every upstream failure 500, which alone reads as
    // retryable; the same bytes would be rejected the same way.
    const wrapped = Object.assign(contextTooLong(), { status: 500 });
    expect(decideLlmFailure(wrapped, at(1, true))).toEqual({ decision: "throw", canFallback: false });
    expect(decideLlmFailure(wrapped, at(1, false))).toEqual({ decision: "throw", canFallback: false });
  });
});

describe("llmAttemptMetadata", () => {
  const fields = { provider: "codex", model: "gpt-5.5" };

  test("the first candidate's first attempt adds nothing", () => {
    expect(llmAttemptMetadata({ candidateIndex: 0, attempt: 1, hasNext: true }, fields)).toEqual({});
  });

  test("a same-model retry is marked as a retry, not a fallback", () => {
    // The Activity summary groups on the truthiness of fallbackAttempt; a retry
    // of the primary model is still a primary call.
    expect(llmAttemptMetadata({ candidateIndex: 0, attempt: 2, hasNext: true }, fields)).toEqual({
      fallbackAttempt: false,
      candidateIndex: 0,
      attempt: 2,
      provider: "codex",
      model: "gpt-5.5"
    });
  });

  test("a later candidate is a fallback", () => {
    expect(llmAttemptMetadata({ candidateIndex: 1, attempt: 1, hasNext: false }, fields)).toMatchObject({
      fallbackAttempt: true,
      candidateIndex: 1,
      attempt: 1
    });
  });
});
