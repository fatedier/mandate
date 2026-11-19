import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ConfigFileError, configFileProblems } from "../src/server/config/file-check.js";
import { AGENT_ROUTES, JUDGEMENT_ROUTES } from "../src/server/config/model-resolution.js";
import { AGENT, ROUTES, TOP, fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

// config.json as a person or an agent writes it by hand: each value the
// server cannot use as written is a line naming the key, the rule and what
// was given; anything the file leaves out, sets to null or names under a key
// the server does not know is no error.

test("a value of the wrong type, out of range or not an option is a line naming the key", () => {
  expect(configFileProblems({ server: { port: "4777" }, logging: { level: "verbose" } })).toEqual([
    'server.port: must be a whole number from 0 to 65535 (it is "4777")',
    'logging.level: must be one of silent, error, warn, info, debug (it is "verbose")'
  ]);
  expect(configFileProblems({ panes: { pollIntervalMs: 100, captureLines: 19.5 }, server: { checkOrigin: "no" } })).toEqual([
    'server.checkOrigin: must be true or false (it is "no")',
    "panes.pollIntervalMs: must be a whole number from 500 to 2147483647 (it is 100)",
    "panes.captureLines: must be a whole number of at least 20 (it is 19.5)"
  ]);
  expect(configFileProblems({ runtime: { scheduleTickMs: 5, priceDataEveryMs: 2_592_000_000 } })).toEqual([
    "runtime.scheduleTickMs: must be a whole number from 100 to 2147483647 (it is 5)",
    "runtime.priceDataEveryMs: must be a whole number from 60000 to 2147483647 (it is 2592000000)"
  ]);
  expect(configFileProblems({ voice: { contextMessageCount: 500, idleTimeoutMs: -1 } })).toEqual([
    "voice.idleTimeoutMs: must be a whole number from 0 to 2147483647 (it is -1)",
    "voice.contextMessageCount: must be a whole number from 0 to 100 (it is 500)"
  ]);
  expect(configFileProblems({ retention: { chatRetentionDays: 0, chatToolResultHeadChars: "2000" } })).toEqual([
    "retention.chatRetentionDays: must be a whole number of at least 1 (it is 0)",
    'retention.chatToolResultHeadChars: must be a whole number of at least 200 (it is "2000")'
  ]);
  expect(configFileProblems({ agent: { logRequests: "all", compaction: { idle: { leadMinutes: 60 }, thresholdTokens: 10 } } })).toEqual([
    "agent.compaction.thresholdTokens: must be a whole number of at least 1000 (it is 10)",
    "agent.compaction.idle.leadMinutes: must be a whole number from 1 to 59 (it is 60)",
    'agent.logRequests: must be one of off, metadata, full (it is "all")'
  ]);
  expect(configFileProblems({ logging: "debug", skills: { extraDirs: "/srv/skills" } })).toEqual([
    'logging: must be an object (it is text)',
    "skills.extraDirs: must be a list of folder paths (it is text)"
  ]);
});

test("options are read as the loader reads them; null, a key left out and an unknown key are no error", () => {
  expect(configFileProblems({
    logging: { level: " DEBUG ", stacks: null },
    agent: null,
    pollIntervalMS: "a typo, ignored",
    models: { default: { model: "p/m", reasoningEffort: "High" }, providers: { p: { type: " OpenAI ", models: [{ id: "m", input: ["Image"] }] } } }
  })).toEqual([]);
  expect(configFileProblems({})).toEqual([]);
  expect(configFileProblems({ models: { providers: { p: { type: "openai", models: [{ id: "m", price: null, protocol: null }] } } } })).toEqual([]);
  // Inside a price too, as the README says of every key: a null rate is no rate.
  expect(configFileProblems({ models: { providers: { p: { type: "openai", models: [{ id: "m", price: { input: 1, output: 2, cacheRead: null, cacheWrite: null } }] } } } })).toEqual([]);
});

test("a route is an object and its fallbacks are objects; repeated fallbacks or no effort are fine", () => {
  expect(configFileProblems({
    models: { default: { model: "p/m", fallbacks: [{ model: "p/n" }, { model: "p/n" }] } },
    agent: { routes: { manager: { model: "" }, personal: { fallbacks: [] } } }
  })).toEqual([]);
  expect(configFileProblems({ agent: { routes: { worker: "p/m" } }, models: { default: { fallbacks: ["p/n"] } } })).toEqual([
    "models.default.fallbacks[0]: must be an object (it is text)",
    "agent.routes.worker: must be an object (it is text)"
  ]);
});

test("model refs, providers and their models", () => {
  expect(configFileProblems({ models: { default: { model: "gpt-5", reasoningEffort: "huge" } } })).toEqual([
    'models.default.model: must be provider/model (it is "gpt-5")',
    'models.default.reasoningEffort: must be one of provider-default, none, minimal, low, medium, high, xhigh, max (it is "huge")'
  ]);
  expect(configFileProblems({ agent: { routes: { worker: { fallbacks: { model: "p/m" } } } } }))
    .toEqual(["agent.routes.worker.fallbacks: must be a list (it is an object)"]);
  expect(configFileProblems({ models: { providers: { "my proxy": { type: "openai" }, q: {} } } })).toEqual([
    'models.providers["my proxy"]: is not a provider name (letters, digits, ".", "_" and "-")',
    "models.providers.q.type: must be one of openai, openai-compatible, kilo, codex, anthropic, google (it is missing)"
  ]);
  expect(configFileProblems({ models: { providers: { p: { type: "codex", serviceTier: "fast", billing: "monthly" } } } })).toEqual([
    'models.providers.p.serviceTier: must be one of "", priority, flex (it is "fast")',
    'models.providers.p.billing: must be one of usage, plan, free (it is "monthly")'
  ]);
  expect(configFileProblems({
    models: { providers: { p: { type: "openai-compatible", models: [
      { id: "m", input: ["text", "smell"], protocol: "soap", kind: "judge", cacheLifetimeMinutes: 1441, supportsReasoning: "yes" },
      { id: "m" },
      { id: "" },
      { id: "n", price: { input: 1 } }
    ] } } }
  })).toEqual([
    'models.providers.p.models[0].input[1]: must be one of text, image, audio, video, document (it is "smell")',
    'models.providers.p.models[0].supportsReasoning: must be true or false (it is "yes")',
    'models.providers.p.models[0].protocol: must be one of responses, chat, messages (it is "soap")',
    'models.providers.p.models[0].kind: must be "decision" (it is "judge")',
    "models.providers.p.models[0].cacheLifetimeMinutes: must be a whole number from 0 to 1440 (it is 1441)",
    "models.providers.p.models[2].id: must be text, not empty (it is empty)",
    'models.providers.p.models[3].price: must be { as: "litellm:<model>" } or { as: "models.dev:<provider>/<model>" } or input and output prices, each a number of USD per 1M tokens, 0 or more (it is an object)',
    "models.providers.p.models[1].id: is the same as an earlier model's"
  ]);
});

test("a provider's models written as one object, not a list, is a line, not a crash", () => {
  expect(configFileProblems({ models: { providers: { p: { type: "openai", models: { id: "gpt-5" } } } } }))
    .toEqual(["models.providers.p.models: must be a list (it is an object)"]);
});

test("an object where a shown value belongs is never shown: it may hold a secret", () => {
  expect(configFileProblems({
    notifications: { channels: [{ id: "c1", kind: "telegram", enabled: { botToken: "123456:ABCDEFsecret" } }] },
    models: { providers: { p: { type: { apiKey: "sk-live-abcdef" }, models: [{ id: "m", price: { input: 1 } }] } } }
  })).toEqual([
    "models.providers.p.type: must be one of openai, openai-compatible, kilo, codex, anthropic, google (it is an object)",
    'models.providers.p.models[0].price: must be { as: "litellm:<model>" } or { as: "models.dev:<provider>/<model>" } or input and output prices, each a number of USD per 1M tokens, 0 or more (it is an object)',
    "notifications.channels[0].enabled: must be true or false (it is an object)"
  ]);
});

test("a time a timer waits is at most 2^31 - 1 ms: more fires at once", () => {
  expect(configFileProblems({ panes: { pollIntervalMs: 3_000_000_000 }, voice: { maxSessionMs: 2_147_483_648 } })).toEqual([
    "panes.pollIntervalMs: must be a whole number from 500 to 2147483647 (it is 3000000000)",
    "voice.maxSessionMs: must be a whole number from 0 to 2147483647 (it is 2147483648)"
  ]);
});

test("every route the loader resolves is checked where the file keeps it", () => {
  for (const [route, path] of ROUTES) {
    const agent: Record<string, unknown> = {};
    let at = agent;
    for (const key of path.slice(0, -1)) at = (at[key] = {}) as Record<string, unknown>;
    at[path[path.length - 1]!] = { model: "no-slash", fallbacks: "x" };
    const where = `agent.${path.join(".")}`;
    expect([route, configFileProblems({ agent })]).toEqual([route, [
      `${where}.model: must be provider/model (it is "no-slash")`,
      `${where}.fallbacks: must be a list (it is text)`
    ]]);
  }
  expect(ROUTES.map(([route]) => route).sort()).toEqual([...AGENT_ROUTES, ...JUDGEMENT_ROUTES].sort());
});

test("every other key the table places in a group is checked where the file keeps it", () => {
  const at = (root: Record<string, unknown>, path: readonly string[], value: unknown) => {
    let node = root;
    for (const key of path.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
    node[path[path.length - 1]!] = value;
    return root;
  };
  // An object is no key's type here: each must give one line, at its own path.
  for (const [key, path] of TOP) {
    expect([key, configFileProblems(at({}, path, { wrong: true }))]).toEqual([key, [expect.stringMatching(new RegExp(`^${path.join("\\.")}: .*\\(it is an object\\)$`))]]);
  }
  for (const [key, path] of AGENT) {
    expect([key, configFileProblems({ agent: at({}, path, { wrong: true }) })]).toEqual([key, [expect.stringMatching(new RegExp(`^agent\\.${path.join("\\.")}: .*\\(it is an object\\)$`))]]);
  }
});

test("a null item in a list is named as null", () => {
  expect(configFileProblems({ skills: { extraDirs: [null] } })).toEqual(["skills.extraDirs[0]: must be a folder path (it is null)"]);
});

test("a secret given the wrong type is never shown", () => {
  expect(configFileProblems({
    models: { providers: { p: { type: "openai", apiKey: 123456789 } } },
    voice: { apiKey: true },
    webSearch: { kinds: { brave: { apiKey: 42 } } },
    notifications: { channels: [{ id: "c1", kind: "telegram", values: { botToken: 987654321 } }] }
  })).toEqual([
    "models.providers.p.apiKey: must be text (it is a number)",
    "webSearch.kinds.brave.apiKey: must be text (it is a number)",
    "notifications.channels[0].values.botToken: must be text (it is a number)",
    "voice.apiKey: must be text (it is true or false)"
  ]);
});

test("notifications, web search and the rest of the text fields", () => {
  expect(configFileProblems({
    notifications: { channels: [{ kind: "telegram" }, { id: "c2", kind: "", enabled: "on" }], desktopApp: 1 },
    webSearch: { use: 3, kinds: { brave: "key" } },
    agent: { personalAgentName: "x".repeat(41), preferences: ["be brief"] },
    server: { host: "" }
  })).toEqual([
    "server.host: must be a listen address (it is empty)",
    "agent.preferences: must be text (it is a list)",
    "agent.personalAgentName: must be text of at most 40 characters (it is text)",
    "webSearch.use: must be text (it is a number)",
    "webSearch.kinds.brave: must be an object (it is text)",
    "notifications.desktopApp: must be true or false (it is 1)",
    "notifications.channels[0].id: must be text, not empty (it is missing)",
    "notifications.channels[1].kind: must be text, not empty (it is empty)",
    'notifications.channels[1].enabled: must be true or false (it is "on")'
  ]);
});

test("a long value is cut where it is shown", () => {
  expect(configFileProblems({ logging: { level: "v".repeat(60) } }))
    .toEqual([`logging.level: must be one of silent, error, warn, info, debug (it is "${"v".repeat(39)}…)`]);
});

test("the README's example config and config.example.json pass", () => {
  const root = path.join(import.meta.dir, "..");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const examples = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!));
  expect(examples.length).toBeGreaterThan(0);
  examples.push(JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8")));
  for (const example of examples) {
    expect(configFileProblems(example)).toEqual([]);
    // In the grouped layout: an old flat key would not survive the round trip.
    expect(fileFromFlat(flatFromFile(example))).toEqual(example);
  }
});

test("the error names the file and lists the lines; a syntax error gives the parser's reason", () => {
  expect(ConfigFileError.invalid("/d/config.json", ["a: b", "c: d"]).message).toBe("/d/config.json has 2 errors:\n  a: b\n  c: d");
  expect(ConfigFileError.invalid("/d/config.json", ["a: b"]).message).toBe("/d/config.json has 1 error:\n  a: b");
  const syntax = ConfigFileError.syntax("/d/config.json", "Property name must be a string literal");
  expect([syntax.message, syntax.problems, syntax.file]).toEqual(["/d/config.json is not valid JSON: Property name must be a string literal", [], "/d/config.json"]);
});
