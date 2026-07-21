import { expect, test } from "bun:test";
import { Hono } from "hono";
import { ACTIVITY_GROUP_KEYS, type LlmCallDetailDto, type LlmCallsResponse } from "../src/shared/api-contracts.js";
import { activityModule } from "../src/server/modules/activity/module.js";
import { analysisModule } from "../src/server/modules/analysis/module.js";
import { stateModule } from "../src/server/modules/state/module.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

test("legacy call routes match current provider names without rewriting history", async () => {
  const env = freshStoresEnv("md-activity-provider-name-");
  const providers = {
    "llm-proxy": { type: "openai-compatible", baseURL: "https://proxy.example.test/v1/" },
    "other-protocol": { type: "anthropic", baseURL: "https://proxy.example.test/v1" },
    "duplicate-a": { type: "openai-compatible", baseURL: "https://shared.example.test/v1" },
    "duplicate-b": { type: "openai-compatible", baseURL: "https://shared.example.test/v1/" },
    "default-url": { type: "openai-compatible" }
  };
  try {
    const fixtures = [
      { baseURL: "https://proxy.example.test/v1", metadataJson: null, expected: "llm-proxy" },
      { baseURL: "https://proxy.example.test/v1/", metadataJson: { phase: "wake" }, expected: "llm-proxy" },
      { baseURL: "https://proxy.example.test/v1", metadataJson: { providerName: "original-name" }, expected: undefined },
      { baseURL: "https://proxy.example.test/v1", metadataJson: { providerName: "  " }, expected: "llm-proxy" },
      { baseURL: "https://proxy.example.test/v1", metadataJson: { providerName: 123 }, expected: "llm-proxy" },
      { baseURL: "https://shared.example.test/v1", metadataJson: null, expected: undefined },
      { baseURL: "https://unconfigured.example.test/v1", metadataJson: null, expected: undefined },
      { baseURL: undefined, metadataJson: null, expected: undefined }
    ].map(({ expected, ...input }) => {
      const started = env.store.startLlmCall({
        purpose: "agent_wake_step", provider: "openai-compatible", model: "codex/gpt-6-astra", ...input
      });
      return { expected, call: env.store.getLlmCall(started.id)! };
    });
    const app = new Hono();
    activityModule.mountRoutes?.(app, {
      deps: { store: env.store, config: { models: { providers } } } as any,
      upgradeWebSocket: null as any
    });
    const listRes = await app.request("/api/activity/calls?limit=20");
    expect(listRes.status).toBe(200);
    const { calls } = await listRes.json() as LlmCallsResponse;
    expect(calls.length).toBe(fixtures.length);
    for (const { call, expected } of fixtures) {
      const listed = calls.find((row) => row.id === call.id)!;
      const detailRes = await app.request(`/api/activity/calls/${encodeURIComponent(call.id)}`);
      expect(detailRes.status).toBe(200);
      const { call: detail } = await detailRes.json() as { call: LlmCallDetailDto };
      expect(listed.matchedProviderName).toBe(expected);
      expect(detail.matchedProviderName).toBe(expected);
      expect(listed.metadata).toEqual(call.metadata);
      expect(detail.metadata).toEqual(call.metadata);
      expect(env.store.getLlmCall(call.id)).toEqual(call);
    }
  } finally {
    env.cleanup();
  }
});

test("activity module mounts LLM call and summary routes", async () => {
  const env = freshStoresEnv("md-activity-module-");
  try {
    const started = env.store.startLlmCall({
      purpose: "agent_wake_step",
      scopeType: "agent_thread",
      scopeId: "thr-test",
      provider: "codex",
      model: "gpt-5.4-mini",
      requestJson: { messages: [{ role: "user", content: "wake" }] }
    });
    env.store.finishLlmCall(started.id, {
      status: "succeeded",
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5
    });

    const app = new Hono();
    activityModule.mountRoutes?.(app, { deps: { store: env.store } as any, upgradeWebSocket: null as any });

    const listRes = await app.request("/api/activity/calls?limit=5&purpose=agent_wake_step");
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { calls: Array<{ id: string; request: unknown }> };
    expect(listBody.calls.map((call) => call.id)).toEqual([started.id]);
    expect(listBody.calls[0]!.request).toBe(null);

    const detailRes = await app.request(`/api/activity/calls/${encodeURIComponent(started.id)}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json() as { call: { id: string; request: { messages: unknown[] } } };
    expect(detailBody.call.id).toBe(started.id);
    expect(detailBody.call.request.messages.length).toBe(1);

    const summaryRes = await app.request("/api/activity/summary?days=30");
    expect(summaryRes.status).toBe(200);
    const summaryBody = await summaryRes.json() as { days: number; buckets: unknown[] };
    expect(summaryBody.days).toBe(30);
    expect(summaryBody.buckets.length).toBe(5);

    // `/api/activity/calls/:id` owns its prefix, so the summary has to be a
    // sibling of it, not a child. And an unparseable window must not reach
    // `new Date(NaN)`, which throws on the way to an ISO string.
    const junkRes = await app.request("/api/activity/summary?days=abc");
    expect(junkRes.status).toBe(200);
    expect((await junkRes.json() as { days: number }).days).toBe(30);

    const clampedRes = await app.request("/api/activity/summary?days=9000");
    expect((await clampedRes.json() as { days: number }).days).toBe(90);

    // The grouping travels on its own parameter and the response says which one
    // it answered — a page that asked for one and rendered another would look
    // right and be wrong.
    const groupedRes = await app.request("/api/activity/summary?days=30&group=purpose");
    const grouped = await groupedRes.json() as { group: string; groups: Array<{ key: string }> };
    expect(grouped.group).toBe("purpose");
    expect(grouped.groups[0]!.key).toBe("agent_wake_step");

    // An unknown grouping falls back rather than 500ing a stale bookmark.
    const junkGroupRes = await app.request("/api/activity/summary?days=30&group=nonsense");
    expect(junkGroupRes.status).toBe(200);
    expect((await junkGroupRes.json() as { group: string }).group).toBe("model");

    // Every dimension the selector offers, not only the one above. Dropping one
    // from the shared list is a compile error now that the type is read off it,
    // but a `readGroup` that stopped honouring four of the five is not: each of
    // those pills would quietly answer with the `model` cut under its own
    // heading, and one valid value passing says nothing about its neighbours.
    const answered: string[] = [];
    for (const key of ACTIVITY_GROUP_KEYS) {
      const res = await app.request(`/api/activity/summary?days=30&group=${key}`);
      answered.push((await res.json() as { group: string }).group);
    }
    expect(answered).toEqual([...ACTIVITY_GROUP_KEYS]);
  } finally {
    env.cleanup();
  }
});

test("a finished call carries its first-token time back out again", async () => {
  const env = freshStoresEnv("md-activity-ttft-route-");
  try {
    const started = env.store.startLlmCall({
      purpose: "agent_wake_step",
      provider: "codex",
      model: "gpt-5.4-mini",
      requestJson: { messages: [] }
    });
    // Deliberately unlike the latency: the two are adjacent integer columns
    // written in one statement, and a swapped pair reads as a plausible call
    // rather than as anything obviously wrong.
    env.store.finishLlmCall(started.id, { status: "succeeded", latencyMs: 8000, ttftMs: 350 });

    const app = new Hono();
    activityModule.mountRoutes?.(app, { deps: { store: env.store } as any, upgradeWebSocket: null as any });

    const listRes = await app.request("/api/activity/calls?limit=5");
    const list = (await listRes.json() as { calls: Array<{ latencyMs: number; ttftMs: number }> }).calls;
    expect([list[0]!.latencyMs, list[0]!.ttftMs]).toEqual([8000, 350]);

    const detailRes = await app.request(`/api/activity/calls/${encodeURIComponent(started.id)}`);
    const detail = (await detailRes.json() as { call: { latencyMs: number; ttftMs: number } }).call;
    expect([detail.latencyMs, detail.ttftMs]).toEqual([8000, 350]);
  } finally {
    env.cleanup();
  }
});

test("a call that never reported a first token keeps a null, not a zero", async () => {
  const env = freshStoresEnv("md-activity-ttft-null-");
  try {
    const started = env.store.startLlmCall({ purpose: "agent_wake_step", provider: "codex" });
    env.store.finishLlmCall(started.id, { status: "failed", latencyMs: 1200 });

    const app = new Hono();
    activityModule.mountRoutes?.(app, { deps: { store: env.store } as any, upgradeWebSocket: null as any });
    const res = await app.request("/api/activity/calls?limit=5");
    const calls = (await res.json() as { calls: Array<{ ttftMs: number | null }> }).calls;
    // Null travels; a zero here would say the provider answered instantly on a
    // call it never answered at all.
    expect(calls[0]!.ttftMs).toBeNull();
  } finally {
    env.cleanup();
  }
});

test("the calls route reads both halves of the cursor", async () => {
  const env = freshStoresEnv("md-activity-cursor-");
  try {
    // Three calls in one millisecond. Seeded through SQL because startLlmCall
    // stamps its own `nowIso()`, and a shared timestamp is the whole point.
    const at = "2026-08-04T00:00:01.000Z";
    for (let i = 0; i < 3; i += 1) {
      env.store.db.prepare(`
        insert into llm_calls
          (id, purpose, provider, request_hash, response_hash, status,
           started_at, finished_at, latency_ms, created_at, updated_at)
        values (?, 'agent_wake_step', 'codex', 'rq', 'rs', 'succeeded', ?, ?, 100, ?, ?)
      `).run(`call_tied_${i}`, at, at, at, at);
    }

    const app = new Hono();
    activityModule.mountRoutes?.(app, { deps: { store: env.store } as any, upgradeWebSocket: null as any });

    const firstRes = await app.request("/api/activity/calls?limit=1");
    const first = (await firstRes.json() as { calls: Array<{ id: string; createdAt: string }> }).calls;
    expect(first.map((call) => call.id)).toEqual(["call_tied_2"]);

    // `beforeId` has to reach the store under that exact query key. Read from
    // the wrong key it arrives as null, the cursor silently degrades to the
    // timestamp alone, and the two rows sharing this millisecond are skipped —
    // a 200 with a short list, not an error.
    const nextRes = await app.request(
      `/api/activity/calls?limit=10&before=${encodeURIComponent(first[0]!.createdAt)}` +
      `&beforeId=${encodeURIComponent(first[0]!.id)}`
    );
    const next = (await nextRes.json() as { calls: Array<{ id: string }> }).calls;
    expect(next.map((call) => call.id)).toEqual(["call_tied_1", "call_tied_0"]);
  } finally {
    env.cleanup();
  }
});

/**
 * Every dimension a breakdown row can hand the log, against a fixture that
 * varies in each of them.
 *
 * The three metadata shapes are the point of the fallback rows: a literal
 * `false` (which one writer really records — `fallbackAttempt: candidateIndex >
 * 0` is false on a retry of the same candidate), a missing key, and a value
 * that will not parse at all. Presence and truth disagree on the first, and the
 * third is what `retention.ts` deliberately leaves behind — unguarded,
 * `json_extract` raises on it and the whole request dies.
 */
test("the calls route filters by the dimensions the breakdown links from", async () => {
  const env = freshStoresEnv("md-activity-newfilters-");
  try {
    const insert = (id: string, scope: string, createdAt: string, metadata: string | null) =>
      env.store.db.prepare(`
        insert into llm_calls
          (id, purpose, provider, scope_type, request_hash, response_hash, status,
           started_at, created_at, updated_at, metadata_json)
        values (?, 'agent_wake_step', 'codex', ?, 'rq', 'rs', 'succeeded', ?, ?, ?, ?)
      `).run(id, scope, createdAt, createdAt, createdAt, metadata);

    // Both edges of the day, so an off-by-one at either bound drops a row.
    insert("call_a", "memory", "2026-08-04T00:00:00.000Z", null);
    insert("call_b", "agent_thread", "2026-08-04T10:00:00.000Z", JSON.stringify({ fallbackAttempt: true }));
    insert("call_c", "memory", "2026-08-01T10:00:00.000Z", null);
    insert("call_d", "agent_thread", "2026-08-04T23:59:59.999Z", JSON.stringify({ fallbackAttempt: false }));
    insert("call_e", "agent_thread", "2026-08-04T12:00:00.000Z", JSON.stringify({ phase: "planning" }));
    insert("call_f", "memory", "2026-08-05T00:00:00.000Z", "{not json");

    const app = new Hono();
    activityModule.mountRoutes?.(app, { deps: { store: env.store } as any, upgradeWebSocket: null as any });
    const ids = async (query: string) => {
      const res = await app.request(`/api/activity/calls?limit=10&${query}`);
      expect(res.status).toBe(200);
      return (await res.json() as { calls: Array<{ id: string }> }).calls.map((c) => c.id).sort();
    };

    expect(await ids("scopeType=memory")).toEqual(["call_a", "call_c", "call_f"]);
    // Truth, not presence: `call_d` carries the key with a literal false and is
    // a primary call. On the real store that distinction is 8 rows of 911.
    expect(await ids("fallback=1")).toEqual(["call_b"]);
    expect(await ids("fallback=0")).toEqual(["call_a", "call_c", "call_d", "call_e", "call_f"]);
    // A day is a closed range over both edges, and the row a millisecond past
    // midnight belongs to the next one.
    expect(await ids("day=2026-08-04")).toEqual(["call_a", "call_b", "call_d", "call_e"]);
    // The day arrives from a url, so it must be compared rather than matched:
    // under `like` this pattern is every day of the month, and `_` is the one
    // wildcard a date-shaped string can carry without looking wrong.
    expect(await ids("day=2026-08-0_")).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("analysis module mounts window inspect route", async () => {
  const forced: string[][] = [];
  const snapshot = { sessions: [] };
  const app = new Hono();
  analysisModule.mountRoutes?.(app, {
    deps: {
      poller: {
        getSnapshot: () => snapshot
      },
      pollTmux: async (opts: { forceWindowIds?: string[] }) => {
        forced.push(opts.forceWindowIds ?? []);
      }
    } as any,
    upgradeWebSocket: null as any
  });

  const res = await app.request("/api/windows/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ windowId: "md:1" })
  });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, snapshot });
  // Forces one poll of this window and nothing else. It used to also pin the
  // window into the poller's forced set, which was add-only and therefore grew
  // for the life of the process; `pinWindow` no longer exists.
  expect(forced).toEqual([["md:1"]]);
});

test("state module mounts state and info routes", async () => {
  const snapshot = { sessions: [{ name: "md-test" }] };
  const projects = [{ id: "p1", name: "mandate" }];
  const app = new Hono();
  stateModule.mountRoutes?.(app, {
    deps: {
      poller: {
        getSnapshot: () => snapshot,
        getLastError: () => "last error"
      },
      getProjectsState: () => projects,
      analyzer: {
        getInfo: () => ({
          provider: "codex",
          model: "gpt-5.4-mini",
          enabled: true,
          maxConcurrent: 2,
          minAnalysisIntervalMs: 1000,
          changeDebounceMs: 200,
          maxChangeDebounceMs: 1000,
          queueDepth: 0,
          running: 1
        })
      },
      config: {
        port: 49848,
        pollIntervalMs: 1000,
        captureLines: 200,
        voice: {
          providerType: "openai",
          provider: "openai",
          model: "gpt-realtime",
          voice: "alloy",
          language: "zh",
          idleTimeoutMs: 30000,
          maxSessionMs: 600000,
          apiKey: "test-key",
          baseURL: "https://api.openai.com/v1",
          deployment: null
        }
      }
    } as any,
    upgradeWebSocket: null as any
  });

  const stateRes = await app.request("/api/state");
  expect(stateRes.status).toBe(200);
  expect(await stateRes.json()).toEqual({ snapshot, error: "last error", projects });

  const infoRes = await app.request("/api/info");
  expect(infoRes.status).toBe(200);
  expect(infoRes.headers.get("Cache-Control")).toBe("no-store");
  const info = await infoRes.json() as {
    server: { port: number };
    voice: { configured: boolean };
  };
  expect(info.server.port).toBe(49848);
  expect(info.voice.configured).toBe(true);
});

test("info readiness checks return no body without loading config or voice auth", async () => {
  const app = new Hono();
  stateModule.mountRoutes?.(app, {
    deps: {
      get config() { throw new Error("Readiness must not read config or voice auth"); }
    } as any,
    upgradeWebSocket: null as any
  });
  const response = await app.request("/api/info", { method: "HEAD" });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBeNull();
});
