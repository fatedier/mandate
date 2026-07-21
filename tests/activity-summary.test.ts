import { expect, test } from "bun:test";
import type { ActivityGroupKey } from "../src/shared/api-contracts.js";
import { buildActivitySummary } from "../src/server/modules/activity/activity-summary.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

/** The date key `seed(…, { ago })` lands on. UTC, because the endpoint's day
 *  comes from `substr(created_at, 1, 10)` over an ISO string. */
function utcDay(ago: number): string {
  return new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
}

/** Seeds one call. `ago` is days before now; `ms` is its latency. */
function seed(
  db: import("bun:sqlite").Database,
  index: number,
  opts: {
    ago: number; ms: number; status?: string; error?: string; purpose?: string;
    ttft?: number | null; model?: string; provider?: string; scopeType?: string;
    fallback?: boolean;
    /** Written verbatim, so a test can put something in the column that no
     *  writer would. Wins over `fallback`. */
    rawMetadata?: string;
  }
) {
  const at = new Date(Date.now() - opts.ago * 86_400_000).toISOString();
  db.prepare(`
    insert into llm_calls
      (id, purpose, provider, model, scope_type, request_hash, response_hash, status, error_json,
       input_tokens, output_tokens, cache_read_tokens,
       started_at, finished_at, latency_ms, ttft_ms, created_at, updated_at, metadata_json)
    values (?, ?, ?, ?, ?, 'rq', 'rs', ?, ?, 100, 10, 50, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `call_${index}`,
    opts.purpose ?? "agent_wake_step",
    opts.provider ?? "openai-compatible",
    opts.model ?? "gpt-5.6-sol",
    opts.scopeType ?? "agent_thread",
    opts.status ?? "succeeded",
    opts.error ?? null,
    at, at, opts.ms, opts.ttft ?? null, at, at,
    // Absent and `false` are different rows, not the same one: one writer
    // records `fallbackAttempt: candidateIndex > 0`, so a retry on the first
    // candidate arrives with the key present and false.
    opts.rawMetadata ?? (opts.fallback === undefined
      ? null
      : JSON.stringify({ fallbackAttempt: opts.fallback, candidateIndex: opts.fallback ? 1 : 0 }))
  );
}

test("summary reports percentiles, not the average that hides the tail", () => {
  const env = freshStoresEnv("md-activity-summary-");
  try {
    // 99 fast calls and one very slow one: the mean is dragged, p50 is not,
    // and p99 is the only figure that shows the outlier at all.
    for (let i = 0; i < 99; i += 1) seed(env.store.db, i, { ago: 1, ms: 1000 });
    seed(env.store.db, 99, { ago: 1, ms: 300_000 });

    const summary = buildActivitySummary(env.store.db, 30, "purpose");
    expect(summary.p50Ms).toBe(1000);
    expect(summary.p99Ms).toBeGreaterThan(1000);
    expect(summary.daily.at(-1)!.calls).toBe(100);
  } finally {
    env.cleanup();
  }
});

test("the window bounds what is counted", () => {
  const env = freshStoresEnv("md-activity-window-");
  try {
    seed(env.store.db, 0, { ago: 1, ms: 1000 });
    // A latency the in-window call cannot produce. Given to a second 1000ms
    // call this row would be invisible: counts and percentiles would read the
    // same whether the window bounded the percentile query or not.
    seed(env.store.db, 1, { ago: 45, ms: 300_000 });

    const summary = buildActivitySummary(env.store.db, 30, "purpose");
    expect(summary.daily.length).toBe(1);
    expect(summary.groups[0]!.calls).toBe(1);
    expect(summary.p99Ms).toBe(1000);
    expect(summary.groups[0]!.maxMs).toBe(1000);
  } finally {
    env.cleanup();
  }
});

test("a group carries its own latency and the unwrapped reason", () => {
  const env = freshStoresEnv("md-activity-patterns-");
  try {
    // Status is no longer a key, so the two sides are told apart by the model
    // they ran on: one healthy group and one that fails, in the same window.
    seed(env.store.db, 0, { ago: 1, ms: 1000, model: "ok" });
    for (let i = 1; i <= 3; i += 1) {
      seed(env.store.db, i, {
        ago: 1, ms: 500, model: "bad", status: "failed",
        error: JSON.stringify({
          message:
            'Type validation failed: Value: {"error":{"message":"litellm.APIError: ' +
            'Our servers are currently overloaded. Please try again later.","code":"500"}}.'
        })
      });
    }

    const groups = buildActivitySummary(env.store.db, 30, "model").groups;
    const failed = groups.find((g) => g.key.endsWith("bad"))!;
    expect([failed.calls, failed.failed]).toEqual([3, 3]);
    // Latency is accumulated per group. If a row lands in the wrong bucket the
    // group still arrives, only with every figure reading someone else's — so
    // assert a group's own latency, not just that the group is there.
    expect(failed.p50Ms).toBe(500);
    expect(failed.maxMs).toBe(500);
    expect(groups.find((g) => g.key.endsWith("ok"))!.p50Ms).toBe(1000);
    // Three identical wrappers are one reason, and it is the provider's, not
    // the validation error that carried it.
    expect(failed.reasons).toEqual([
      { reason: "Our servers are currently overloaded. Please try again later. (500)", calls: 3 }
    ]);
    expect(groups.find((g) => g.key.endsWith("ok"))!.reasons).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("reasons merge back together across the coarse SQL group key", () => {
  const env = freshStoresEnv("md-activity-merge-");
  try {
    // The same provider failure, carried by two different validation wrappers.
    // SQL groups on a fixed-width slice of the message, so these land in two
    // groups; only the JS normalisation can see they are one reason.
    const payload =
      '{"error":{"message":"litellm.APIError: Our servers are currently ' +
      'overloaded. Please try again later.","code":"500"}}';
    const wrappers = [
      `Type validation failed: Value: ${payload}.`,
      `Type validation failed at path response.delta: Value: ${payload}. ` +
        `Zod trace: ${"expected object, received string; ".repeat(6)}`
    ];
    wrappers.forEach((message, i) => {
      seed(env.store.db, i, {
        ago: 1, ms: 500, status: "failed", error: JSON.stringify({ message })
      });
    });

    const failed = buildActivitySummary(env.store.db, 30, "purpose").groups[0]!;
    expect(failed.reasons).toEqual([
      { reason: "Our servers are currently overloaded. Please try again later. (500)", calls: 2 }
    ]);
  } finally {
    env.cleanup();
  }
});

test("one unparseable error_json degrades to its raw text instead of 500ing the page", () => {
  const env = freshStoresEnv("md-activity-malformed-");
  try {
    // json_extract() raises "malformed JSON text" rather than answering null,
    // so an unguarded extract turns one bad row into a failed statement — and
    // the whole Overview into a 500. Every writer goes through JSON.stringify
    // today, which is an audit, not a constraint the column enforces.
    seed(env.store.db, 0, {
      ago: 1, ms: 500, status: "failed", error: '{"message": "truncated mid-'
    });
    seed(env.store.db, 1, {
      ago: 1, ms: 500, status: "failed", error: JSON.stringify({ message: "Service Unavailable" })
    });

    const failed = buildActivitySummary(env.store.db, 30, "purpose").groups[0]!;
    // The good row still reads normally, and the bad one arrives as the text it
    // holds rather than removing itself from the count.
    expect([failed.calls, failed.failed]).toEqual([2, 2]);
    expect(failed.reasons.map((r) => r.reason).sort()).toEqual([
      'Service Unavailable',
      '{"message": "truncated mid-'
    ]);
  } finally {
    env.cleanup();
  }
});

test("latency buckets cover every call exactly once", () => {
  const env = freshStoresEnv("md-activity-buckets-");
  try {
    [500, 3000, 9000, 30_000, 90_000].forEach((ms, i) =>
      seed(env.store.db, i, { ago: 1, ms })
    );
    const summary = buildActivitySummary(env.store.db, 30, "purpose");
    expect(summary.buckets.map((b) => b.bucket)).toEqual([
      "<1s", "1-5s", "5-15s", "15-60s", ">60s"
    ]);
    expect(summary.buckets.every((b) => b.calls === 1)).toBe(true);
  } finally {
    env.cleanup();
  }
});

test("an empty window answers with zeros rather than throwing", () => {
  const env = freshStoresEnv("md-activity-empty-");
  try {
    const summary = buildActivitySummary(env.store.db, 30, "purpose");
    expect(summary.daily).toEqual([]);
    expect(summary.groups).toEqual([]);
    expect(summary.p95Ms).toBe(0);
  } finally {
    env.cleanup();
  }
});

test("a percentile lands on the same row the window function picked", () => {
  const env = freshStoresEnv("md-activity-pct-");
  try {
    // 1..100ms, so every percentile has one right answer and an off-by-one is
    // a different number rather than a rounding argument. The old query ranked
    // from 1 and took `cast(n * p as int) + 1`; sorted ascending from zero that
    // is index floor(n * p), which is what this pins.
    for (let i = 0; i < 100; i += 1) seed(env.store.db, i, { ago: 1, ms: i + 1 });
    const summary = buildActivitySummary(env.store.db, 30, "purpose");
    expect([summary.p50Ms, summary.p95Ms, summary.p99Ms]).toEqual([51, 96, 100]);

    // A hundred rows divide exactly, so floor and ceil agree on all three and
    // the test above cannot tell them apart. Seven cannot: 7 * 0.5 is 3.5, and
    // rounding it the other way reads 5 where the window function read 4.
    const odd = freshStoresEnv("md-activity-pct-odd-");
    try {
      for (let i = 0; i < 7; i += 1) seed(odd.store.db, i, { ago: 1, ms: i + 1 });
      expect(buildActivitySummary(odd.store.db, 30, "purpose").p50Ms).toBe(4);
    } finally {
      odd.cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test("a single call is its own p50, p95 and p99", () => {
  const env = freshStoresEnv("md-activity-pct-one-");
  try {
    // The index formula has to survive the smallest group there is: floor(1 *
    // 0.99) is 0, and any scheme that rounded up would read past the end.
    seed(env.store.db, 0, { ago: 1, ms: 4200 });
    const summary = buildActivitySummary(env.store.db, 30, "purpose");
    expect([summary.p50Ms, summary.p95Ms, summary.p99Ms, summary.daily[0]!.p95Ms])
      .toEqual([4200, 4200, 4200, 4200]);
  } finally {
    env.cleanup();
  }
});

test("groups and reasons on equal counts come back in a fixed order", () => {
  const env = freshStoresEnv("md-activity-ties-");
  try {
    // Two purposes with the same number of calls, and within one of them two
    // distinct reasons with the same number of failures. Sqlite promised no
    // order for either, so the page could reshuffle between loads while
    // nothing about the data had changed.
    const boom = JSON.stringify({ message: "boom" });
    const bang = JSON.stringify({ message: "bang" });
    seed(env.store.db, 0, { ago: 1, ms: 100, purpose: "zeta", status: "failed", error: boom });
    seed(env.store.db, 1, { ago: 1, ms: 100, purpose: "zeta", status: "failed", error: bang });
    seed(env.store.db, 2, { ago: 1, ms: 100, purpose: "alpha", status: "failed", error: boom });
    seed(env.store.db, 3, { ago: 1, ms: 100, purpose: "alpha", status: "failed", error: bang });

    const summary = buildActivitySummary(env.store.db, 30, "purpose");
    expect(summary.groups.map((g) => g.key)).toEqual(["alpha", "zeta"]);
    expect(summary.groups.map((g) => g.reasons.map((r) => r.reason))).toEqual([
      ["bang", "boom"],
      ["bang", "boom"]
    ]);
  } finally {
    env.cleanup();
  }
});

test("tied reasons sort by what they say, not by the text they were cut from", () => {
  const env = freshStoresEnv("md-activity-ties-unwrap-");
  try {
    // The SQL group key is the raw column, so these two arrive in the opposite
    // order to the one the reader sees: "aaa wrapper" sorts first raw, and
    // "alpha" sorts first once unwrapped. Ordering by arrival would put zulu
    // on top of a list whose visible text says otherwise.
    const wrap = (lead: string, message: string) => JSON.stringify({
      message: `${lead} {"error":{"message":"${message}","code":"500"}}`
    });
    seed(env.store.db, 0, { ago: 1, ms: 100, status: "failed", error: wrap("zzz wrapper", "alpha") });
    seed(env.store.db, 1, { ago: 1, ms: 100, status: "failed", error: wrap("aaa wrapper", "zulu") });

    const reasons = buildActivitySummary(env.store.db, 30, "purpose").groups[0]!.reasons;
    expect(reasons.map((r) => r.reason)).toEqual(["alpha (500)", "zulu (500)"]);
  } finally {
    env.cleanup();
  }
});

test("a group's max is its slowest call, not its first or its fastest", () => {
  const env = freshStoresEnv("md-activity-max-");
  try {
    // Seeded slowest-first, so a max that took the head of the list would also
    // be right by accident. The tail is what has to be read.
    seed(env.store.db, 0, { ago: 3, ms: 9000 });
    seed(env.store.db, 1, { ago: 2, ms: 1000 });
    seed(env.store.db, 2, { ago: 1, ms: 5000 });

    const group = buildActivitySummary(env.store.db, 30, "purpose").groups[0]!;
    expect(group.maxMs).toBe(9000);
  } finally {
    env.cleanup();
  }
});

test("a running call counts toward its group without inventing a latency", () => {
  const env = freshStoresEnv("md-activity-running-");
  try {
    // latency_ms is null until a call finishes. It still happened, so it counts
    // — but a percentile built over a zero it never reported would drag every
    // reading on the page down.
    seed(env.store.db, 0, { ago: 1, ms: 5000 });
    // Its own purpose, because status is no longer a key: the running call has
    // to land in a group of its own for "counts, with no reading" to be
    // readable at all.
    env.store.db.prepare(`
      insert into llm_calls
        (id, purpose, provider, request_hash, response_hash, status,
         started_at, created_at, updated_at)
      values ('call_live', 'agent_wake_live', 'openai-compatible', 'rq', 'rs', 'running', ?, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    const summary = buildActivitySummary(env.store.db, 30, "purpose");
    const running = summary.groups.find((g) => g.key === "agent_wake_live");
    expect(running?.calls).toBe(1);
    expect([running?.p50Ms, running?.maxMs]).toEqual([0, 0]);
    expect(summary.p50Ms).toBe(5000);
    expect(summary.buckets.reduce((sum, b) => sum + b.calls, 0)).toBe(1);
    // "not succeeded" is not the same question as "failed": a running call is
    // neither, and counting it as a failure would put a red bar on the chart
    // for a call that has not finished.
    expect(summary.daily.at(-1)!.failed).toBe(0);
  } finally {
    env.cleanup();
  }
});

test("each token total is summed from its own column", () => {
  const env = freshStoresEnv("md-activity-tokens-");
  try {
    // The seed writes 100 in, 10 out, 50 cached — three distinct numbers, so a
    // pair of columns swapped in the accumulator reads as a plausible total
    // rather than as something obviously wrong. Two rows, so a sum that took
    // the last row instead of adding also shows.
    seed(env.store.db, 0, { ago: 1, ms: 100 });
    seed(env.store.db, 1, { ago: 1, ms: 200 });

    const day = buildActivitySummary(env.store.db, 30, "purpose").daily.at(-1)!;
    expect([day.inputTokens, day.outputTokens, day.cacheReadTokens]).toEqual([200, 20, 100]);
  } finally {
    env.cleanup();
  }
});

test("time to first token is summed over the calls that have one, not the window", () => {
  const env = freshStoresEnv("md-activity-ttft-");
  try {
    // The column is newer than the window it is read over, so most rows carry a
    // latency and no ttft. Counting those as zero would report a first token
    // that arrived instantly on nine calls out of ten.
    for (let i = 0; i < 9; i += 1) seed(env.store.db, i, { ago: 1, ms: 5000 });
    seed(env.store.db, 9, { ago: 1, ms: 5000, ttft: 400 });
    seed(env.store.db, 10, { ago: 1, ms: 5000, ttft: 800 });

    const summary = buildActivitySummary(env.store.db, 30, "purpose");
    expect(summary.ttft.calls).toBe(2);
    expect(summary.ttft.p50Ms).toBe(800);
    // The latency percentile still sees every call, so the two figures describe
    // different sets on purpose and the count is what says so.
    expect(summary.p50Ms).toBe(5000);
  } finally {
    env.cleanup();
  }
});

test("a window where nothing recorded a first token reports none rather than zero", () => {
  const env = freshStoresEnv("md-activity-ttft-none-");
  try {
    seed(env.store.db, 0, { ago: 1, ms: 5000 });
    const summary = buildActivitySummary(env.store.db, 30, "purpose");
    // calls === 0 is what the panel keys on: a p50 of 0 beside "0 calls" is the
    // absence of a reading, and beside a real count it would be a claim.
    expect([summary.ttft.calls, summary.ttft.p50Ms]).toEqual([0, 0]);
  } finally {
    env.cleanup();
  }
});

test("each dimension groups the same window by its own key", () => {
  const env = freshStoresEnv("md-activity-group-");
  try {
    // Every row differs in every dimension, so a switch wired to the wrong
    // column produces different group keys rather than the same ones by luck.
    seed(env.store.db, 0, { ago: 1, ms: 1000, purpose: "agent_wake_step",
      model: "gpt-5.6-sol", provider: "openai-compatible", scopeType: "agent_thread" });
    seed(env.store.db, 1, { ago: 1, ms: 2000, purpose: "memory_dream",
      model: "gpt-5.5", provider: "codex", scopeType: "memory", fallback: true });

    const by = (group: ActivityGroupKey) =>
      buildActivitySummary(env.store.db, 30, group).groups.map((g) => g.key).sort();

    expect(by("model")).toEqual(["codex / gpt-5.5", "openai-compatible / gpt-5.6-sol"]);
    expect(by("purpose")).toEqual(["agent_wake_step", "memory_dream"]);
    expect(by("scopeType")).toEqual(["agent_thread", "memory"]);
    expect(by("fallback")).toEqual(["fallback", "primary"]);
    expect(by("day").length).toBe(1);
  } finally {
    env.cleanup();
  }
});

test("the response says which grouping produced it", () => {
  const env = freshStoresEnv("md-activity-group-echo-");
  try {
    seed(env.store.db, 0, { ago: 1, ms: 1000 });
    expect(buildActivitySummary(env.store.db, 30, "scopeType").group).toBe("scopeType");
  } finally {
    env.cleanup();
  }
});

test("a group carries its own failures, tokens and percentiles", () => {
  const env = freshStoresEnv("md-activity-group-metrics-");
  try {
    // Two models, and every figure distinct between them: a metric read off the
    // wrong group renders a real number against the wrong name.
    for (let i = 0; i < 4; i += 1) {
      seed(env.store.db, i, { ago: 1, ms: 1000 + i * 1000, model: "fast" });
    }
    seed(env.store.db, 4, { ago: 1, ms: 9000, model: "slow", status: "failed",
      error: JSON.stringify({ message: "boom" }) });
    // A third status on one of the two groups. Without it "failed" and "not
    // succeeded" are the same question over this fixture, and a group that
    // counted every unfinished call as a failure would read correct.
    seed(env.store.db, 5, { ago: 1, ms: 700, model: "slow", status: "running" });

    const groups = buildActivitySummary(env.store.db, 30, "model").groups;
    const fast = groups.find((g) => g.key.endsWith("fast"))!;
    const slow = groups.find((g) => g.key.endsWith("slow"))!;

    expect([fast.calls, fast.failed]).toEqual([4, 0]);
    expect([slow.calls, slow.failed]).toEqual([2, 1]);
    // 1000/2000/3000/4000 sorted: floor(4*0.5) = index 2.
    expect(fast.p50Ms).toBe(3000);
    expect(slow.maxMs).toBe(9000);
    // The seed writes 100 in, 10 out, 50 cached per row.
    expect([fast.inputTokens, fast.outputTokens, fast.cacheReadTokens]).toEqual([400, 40, 200]);
    expect(slow.reasons.map((r) => r.reason)).toEqual(["boom"]);
  } finally {
    env.cleanup();
  }
});

test("a group's tail percentiles are the tail, and are its own", () => {
  const env = freshStoresEnv("md-activity-group-tails-");
  try {
    // Twenty-five calls, which is the smallest count where floor(n*0.5),
    // floor(n*0.95) and floor(n*0.99) are three different indexes: at twenty
    // the last two are the same row, and a p99 reading p95 would pass over it.
    for (let i = 0; i < 25; i += 1) {
      seed(env.store.db, i, { ago: 1, ms: (i + 1) * 100, model: "measured" });
    }
    // One much slower call, in a group of its own so it moves the window's
    // percentiles without moving the group's. Without it every figure below is
    // the same read off either set, and a group percentile taken from the whole
    // window renders a real number against the wrong name.
    seed(env.store.db, 25, { ago: 1, ms: 60_000, model: "outlier" });

    const summary = buildActivitySummary(env.store.db, 30, "model");
    const measured = summary.groups.find((g) => g.key.endsWith("measured"))!;
    // 100…2500 ascending: indexes 12, 23 and 24. Read as a triple, because each
    // of the three is a different mistake — a p95 given 0.5 reports 1300 here,
    // a p99 given 0.95 reports 2400, and both are plausible latencies.
    expect([measured.p50Ms, measured.p95Ms, measured.p99Ms]).toEqual([1300, 2400, 2500]);
    // The same three over the window, and different in all three places: this
    // is the pair that says the group's figures came from the group.
    expect([summary.p50Ms, summary.p95Ms, summary.p99Ms]).toEqual([1400, 2500, 60_000]);
  } finally {
    env.cleanup();
  }
});

test("a failure reason lands on the group that produced it", () => {
  const env = freshStoresEnv("md-activity-group-reason-");
  try {
    // The finding this feature exists for: two models failing for different
    // reasons. Attached to the wrong group, each would report the other's.
    seed(env.store.db, 0, { ago: 1, ms: 500, model: "a", status: "failed",
      error: JSON.stringify({ message: "Not Found" }) });
    seed(env.store.db, 1, { ago: 1, ms: 500, model: "b", status: "failed",
      error: JSON.stringify({ message: "Service Unavailable" }) });

    const groups = buildActivitySummary(env.store.db, 30, "model").groups;
    expect(groups.find((g) => g.key.endsWith("a"))!.reasons.map((r) => r.reason))
      .toEqual(["Not Found"]);
    expect(groups.find((g) => g.key.endsWith("b"))!.reasons.map((r) => r.reason))
      .toEqual(["Service Unavailable"]);
  } finally {
    env.cleanup();
  }
});

test("a failure reason follows the key on every dimension, not just the row's own", () => {
  const env = freshStoresEnv("md-activity-group-reason-columns-");
  try {
    // The reason query is a second read, so every column a key is built from
    // has to be selected there too — and `purpose` and `model` come along for
    // free with the rest of the row. Day, scope and fallback do not. Two
    // failures that differ in all three, so one fixture asks the question three
    // times: drop any of those columns from that select and the key it builds
    // stops matching, the reasons quietly go nowhere, and every group on that
    // dimension reports no failures while its `failed` count says otherwise.
    seed(env.store.db, 0, { ago: 1, ms: 500, scopeType: "agent_thread", status: "failed",
      error: JSON.stringify({ message: "Not Found" }) });
    seed(env.store.db, 1, { ago: 3, ms: 500, scopeType: "memory", fallback: true,
      status: "failed", error: JSON.stringify({ message: "Service Unavailable" }) });

    const reasonsBy = (group: ActivityGroupKey) =>
      buildActivitySummary(env.store.db, 30, group).groups
        .map((g) => [g.key, g.reasons.map((r) => r.reason)]);

    expect(reasonsBy("scopeType")).toEqual([
      ["agent_thread", ["Not Found"]],
      ["memory", ["Service Unavailable"]]
    ]);
    // Newest first, so the row seeded one day ago leads. The key is named
    // rather than discarded: a wrong-but-present date misses both groups and
    // reads as two empty lists, which an assertion over reasons alone would
    // report as a reason problem rather than a key one.
    expect(reasonsBy("day")).toEqual([
      [utcDay(1), ["Not Found"]],
      [utcDay(3), ["Service Unavailable"]]
    ]);
    expect(reasonsBy("fallback")).toEqual([
      ["fallback", ["Service Unavailable"]],
      ["primary", ["Not Found"]]
    ]);
  } finally {
    env.cleanup();
  }
});

test("two failures alike but for one key column stay two failures", () => {
  // The other half of the same query. Selecting a key column is not enough — it
  // has to be grouped on too. Two rows identical in every column the reason
  // query groups by except one, message included, collapse into a single row
  // with n = 2 and a bare value for the ungrouped column that sqlite picks
  // arbitrarily from the pair; the JS then adds both failures to whichever side
  // won and none to the other.
  //
  // The shared message is the whole point. Two failures that differ in `k` are
  // already two rows, so the bare column is unambiguous and a fixture built that
  // way stays green with the `group by` column dropped — it proves nothing.
  //
  // One pair per column, in its own store, because a pair has to differ in
  // *exactly* one key column: any second difference re-separates the rows and
  // the collapse stops being reachable.
  const boom = JSON.stringify({ message: "boom" });
  const pair = (
    name: string,
    group: ActivityGroupKey,
    a: Parameters<typeof seed>[2],
    b: Parameters<typeof seed>[2]
  ) => {
    const env = freshStoresEnv(`md-activity-group-collapse-${name}-`);
    try {
      seed(env.store.db, 0, { ...a, status: "failed", error: boom });
      seed(env.store.db, 1, { ...b, status: "failed", error: boom });
      // `failed` comes off the scan and `reasons` off the second read, so
      // listing them together is what makes a collapse legible: the two
      // disagreeing is the symptom, one saying a failure happened here and the
      // other saying it happened somewhere else.
      return buildActivitySummary(env.store.db, 30, group).groups
        .map((g) => [g.key, g.failed, g.reasons]);
    } finally {
      env.cleanup();
    }
  };
  const one = [{ reason: "boom", calls: 1 }];

  expect(pair("scope", "scopeType",
    { ago: 1, ms: 500, scopeType: "agent_thread" },
    { ago: 1, ms: 500, scopeType: "memory" }
  )).toEqual([["agent_thread", 1, one], ["memory", 1, one]]);

  expect(pair("day", "day",
    { ago: 1, ms: 500 },
    { ago: 2, ms: 500 }
  )).toEqual([[utcDay(1), 1, one], [utcDay(2), 1, one]]);

  expect(pair("fallback", "fallback",
    { ago: 1, ms: 500, fallback: true },
    { ago: 1, ms: 500 }
  )).toEqual([["fallback", 1, one], ["primary", 1, one]]);
});

test("one unparseable metadata_json degrades instead of 500ing the page", () => {
  const env = freshStoresEnv("md-activity-metadata-malformed-");
  try {
    // The same hazard the error_json guard exists for, on a column whose audit
    // is weaker: retention.ts deliberately leaves a row it cannot parse alone
    // rather than rewriting it, so an unreadable metadata_json is a shape the
    // system keeps. Unguarded, json_extract raises on it and one bad row takes
    // the whole Overview down with a 500.
    const truncated = '{"fallbackAttempt": tr';
    seed(env.store.db, 0, { ago: 1, ms: 500, rawMetadata: truncated });
    seed(env.store.db, 1, { ago: 1, ms: 500, fallback: true });
    // And once more on the failure path, because the reason query reads the
    // same column through its own copy of the extract.
    seed(env.store.db, 2, { ago: 1, ms: 500, rawMetadata: truncated, status: "failed",
      error: JSON.stringify({ message: "boom" }) });

    const groups = buildActivitySummary(env.store.db, 30, "fallback").groups;
    // The bad rows read as "not known to be a fallback" rather than removing
    // themselves from the window, and the reason behind one of them still
    // arrives on the group it belongs to.
    expect(groups.map((g) => [g.key, g.calls])).toEqual([["primary", 2], ["fallback", 1]]);
    expect(groups[0]!.reasons.map((r) => r.reason)).toEqual(["boom"]);
  } finally {
    env.cleanup();
  }
});

test("fallback counts the calls that were a retry on another candidate", () => {
  const env = freshStoresEnv("md-activity-group-fallback-");
  try {
    seed(env.store.db, 0, { ago: 1, ms: 500, model: "primary" });
    seed(env.store.db, 1, { ago: 1, ms: 500, model: "backup", fallback: true });
    seed(env.store.db, 2, { ago: 1, ms: 500, model: "backup", fallback: true });

    const byModel = buildActivitySummary(env.store.db, 30, "model").groups;
    expect(byModel.find((g) => g.key.endsWith("primary"))!.fallbackCalls).toBe(0);
    expect(byModel.find((g) => g.key.endsWith("backup"))!.fallbackCalls).toBe(2);

    // And as its own dimension the two sides separate.
    const byFallback = buildActivitySummary(env.store.db, 30, "fallback").groups;
    expect(byFallback.map((g) => [g.key, g.calls])).toEqual([["fallback", 2], ["primary", 1]]);
  } finally {
    env.cleanup();
  }
});

test("a call that recorded a fallback marker of false is not a fallback", () => {
  const env = freshStoresEnv("md-activity-group-fallback-false-");
  try {
    // `agent_compression` writes `fallbackAttempt: candidateIndex > 0`, so a
    // second attempt on the *first* candidate arrives with the key present and
    // false. Reading presence rather than truth would file it as a fallback to
    // a model that was never reached.
    seed(env.store.db, 0, { ago: 1, ms: 500, fallback: false });

    const groups = buildActivitySummary(env.store.db, 30, "fallback").groups;
    expect(groups.map((g) => [g.key, g.calls])).toEqual([["primary", 1]]);
    expect(groups[0]!.fallbackCalls).toBe(0);
  } finally {
    env.cleanup();
  }
});

test("days come back newest first, everything else by size", () => {
  const env = freshStoresEnv("md-activity-group-order-");
  try {
    // Sorting days by call count would put an ordinary Tuesday above yesterday.
    seed(env.store.db, 0, { ago: 3, ms: 500 });
    seed(env.store.db, 1, { ago: 3, ms: 500 });
    seed(env.store.db, 2, { ago: 1, ms: 500 });
    const days = buildActivitySummary(env.store.db, 30, "day").groups;
    expect(days.map((g) => g.calls)).toEqual([1, 2]);

    // Ties on any other dimension break by name, so two loads agree.
    seed(env.store.db, 3, { ago: 1, ms: 500, purpose: "zeta" });
    seed(env.store.db, 4, { ago: 1, ms: 500, purpose: "alpha" });
    const purposes = buildActivitySummary(env.store.db, 30, "purpose").groups
      .filter((g) => g.calls === 1).map((g) => g.key);
    expect(purposes).toEqual(["alpha", "zeta"]);
  } finally {
    env.cleanup();
  }
});

test("a row with no scope type groups under a name rather than an empty cell", () => {
  const env = freshStoresEnv("md-activity-group-blank-");
  try {
    seed(env.store.db, 0, { ago: 1, ms: 500, scopeType: "" });
    const group = buildActivitySummary(env.store.db, 30, "scopeType").groups[0]!;
    // Both, because the label is what the reader sees and the key is what the
    // log filter is built from: a placeholder on one and a blank on the other
    // would show as an unnamed row or as a filter that matches nothing.
    expect([group.key, group.label]).toEqual(["(none)", "(none)"]);
  } finally {
    env.cleanup();
  }
});
