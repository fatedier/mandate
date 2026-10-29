import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, type Config } from "../src/server/config.js";
import { dropIdleClockOnVoice, idleCompactorDeps } from "../src/server/runtime/idle-compactor-deps.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import type { WakeLlmCandidate } from "../src/server/modules/agent/wake-llm-attempts.js";
import { onCleanup } from "./helpers/cleanup.js";

// What the runtime hands the idle clock: the live config's switch and
// numbers, each model's typed cache lifetime by its connection and id, the
// thread's state, and its pending alarms.

function configWith(agent: Record<string, unknown>): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-idle-deps-"));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    agent,
    models: {
      default: { model: "gw/openai/gpt-6.1-sol" },
      providers: {
        gw: { type: "openai-compatible", apiKey: "test-key", baseURL: "https://gw.example.test/v1", models: [
          { id: "openai/gpt-6.1-sol", input: ["text"], cacheLifetimeMinutes: 45 },
          { id: "deepseek/deepseek-v4-flash", input: ["text"], cacheLifetimeMinutes: 0 },
          { id: "anthropic/claude-sonnet-5-5", input: ["text"], protocol: "messages" }
        ] }
      }
    }
  }));
  return loadConfig(dir);
}

const candidate = (providerName: string, model: string): WakeLlmCandidate =>
  ({ model: { provider: "mock", modelId: model } as never, meta: { providerName, model } });

function deps(config: { current: Config }, opts: {
  threads?: Record<string, { archivedAt: string | null; scope: string; scopeId: string | null }>;
  features?: Record<string, { archivedAt: string | null }>;
  alarms?: Record<string, string[]>;
} = {}) {
  return idleCompactorDeps({
    config: () => config.current,
    agentStore: { getThreadById: (id: string) => (opts.threads?.[id] ?? null) as never },
    featuresStore: { getById: (id: string) => (opts.features?.[id] ?? null) as never },
    alarms: { list: (threadId: string) => (opts.alarms?.[threadId] ?? []).map((fireAt) => ({ fireAt })) as never },
    stepPromptFor: async () => { throw new Error("not used here"); },
    compact: () => "nothing"
  });
}

test("the settings are read from the config as it is now; on only when true", () => {
  const config = { current: configWith({ idleCompactionLeadMinutes: 10, idleCompactionMinTokens: 150_000 }) };
  const d = deps(config);
  expect(d.settings()).toEqual({ enabled: true, leadMinutes: 10, minTokens: 150_000 });
  config.current = configWith({ idleCompactionEnabled: false });
  expect(d.settings()).toEqual({ enabled: false, leadMinutes: 5, minTokens: 200_000 });
});

test("a model's typed lifetime is found by its connection and id, 0 included; none typed, none", () => {
  const d = deps({ current: configWith({}) });
  expect([
    d.typedLifetime(candidate("gw", "openai/gpt-6.1-sol")),
    d.typedLifetime(candidate("gw", "deepseek/deepseek-v4-flash")),
    d.typedLifetime(candidate("gw", "anthropic/claude-sonnet-5-5")),
    d.typedLifetime(candidate("other", "openai/gpt-6.1-sol"))
  ]).toEqual([45, 0, undefined, undefined]);
});

test("an alarm due by the cache's expiry is found; a later one or none is not", () => {
  const d = deps({ current: configWith({}) }, { alarms: { thr_a: ["2026-10-29T10:50:00.000Z"], thr_b: ["2026-10-29T11:10:00.000Z"] } });
  const expiry = Date.parse("2026-10-29T11:00:00.000Z");
  expect([d.alarmDueBy("thr_a", expiry), d.alarmDueBy("thr_b", expiry), d.alarmDueBy("thr_c", expiry)]).toEqual([true, false, false]);
});

test("a manager thread is compactable; a gone or archived thread, or a worker of an archived feature, is not", () => {
  const d = deps({ current: configWith({}) }, {
    threads: {
      thr_m: { archivedAt: null, scope: "manager", scopeId: null },
      thr_old: { archivedAt: "2026-10-28T00:00:00.000Z", scope: "manager", scopeId: null },
      thr_w: { archivedAt: null, scope: "worker", scopeId: "feat_live" },
      thr_r: { archivedAt: null, scope: "worker", scopeId: "feat_done" }
    },
    features: { feat_live: { archivedAt: null }, feat_done: { archivedAt: "2026-10-28T00:00:00.000Z" } }
  });
  expect(["thr_m", "thr_old", "thr_w", "thr_r", "thr_gone"].map((id) => d.threadCompactable(id))).toEqual([true, false, true, false, false]);
});

// A voice line is written to the thread with no model call, so the clock
// would not see someone talking; it drops the thread's clock as a call does,
// and a summary never hides lines it did not read.
test("a voice line drops its thread's idle clock; a typed message, another event, or a line after stop does not", () => {
  const sse = new AgentSseEmitter();
  const dropped: string[] = [];
  const stop = dropIdleClockOnVoice(sse, { noteCallStarted: (threadId) => { dropped.push(threadId); } });
  const appended = (threadId: string, source: string) =>
    sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message: { id: `m_${source}`, threadId, source } } as never);
  appended("thr_global", "voice");
  appended("thr_global", "user");
  sse.emit(SSE_EVENTS.agentCompressionStarted, { threadId: "thr_global" } as never);
  stop();
  appended("thr_other", "voice");
  expect(dropped).toEqual(["thr_global"]);
});
