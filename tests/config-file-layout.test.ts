import { expect, test } from "bun:test";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

// config.json groups its keys (server, panes, agent.routes, agent.checks …);
// the app and the Settings API keep their flat keys. One table maps the two.

const FLAT = {
  port: 4175,
  host: "127.0.0.1",
  checkOrigin: false,
  pollIntervalMs: 2000,
  captureLines: 120,
  runtime: { scheduleTickMs: 200 },
  logging: { level: "warn" },
  models: {
    default: { model: "p/a", reasoningEffort: "high", modelFallbacks: [{ model: "p/b" }] },
    providers: { p: { type: "openai", apiKey: "sk-test" } },
    prices: { autoUpdate: false }
  },
  agent: {
    preferences: "Be brief.",
    managerModel: { model: "p/a", reasoningEffort: "high" },
    managerModelFallbacks: [{ model: "p/b" }],
    workerModel: { model: "p/c" },
    personalModel: { model: "p/g" },
    dreamModel: { model: "p/dr" },
    extractionModelFallbacks: [],
    subagentModelFallbacks: [{ model: "p/d" }],
    pageModel: { model: "p/pg", reasoningEffort: "low" },
    decisionsEnabled: true,
    decisionsModel: { model: "p/j" },
    decisionsModelFallbacks: [{ model: "p/j2" }],
    managerRequestCheckEnabled: false,
    managerStopCheckEnabled: true,
    managerStopCheckModel: { model: "p/k" },
    memoryRepeatCheckEnabled: true,
    memoryRepeatCheckModelFallbacks: [{ model: "p/m" }],
    toolReviewEnabled: true,
    toolReviewRules: "Ask first.",
    toolReviewScreenModel: { model: "p/s" },
    toolReviewSecondLookModelFallbacks: [{ model: "p/t" }],
    compressionThresholdTokens: 150000,
    idleCompactionEnabled: false,
    idleCompactionLeadMinutes: 10,
    idleCompactionMinTokens: 50000,
    logRequests: "full",
    personalAgentName: "Ada"
  },
  memory: { embedding: { model: "p/e" }, dream: { enabled: false } },
  voice: { provider: "openai", contextMessageCount: 3 }
};

const FILE = {
  server: { port: 4175, host: "127.0.0.1", checkOrigin: false },
  panes: { pollIntervalMs: 2000, captureLines: 120 },
  runtime: { scheduleTickMs: 200 },
  logging: { level: "warn" },
  models: {
    default: { model: "p/a", reasoningEffort: "high", fallbacks: [{ model: "p/b" }] },
    providers: { p: { type: "openai", apiKey: "sk-test" } },
    prices: { autoUpdate: false }
  },
  agent: {
    preferences: "Be brief.",
    logRequests: "full",
    personalAgentName: "Ada",
    routes: {
      manager: { model: "p/a", reasoningEffort: "high", fallbacks: [{ model: "p/b" }] },
      worker: { model: "p/c" },
      personal: { model: "p/g" },
      dream: { model: "p/dr" },
      extraction: { fallbacks: [] },
      subagent: { fallbacks: [{ model: "p/d" }] },
      page: { model: "p/pg", reasoningEffort: "low" }
    },
    decisions: { enabled: true, model: "p/j", fallbacks: [{ model: "p/j2" }] },
    checks: {
      managerRequest: { enabled: false },
      managerStop: { enabled: true, model: "p/k" },
      memoryRepeat: { enabled: true, fallbacks: [{ model: "p/m" }] }
    },
    toolReview: { enabled: true, rules: "Ask first.", screen: { model: "p/s" }, secondLook: { fallbacks: [{ model: "p/t" }] } },
    compaction: { thresholdTokens: 150000, idle: { enabled: false, leadMinutes: 10, minTokens: 50000 } }
  },
  memory: { embedding: { model: "p/e" }, dream: { enabled: false } },
  voice: { provider: "openai", contextMessageCount: 3 }
};

test("every flat key has its place in the file, and comes back from it", () => {
  expect(fileFromFlat(FLAT)).toEqual(FILE);
  expect(flatFromFile(FILE)).toEqual(FLAT);
  expect(flatFromFile(fileFromFlat(FLAT))).toEqual(FLAT);
});

test("nothing is written for a key that is not set, and the inputs are left as they were", () => {
  expect(fileFromFlat({})).toEqual({});
  expect(flatFromFile({})).toEqual({});
  expect(fileFromFlat({ agent: { preferences: "x" }, models: { providers: {} } })).toEqual({ agent: { preferences: "x" }, models: { providers: {} } });
  const flat = structuredClone(FLAT);
  const file = structuredClone(FILE);
  fileFromFlat(flat);
  flatFromFile(file);
  expect([flat, file]).toEqual([FLAT, FILE]);
});

test("a key the table does not know stays where it is, at the top and in agent", () => {
  const file = { futureSection: { a: 1 }, agent: { futureKey: true, routes: { worker: { model: "p/c" } } } };
  expect(flatFromFile(file)).toEqual({ futureSection: { a: 1 }, agent: { futureKey: true, workerModel: { model: "p/c" } } });
  expect(fileFromFlat(flatFromFile(file))).toEqual(file);
});

test("an old flat key left in a grouped file is not read", () => {
  expect(flatFromFile({
    port: 1,
    pollIntervalMs: 9,
    server: { port: 4175 },
    models: { default: { modelFallbacks: [{ model: "p/old" }], fallbacks: [{ model: "p/new" }] } },
    agent: { workerModel: { model: "p/old" }, decisionsEnabled: true, compressionThresholdTokens: 1, routes: { worker: { model: "p/new" } } }
  })).toEqual({
    port: 4175,
    models: { default: { modelFallbacks: [{ model: "p/new" }] } },
    agent: { workerModel: { model: "p/new" } }
  });
});

test("a route written as a bare ref in the flat form is a route with that model", () => {
  expect(fileFromFlat({ agent: { workerModel: "p/c" } })).toEqual({ agent: { routes: { worker: { model: "p/c" } } } });
});

test("a blank or null model is a route not set, as an unset route reads", () => {
  expect(fileFromFlat({ agent: { managerStopCheckModel: "", workerModel: "  " } })).toEqual({ agent: {} });
  expect(flatFromFile({ agent: { checks: { managerStop: { model: null, reasoningEffort: null } }, routes: { worker: { model: null, fallbacks: null } } } }))
    .toEqual({ agent: {} });
  // An object with an empty model is a route set to nothing, as before.
  expect(flatFromFile({ agent: { routes: { worker: { model: "" } } } })).toEqual({ agent: { workerModel: { model: "" } } });
});

test("fallbacks written as bare refs in the flat form are fallback objects in the file", () => {
  expect(fileFromFlat({ agent: { managerModelFallbacks: ["p/b", { model: "p/c" }] }, models: { default: { modelFallbacks: ["p/d"] } } })).toEqual({
    agent: { routes: { manager: { fallbacks: [{ model: "p/b" }, { model: "p/c" }] } } },
    models: { default: { fallbacks: [{ model: "p/d" }] } }
  });
});
