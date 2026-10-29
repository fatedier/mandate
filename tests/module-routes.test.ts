import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { ACTIVITY_GROUP_KEYS, type LlmCallDetailDto, type LlmCallsResponse, type ProjectStateDto } from "../src/shared/api-contracts.js";
import { activityModule } from "../src/server/modules/activity/module.js";
import { analysisModule } from "../src/server/modules/analysis/module.js";
import { stateModule } from "../src/server/modules/state/module.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import type { AppDeps } from "../src/server/app/deps.js";
import type { Config, ProviderConfig } from "../src/server/config/types.js";
import type { TmuxPoller } from "../src/server/runtime/tmux-poller.js";
import type { TmuxSnapshot } from "../src/server/platform/tmux/tmux-types.js";

const { upgradeWebSocket } = createBunWebSocket();

test("a call's provider name is the one it was recorded under: none is guessed from today's settings", async () => {
  const env = freshStoresEnv("md-activity-provider-name-");
  const providers = {
    "team-proxy": stub<ProviderConfig>({ type: "openai-compatible", baseURL: "https://proxy.example.test/v1" })
  };
  try {
    const named = env.store.startLlmCall({ purpose: "agent_wake_step", provider: "openai-compatible", providerName: "team-proxy", model: "codex/gpt-6-astra", baseURL: "https://proxy.example.test/v1" });
    // Recorded without a name, at the address of a configured connection.
    const unnamed = env.store.startLlmCall({ purpose: "agent_wake_step", provider: "openai-compatible", model: "codex/gpt-6-astra", baseURL: "https://proxy.example.test/v1" });
    const app = new Hono();
    activityModule.mountRoutes?.(app, {
      deps: stub<AppDeps>({ store: env.store, config: stub<Config>({ models: stub<Config["models"]>({ providers }) }) }),
      upgradeWebSocket
    });
    const { calls } = await (await app.request("/api/activity/calls?limit=20")).json() as LlmCallsResponse;
    const detail = async (id: string) => ((await (await app.request(`/api/activity/calls/${encodeURIComponent(id)}`)).json()) as { call: LlmCallDetailDto }).call;
    expect(calls.find((row) => row.id === named.id)?.providerName).toBe("team-proxy");
    expect(calls.find((row) => row.id === unnamed.id)?.providerName).toBeNull();
    expect((await detail(named.id)).providerName).toBe("team-proxy");
    expect((await detail(unnamed.id)).providerName).toBeNull();
  } finally {
    env.cleanup();
  }
});

test("activity module mounts LLM call and summary routes", async () => {
  const env = freshStoresEnv("md-activity-module-");
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
  activityModule.mountRoutes?.(app, { deps: stub<AppDeps>({ store: env.store }), upgradeWebSocket });

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
  expect(answered).toStrictEqual([...ACTIVITY_GROUP_KEYS]);
});

test("a finished call carries its first-token time back out again", async () => {
  const env = freshStoresEnv("md-activity-ttft-route-");
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
  activityModule.mountRoutes?.(app, { deps: stub<AppDeps>({ store: env.store }), upgradeWebSocket });

  const listRes = await app.request("/api/activity/calls?limit=5");
  const list = (await listRes.json() as { calls: Array<{ latencyMs: number; ttftMs: number }> }).calls;
  expect([list[0]!.latencyMs, list[0]!.ttftMs]).toEqual([8000, 350]);

  const detailRes = await app.request(`/api/activity/calls/${encodeURIComponent(started.id)}`);
  const detail = (await detailRes.json() as { call: { latencyMs: number; ttftMs: number } }).call;
  expect([detail.latencyMs, detail.ttftMs]).toEqual([8000, 350]);
});

test("a call that never reported a first token keeps a null, not a zero", async () => {
  const env = freshStoresEnv("md-activity-ttft-null-");
  const started = env.store.startLlmCall({ purpose: "agent_wake_step", provider: "codex" });
  env.store.finishLlmCall(started.id, { status: "failed", latencyMs: 1200 });

  const app = new Hono();
  activityModule.mountRoutes?.(app, { deps: stub<AppDeps>({ store: env.store }), upgradeWebSocket });
  const res = await app.request("/api/activity/calls?limit=5");
  const calls = (await res.json() as { calls: Array<{ ttftMs: number | null }> }).calls;
  // Null travels; a zero here would say the provider answered instantly on a
  // call it never answered at all.
  expect(calls[0]!.ttftMs).toBeNull();
});

test("the calls route reads both halves of the cursor", async () => {
  const env = freshStoresEnv("md-activity-cursor-");
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
  activityModule.mountRoutes?.(app, { deps: stub<AppDeps>({ store: env.store }), upgradeWebSocket });

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
  activityModule.mountRoutes?.(app, { deps: stub<AppDeps>({ store: env.store }), upgradeWebSocket });
  const ids = async (query: string) => {
    const res = await app.request(`/api/activity/calls?limit=10&${query}`);
    expect(res.status).toBe(200);
    return (await res.json() as { calls: Array<{ id: string }> }).calls.map((c) => c.id).sort();
  };

  expect(await ids("scopeType=memory")).toEqual(["call_a", "call_c", "call_f"]);
  // Truth, not presence: `call_d` carries the key with a literal false and is
  // a primary call.
  expect(await ids("fallback=1")).toEqual(["call_b"]);
  expect(await ids("fallback=0")).toEqual(["call_a", "call_c", "call_d", "call_e", "call_f"]);
  // A day is a closed range over both edges, and the row a millisecond past
  // midnight belongs to the next one.
  expect(await ids("day=2026-08-04")).toEqual(["call_a", "call_b", "call_d", "call_e"]);
  // The day arrives from a url, so it must be compared rather than matched:
  // under `like` this pattern is every day of the month, and `_` is the one
  // wildcard a date-shaped string can carry without looking wrong.
  expect(await ids("day=2026-08-0_")).toEqual([]);
});

test("analysis module mounts window inspect route", async () => {
  const forced: string[][] = [];
  const snapshot = stub<TmuxSnapshot>({ sessions: [] });
  const app = new Hono();
  analysisModule.mountRoutes?.(app, {
    deps: stub<AppDeps>({
      poller: stub<TmuxPoller>({
        getSnapshot: () => snapshot
      }),
      pollTmux: async (opts: { forceWindowIds?: string[] }) => {
        forced.push(opts.forceWindowIds ?? []);
      }
    }),
    upgradeWebSocket
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
  expect(forced).toStrictEqual([["md:1"]]);
});

test("state module mounts state and info routes", async () => {
  const snapshot = stub<TmuxSnapshot>({ sessions: [stub<TmuxSnapshot["sessions"][number]>({ sessionName: "md-test" })] });
  const projects = [stub<ProjectStateDto>({ id: "p1", name: "mandate" })];
  // The poller's own shape for its last failure.
  const lastError = { message: "tmux unavailable", at: "2026-10-03T00:00:00.000Z" };
  const app = new Hono();
  stateModule.mountRoutes?.(app, {
    deps: stub<AppDeps>({
      poller: stub<TmuxPoller>({
        getSnapshot: () => snapshot,
        getLastError: () => lastError
      }),
      getProjectsState: () => projects,
      config: stub<Config>({
        port: 49848,
        pollIntervalMs: 1000,
        captureLines: 200,
        voice: stub<Config["voice"]>({
          providerType: "openai",
          provider: "openai",
          model: "gpt-realtime",
          voice: "alloy",
          language: "zh",
          idleTimeoutMs: 30000,
          maxSessionMs: 600000,
          apiKey: "test-key",
          baseURL: "https://api.openai.com/v1"
        })
      })
    }),
    upgradeWebSocket
  });

  const stateRes = await app.request("/api/state");
  expect(stateRes.status).toBe(200);
  expect(await stateRes.json()).toEqual({ snapshot, error: lastError, projects });

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
    // Deliberately not stub(): it reads every member it is given, and this
    // getter throws when read.
    deps: {
      get config() { throw new Error("Readiness must not read config or voice auth"); }
    } as any,
    upgradeWebSocket
  });
  const response = await app.request("/api/info", { method: "HEAD" });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBeNull();
});
