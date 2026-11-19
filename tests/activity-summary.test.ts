import { expect, test } from "bun:test";
import type { ActivityGroupKey } from "../src/shared/api-contracts.js";
import { buildActivitySummary } from "../src/server/modules/activity/activity-summary.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { llmCallDetails } from "./helpers/llm-calls.js";

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
    ttft?: number | null; model?: string; provider?: string; providerName?: string; scopeType?: string;
    fallback?: boolean;
    /** An estimated cost, micro-dollars. */
    cost?: number;
    /** Written verbatim, so a test can put something in the column that no
     *  writer would. Wins over `fallback`. */
    rawMetadata?: string;
  }
) {
  const at = new Date(Date.now() - opts.ago * 86_400_000).toISOString();
  db.prepare(`
    insert into llm_calls
      (id, purpose, provider, provider_name, model, scope_type, request_hash, response_hash, status, error_json,
       input_tokens, output_tokens, cache_read_tokens,
       started_at, finished_at, latency_ms, ttft_ms, created_at, updated_at, metadata_json, cost_source, cost_micros)
    values (?, ?, ?, ?, ?, ?, 'rq', 'rs', ?, ?, 100, 10, 50, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `call_${index}`,
    opts.purpose ?? "agent_wake_step",
    opts.provider ?? "openai-compatible",
    // As the store writes it: the connection's name, else the provider.
    opts.providerName ?? opts.provider ?? "openai-compatible",
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
      : JSON.stringify({ fallbackAttempt: opts.fallback, candidateIndex: opts.fallback ? 1 : 0 })),
    opts.cost === undefined ? null : "list",
    opts.cost ?? null
  );
}

test("summary reports percentiles, not the average that hides the tail", () => {
  const env = freshStoresEnv("md-activity-summary-");
  // 90 fast calls and ten very slow ones: the mean is dragged, p50 is not,
  // and p95 is the figure that shows the tail.
  for (let i = 0; i < 90; i += 1) seed(env.store.db, i, { ago: 1, ms: 1000 });
  for (let i = 90; i < 100; i += 1) seed(env.store.db, i, { ago: 1, ms: 300_000 });

  const summary = buildActivitySummary(env.store.db, 30, "purpose");
  expect(summary.groups[0]!.p50Ms).toBe(1000);
  expect(summary.daily.at(-1)!.p95Ms).toBe(300_000);
  expect(summary.daily.at(-1)!.calls).toBe(100);
});

test("the window bounds what is counted", () => {
  const env = freshStoresEnv("md-activity-window-");
  seed(env.store.db, 0, { ago: 1, ms: 1000 });
  // A latency the in-window call cannot produce. Given to a second 1000ms
  // call this row would be invisible: counts and percentiles would read the
  // same whether the window bounded the percentile query or not.
  seed(env.store.db, 1, { ago: 45, ms: 300_000 });

  const summary = buildActivitySummary(env.store.db, 30, "purpose");
  expect(summary.daily.length).toBe(1);
  expect(summary.groups[0]!.calls).toBe(1);
  expect(summary.groups[0]!.p50Ms).toBe(1000);
});

test("a group carries its own latency and the unwrapped reason", () => {
  const env = freshStoresEnv("md-activity-patterns-");
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
  expect(groups.find((g) => g.key.endsWith("ok"))!.p50Ms).toBe(1000);
  // Three identical wrappers are one reason, and it is the provider's, not
  // the validation error that carried it.
  expect(failed.reasons).toEqual([
    { reason: "Our servers are currently overloaded. Please try again later. (500)", calls: 3 }
  ]);
  expect(groups.find((g) => g.key.endsWith("ok"))!.reasons).toEqual([]);
});

test("reasons merge back together across the coarse SQL group key", () => {
  const env = freshStoresEnv("md-activity-merge-");
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
});

test("one unparseable error_json degrades to its raw text instead of 500ing the page", () => {
  const env = freshStoresEnv("md-activity-malformed-");
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
});

test("an empty window answers with zeros rather than throwing", () => {
  const env = freshStoresEnv("md-activity-empty-");
  const summary = buildActivitySummary(env.store.db, 30, "purpose");
  expect(summary.daily).toEqual([]);
  expect(summary.groups).toEqual([]);
});

test("a percentile lands on the same row the window function picked", () => {
  const env = freshStoresEnv("md-activity-pct-");
  // 1..100ms, so every percentile has one right answer and an off-by-one is
  // a different number rather than a rounding argument. The old query ranked
  // from 1 and took `cast(n * p as int) + 1`; sorted ascending from zero that
  // is index floor(n * p), which is what this pins.
  for (let i = 0; i < 100; i += 1) seed(env.store.db, i, { ago: 1, ms: i + 1 });
  const summary = buildActivitySummary(env.store.db, 30, "purpose");
  expect([summary.groups[0]!.p50Ms, summary.daily[0]!.p50Ms, summary.daily[0]!.p95Ms]).toEqual([51, 51, 96]);

  // A hundred rows divide exactly, so floor and ceil agree on both and
  // the test above cannot tell them apart. Seven cannot: 7 * 0.5 is 3.5, and
  // rounding it the other way reads 5 where the window function read 4.
  const odd = freshStoresEnv("md-activity-pct-odd-");
  for (let i = 0; i < 7; i += 1) seed(odd.store.db, i, { ago: 1, ms: i + 1 });
  expect(buildActivitySummary(odd.store.db, 30, "purpose").groups[0]!.p50Ms).toBe(4);
});

test("a single call is its own p50 and p95", () => {
  const env = freshStoresEnv("md-activity-pct-one-");
  // The index formula has to survive the smallest group there is: floor(1 *
  // 0.95) is 0, and any scheme that rounded up would read past the end.
  seed(env.store.db, 0, { ago: 1, ms: 4200 });
  const summary = buildActivitySummary(env.store.db, 30, "purpose");
  const [group] = summary.groups;
  expect([group!.p50Ms, summary.daily[0]!.p50Ms, summary.daily[0]!.p95Ms])
    .toEqual([4200, 4200, 4200]);
});

test("groups and reasons on equal counts come back in a fixed order", () => {
  const env = freshStoresEnv("md-activity-ties-");
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
});

test("tied reasons sort by what they say, not by the text they were cut from", () => {
  const env = freshStoresEnv("md-activity-ties-unwrap-");
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
});

test("a running call counts toward its group without inventing a latency", () => {
  const env = freshStoresEnv("md-activity-running-");
  // latency_ms is null until a call finishes. It still happened, so it counts
  // — but a percentile built over a zero it never reported would drag every
  // reading on the page down. Today, as the running call is: one day holds both.
  seed(env.store.db, 0, { ago: 0, ms: 5000 });
  // Its own purpose, because status is no longer a key: the running call has
  // to land in a group of its own for "counts, with no reading" to be
  // readable at all.
  const live = env.store.db.prepare(`
      insert into llm_calls
        (id, purpose, provider, request_hash, response_hash, status,
         started_at, created_at, updated_at)
      values (?, 'agent_wake_live', 'openai-compatible', 'rq', 'rs', 'running', ?, ?, ?)
    `);
  // Two of them, so a zero counted for each would be the day's median.
  for (const id of ["call_live", "call_live_2"]) live.run(id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

  const summary = buildActivitySummary(env.store.db, 30, "purpose");
  const running = summary.groups.find((g) => g.key === "agent_wake_live");
  expect(running?.calls).toBe(2);
  expect(running?.p50Ms).toBe(0);
  // The day counts them and reads its latency from the call that has one:
  // counted as zeros, the two would make its median 0.
  expect(summary.daily.at(-1)!.calls).toBe(3);
  expect(summary.daily.at(-1)!.p50Ms).toBe(5000);
  // "not succeeded" is not the same question as "failed": a running call is
  // neither, and counting it as a failure would put a red bar on the chart
  // for a call that has not finished.
  expect(summary.daily.at(-1)!.failed).toBe(0);
});

test("each token total is summed from its own column", () => {
  const env = freshStoresEnv("md-activity-tokens-");
  // The seed writes 100 in, 10 out, 50 cached — three distinct numbers, so a
  // pair of columns swapped in the accumulator reads as a plausible total
  // rather than as something obviously wrong. Two rows, so a sum that took
  // the last row instead of adding also shows.
  seed(env.store.db, 0, { ago: 1, ms: 100 });
  seed(env.store.db, 1, { ago: 1, ms: 200 });

  const day = buildActivitySummary(env.store.db, 30, "purpose").daily.at(-1)!;
  expect([day.inputTokens, day.outputTokens, day.cacheReadTokens]).toEqual([200, 20, 100]);
});

test("a group's first token is read over the calls that have one, not all of them", () => {
  const env = freshStoresEnv("md-activity-ttft-");
  // The column is newer than the window it is read over, so most rows carry a
  // latency and no ttft. Counting those as zero would report a first token
  // that arrived instantly on nine calls out of ten.
  // Forty without a reading to two with one: counted as zeros, they would
  // fill the p95 too.
  for (let i = 0; i < 40; i += 1) seed(env.store.db, i, { ago: 1, ms: 5000 });
  seed(env.store.db, 40, { ago: 1, ms: 5000, ttft: 400 });
  seed(env.store.db, 41, { ago: 1, ms: 5000, ttft: 800 });

  const [group] = buildActivitySummary(env.store.db, 30, "purpose").groups;
  expect(group!.ttftP95Ms).toBe(800);
  // The latency percentile still sees every call: the two figures describe
  // different sets on purpose.
  expect(group!.p50Ms).toBe(5000);
});

test("each group carries its first-token p95 and its median answered call's speed over the whole call", () => {
  const env = freshStoresEnv("md-activity-group-speed-");
  // Ten output tokens a call (the seed's): 1, 2, 4, 5 and 10 seconds are 10, 5,
  // 2.5, 2 and 1 tokens a second; the median is 2.5. A failed call, fast as
  // it was, says nothing of the speed of an answer.
  [1_000, 2_000, 4_000, 5_000, 10_000].forEach((ms, i) => seed(env.store.db, i, { ago: 1, ms, ttft: [100, 200, 300, 400, 900][i], model: "fast-1" }));
  seed(env.store.db, 5, { ago: 1, ms: 100, ttft: 50, status: "failed", error: "{}", model: "fast-1" });
  // No first token recorded, and no call that answered.
  seed(env.store.db, 6, { ago: 1, ms: 3_000, status: "failed", error: "{}", model: "quiet-1" });
  const groups = buildActivitySummary(env.store.db, 30, "model").groups;
  const of = (model: string) => groups.find((g) => g.key.endsWith(model))!;
  expect([of("fast-1").ttftP95Ms, of("fast-1").tokensPerSecondP50]).toEqual([900, 2.5]);
  expect([of("quiet-1").ttftP95Ms, of("quiet-1").tokensPerSecondP50]).toEqual([null, null]);
});

test("grouped by day, the summary carries the three busiest models and the rest, day by day", () => {
  const env = freshStoresEnv("md-activity-trend-");
  let index = 0;
  const add = (model: string, ago: number, opts: { ttft?: number; cost?: number; failed?: boolean } = {}) =>
    seed(env.store.db, index++, { ago, ms: 2_000, model, ttft: opts.ttft, cost: opts.cost, ...(opts.failed ? { status: "failed", error: "{}" } : {}) });
  // Calls: a 4, b 3, c 2, d 1 — the three busiest and the one other.
  add("a", 1, { ttft: 300, cost: 1_000_000 }); add("a", 1, { ttft: 500, cost: 2_000_000 });
  add("a", 0, { ttft: 700, failed: true }); add("a", 0, { ttft: 900 });
  add("b", 1); add("b", 1); add("b", 0, { cost: 500_000 });
  add("c", 0); add("c", 0, { failed: true });
  add("d", 1, { cost: 4_000_000 });
  const trend = buildActivitySummary(env.store.db, 30, "day").trend!;
  const key = (model: string) => `openai-compatible / ${model}`;
  expect(trend.series).toEqual([
    { key: key("a"), label: key("a"), others: false, models: 1 },
    { key: key("b"), label: key("b"), others: false, models: 1 },
    { key: key("c"), label: key("c"), others: false, models: 1 },
    { key: "others", label: "others", others: true, models: 1 }
  ]);
  const value = (ago: number, k: string) => trend.days.find((d) => d.date === utcDay(ago))!.values.find((v) => v.key === k);
  expect(value(1, key("a"))).toEqual({ key: key("a"), calls: 2, spendMicros: 3_000_000, ttftP95Ms: 500, failedRate: 0 });
  expect(value(0, key("a"))).toEqual({ key: key("a"), calls: 2, spendMicros: 0, ttftP95Ms: 900, failedRate: 50 });
  // A day a model had no call: no reading, not a zero.
  expect(value(1, key("c"))).toEqual({ key: key("c"), calls: 0, spendMicros: 0, ttftP95Ms: null, failedRate: null });
  expect(value(1, "others")).toEqual({ key: "others", calls: 1, spendMicros: 4_000_000, ttftP95Ms: null, failedRate: 0 });
  // Every date the chart draws, in order.
  expect(trend.days.map((d) => d.date)).toEqual(buildActivitySummary(env.store.db, 30, "day").dates);
});

test("other groupings carry no trend", () => {
  const env = freshStoresEnv("md-activity-trend-none-");
  seed(env.store.db, 0, { ago: 1, ms: 1_000 });
  expect(buildActivitySummary(env.store.db, 30, "model").trend).toBeUndefined();
});

test("each dimension groups the same window by its own key", () => {
  const env = freshStoresEnv("md-activity-group-");
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
});

test("a group carries its own failures, tokens and percentiles", () => {
  const env = freshStoresEnv("md-activity-group-metrics-");
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
  expect(slow.p50Ms).toBe(9000);
  // The seed writes 100 in, 10 out, 50 cached per row.
  expect([fast.inputTokens, fast.outputTokens, fast.cacheReadTokens]).toEqual([400, 40, 200]);
  expect(slow.reasons.map((r) => r.reason)).toEqual(["boom"]);
});

test("a group's median is its own, not the window's", () => {
  const env = freshStoresEnv("md-activity-group-tails-");
  for (let i = 0; i < 25; i += 1) {
    seed(env.store.db, i, { ago: 1, ms: (i + 1) * 100, model: "measured" });
  }
  // One much slower call, in a group of its own so it moves the window's
  // percentiles without moving the group's. Without it the median below is
  // the same read off either set, and a group percentile taken from the whole
  // window renders a real number against the wrong name.
  seed(env.store.db, 25, { ago: 1, ms: 60_000, model: "outlier" });

  const summary = buildActivitySummary(env.store.db, 30, "model");
  const measured = summary.groups.find((g) => g.key.endsWith("measured"))!;
  // 100…2500 ascending: index 12.
  expect(measured.p50Ms).toBe(1300);
  // The day reads all twenty-six: a different median, and the pair says the
  // group's figure came from the group.
  const day = summary.daily.at(-1)!;
  expect([day.p50Ms, day.p95Ms]).toEqual([1400, 2500]);
});

test("a failure reason follows the key on every dimension, not just the row's own", () => {
  const env = freshStoresEnv("md-activity-group-reason-columns-");
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
    seed(env.store.db, 0, { ...a, status: "failed", error: boom });
    seed(env.store.db, 1, { ...b, status: "failed", error: boom });
    // `failed` comes off the scan and `reasons` off the second read, so
    // listing them together is what makes a collapse legible: the two
    // disagreeing is the symptom, one saying a failure happened here and the
    // other saying it happened somewhere else.
    return buildActivitySummary(env.store.db, 30, group).groups
      .map((g) => [g.key, g.failed, g.reasons]);
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
});

test("the fallback dimension separates the calls that were a retry on another candidate", () => {
  const env = freshStoresEnv("md-activity-group-fallback-");
  seed(env.store.db, 0, { ago: 1, ms: 500, model: "primary" });
  seed(env.store.db, 1, { ago: 1, ms: 500, model: "backup", fallback: true });
  seed(env.store.db, 2, { ago: 1, ms: 500, model: "backup", fallback: true });

  const byFallback = buildActivitySummary(env.store.db, 30, "fallback").groups;
  expect(byFallback.map((g) => [g.key, g.calls])).toEqual([["fallback", 2], ["primary", 1]]);
});

test("a call that recorded a fallback marker of false is not a fallback", () => {
  const env = freshStoresEnv("md-activity-group-fallback-false-");
  // `agent_compression` writes `fallbackAttempt: candidateIndex > 0`, so a
  // second attempt on the *first* candidate arrives with the key present and
  // false. Reading presence rather than truth would file it as a fallback to
  // a model that was never reached.
  seed(env.store.db, 0, { ago: 1, ms: 500, fallback: false });

  const groups = buildActivitySummary(env.store.db, 30, "fallback").groups;
  expect(groups.map((g) => [g.key, g.calls])).toEqual([["primary", 1]]);
});

test("days come back newest first, everything else by size", () => {
  const env = freshStoresEnv("md-activity-group-order-");
  // Sorting days by call count would put an ordinary Tuesday above yesterday.
  seed(env.store.db, 0, { ago: 3, ms: 500 });
  seed(env.store.db, 1, { ago: 3, ms: 500 });
  seed(env.store.db, 2, { ago: 1, ms: 500 });
  const days = buildActivitySummary(env.store.db, 30, "day").groups;
  expect(days.map((g) => g.calls)).toEqual([1, 2]);
});

test("a row with no scope type groups under a name rather than an empty cell", () => {
  const env = freshStoresEnv("md-activity-group-blank-");
  seed(env.store.db, 0, { ago: 1, ms: 500, scopeType: "" });
  const group = buildActivitySummary(env.store.db, 30, "scopeType").groups[0]!;
  // Both, because the label is what the reader sees and the key is what the
  // log filter is built from: a placeholder on one and a blank on the other
  // would show as an unnamed row or as a filter that matches nothing.
  expect([group.key, group.label]).toEqual(["(none)", "(none)"]);
});

// "Provider / model" is the provider's name from Settings, not the family of
// SDK it runs on: two connections serving one model are two rows. The log
// filter matches the same way.
test("the model grouping and the log filter use the provider's name", () => {
  const env = freshStoresEnv("md-activity-provider-name-");
  seed(env.store.db, 0, { ago: 1, ms: 1000, provider: "openai-compatible", providerName: "provider-1", model: "vendor/gpt" });
  seed(env.store.db, 1, { ago: 1, ms: 1000, provider: "openai-compatible", providerName: "kilo", model: "vendor/gpt" });
  const keys = buildActivitySummary(env.store.db, 30, "model").groups.map((g) => g.key).sort();
  expect(keys).toEqual(["kilo / vendor/gpt", "provider-1 / vendor/gpt"]);
  const ids = (provider: string) => llmCallDetails(env.store, 50, { provider, model: "vendor/gpt" }).map((c) => c.id).sort();
  expect(ids("kilo")).toEqual(["call_1"]);
  expect(ids("provider-1")).toEqual(["call_0"]);
});
