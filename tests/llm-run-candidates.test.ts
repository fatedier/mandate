import { describe, expect, test } from "bun:test";
import {
  llmAttemptMetadata,
  runLlmCandidates,
  type LlmAttempt
} from "../src/server/modules/llm/run-candidates.js";
import { decideLlmFailure, LLM_ATTEMPTS_PER_CANDIDATE } from "../src/server/modules/llm/retry-policy.js";

const overloaded = () => Object.assign(new Error("Overloaded"), { status: 529 });
const timedOut = () => new Error("The operation timed out.");
const refused = () => new Error("This content was flagged for possible cybersecurity risk.");
const contextTooLong = () => new Error("This model's maximum context length is 200000 tokens.");
// As they reach the runner from a streamed call (probed through the AI SDK and
// collectStream on Bun 1.4.2 and 1.4.3): Bun's fetch error, wrapped. A failed
// lookup — what a call throws while DNS is down — keeps its message:
const unresolved = () => {
  const fetchError = Object.assign(new TypeError("getaddrinfo ENOTFOUND api.kilo.ai"), { code: "ENOTFOUND" });
  return Object.assign(new Error(fetchError.message), { cause: fetchError });
};
// No route, as Bun 1.4.3 says it: the connect's errno, then Bun's sentence.
// (1.4.2 said only the sentence, with the code FailedToOpenSocket two causes
// down; tests/llm-retry-policy.test.ts keeps that shape.)
const noRoute = () => {
  const fetchError = Object.assign(new TypeError("EHOSTUNREACH: Was there a typo in the url or port?"), { code: "EHOSTUNREACH" });
  return Object.assign(new Error(fetchError.message), { cause: fetchError });
};

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
  // Each script's path: the value the run returns and every attempt it made.
  const paths: { name: string; script: Script; value: string; calls: string[] }[] = [
    { name: "a first attempt that succeeds is the only call",
      script: { primary: ["ok"], backup: ["unused"] }, value: "ok", calls: ["primary#1"] },
    { name: "a retryable failure is retried once on the same model before any fallback",
      script: { primary: [overloaded(), "primary ok"], backup: ["backup ok"] }, value: "primary ok", calls: ["primary#1", "primary#2"] },
    { name: "after the same-model retry also fails, it moves to the fallback",
      script: { primary: [overloaded(), overloaded()], backup: ["backup ok"] }, value: "backup ok", calls: ["primary#1", "primary#2", "backup#1"] },
    { name: "a timeout goes straight to the fallback — the failed attempt already waited",
      script: { primary: [timedOut()], backup: ["backup ok"] }, value: "backup ok", calls: ["primary#1", "backup#1"] }
  ];

  test.each(paths)("$name", async ({ script, value, calls }) => {
    const r = await run(script);
    expect(r.value).toBe(value);
    expect(r.calls).toStrictEqual(calls);
  });

  test("a request the next model would reject too ends the run without falling back", async () => {
    const error = contextTooLong();
    const r = await run({ primary: [error], backup: ["unused"] });
    expect(r.error).toBe(error);
    expect(r.calls).toStrictEqual(["primary#1"]);
  });

  test("with no fallback, a retryable failure still gets its one retry, then throws the last error", async () => {
    const last = overloaded();
    const r = await run({ only: [overloaded(), last] });
    expect(r.error).toBe(last);
    expect(r.calls).toStrictEqual(["only#1", "only#2"]);
  });

  test("the retry waits the shared backoff before trying again", async () => {
    const r = await run({ primary: [overloaded(), "ok"] });
    expect(r.waits).toHaveLength(1);
    expect(r.waits[0]).toBeGreaterThanOrEqual(250);
    expect(r.waits[0]).toBeLessThan(500);
  });

  test("a fallback does not wait", async () => {
    const r = await run({ primary: [timedOut()], backup: ["ok"] });
    expect(r.waits).toStrictEqual([]);
  });
});

describe("runLlmCandidates — a provider the network cannot reach", () => {
  test("a host that does not resolve is retried three times, 2 s, 5 s and 15 s apart, before the fallback", async () => {
    const r = await run({ primary: [unresolved(), unresolved(), unresolved(), unresolved()], backup: ["backup ok"] });
    expect(r.value).toBe("backup ok");
    expect(r.calls).toStrictEqual(["primary#1", "primary#2", "primary#3", "primary#4", "backup#1"]);
    expect(r.waits).toStrictEqual([2000, 5000, 15000]);
  });

  test("a network back within the retries gets the same model's answer", async () => {
    const r = await run({ primary: [unresolved(), unresolved(), "primary ok"], backup: ["unused"] });
    expect(r.value).toBe("primary ok");
    expect(r.waits).toStrictEqual([2000, 5000]);
  });

  test("no route to the host is the same: the network, not the provider", async () => {
    const r = await run({ primary: [noRoute(), "primary ok"] });
    expect(r.value).toBe("primary ok");
    expect(r.waits).toStrictEqual([2000]);
  });

  test("with no fallback, the run throws the last error after the third retry", async () => {
    const last = unresolved();
    const r = await run({ only: [unresolved(), unresolved(), unresolved(), last] });
    expect(r.error).toBe(last);
    expect(r.calls).toStrictEqual(["only#1", "only#2", "only#3", "only#4"]);
  });

  test("an abort while waiting out the network ends the run", async () => {
    const controller = new AbortController();
    const error = unresolved();
    const r = await run(
      { primary: [error, "must not be reached"], backup: ["unused"] },
      { signal: controller.signal, duringWait: () => controller.abort() }
    );
    expect(r.waits).toStrictEqual([2000]);
    expect(r.calls).toStrictEqual(["primary#1"]);
    expect(r.error).toBe(error);
  });
});

describe("runLlmCandidates — caller hooks", () => {
  test("onFailure can turn a retry into a fallback", async () => {
    const r = await run(
      { primary: [overloaded()], backup: ["backup ok"] },
      { onFailure: (f) => (f.decision === "retry" ? "fallback" : undefined) }
    );
    expect(r.value).toBe("backup ok");
    expect(r.calls).toStrictEqual(["primary#1", "backup#1"]);
  });

  test("onFailure sees the policy's decision and whether a fallback is allowed", async () => {
    const seen: Array<[string, boolean]> = [];
    await run(
      { primary: [overloaded(), contextTooLong()], backup: ["unused"] },
      { onFailure: (f) => { seen.push([f.decision, f.canFallback]); } }
    );
    expect(seen).toStrictEqual([["retry", true], ["throw", false]]);
  });

  test("onFailure can end the run", async () => {
    const error = overloaded();
    const r = await run(
      { primary: [error], backup: ["unused"] },
      { onFailure: () => "throw" }
    );
    expect(r.error).toBe(error);
    expect(r.calls).toStrictEqual(["primary#1"]);
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
    expect(r.calls).toStrictEqual(["primary#1", "primary#2", "backup#1"]);
  });

  test("a fallback asked for with nothing left to fall back to ends the run with that error", async () => {
    const first = overloaded();
    const r = await run({ only: [first, "never"] }, { onFailure: () => "fallback" });
    expect(r.error).toBe(first);
    expect(r.calls).toStrictEqual(["only#1"]);
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
    expect(r.calls).toStrictEqual(["primary#1"]);
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

  test("a provider the network cannot reach gets three retries per candidate", () => {
    for (const attempt of [1, 2, 3]) expect(decideLlmFailure(unresolved(), at(attempt, true)).decision).toBe("retry");
    expect(decideLlmFailure(unresolved(), at(4, true)).decision).toBe("fallback");
    expect(decideLlmFailure(unresolved(), at(4, false)).decision).toBe("throw");
  });

  test("a timeout and a refusal skip the retry but may fall back", () => {
    expect(decideLlmFailure(timedOut(), at(1, true))).toEqual({ decision: "fallback", canFallback: true });
    expect(decideLlmFailure(refused(), at(1, true))).toEqual({ decision: "fallback", canFallback: true });
  });

  test("a request-shape error may not fall back", () => {
    expect(decideLlmFailure(contextTooLong(), at(1, true))).toEqual({ decision: "throw", canFallback: false });
  });

  test("a request-shape error behind a gateway's 500 is not retried either", () => {
    // A gateway may stamp every upstream failure 500, which alone reads as
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

});
