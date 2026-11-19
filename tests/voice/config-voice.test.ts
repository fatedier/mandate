import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../src/server/config.js";
import { DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT } from "../../src/shared/settings.js";
import { tempDir } from "../helpers/temp.js";
import { configFileProblems } from "../../src/server/config/file-check.js";

/** loadConfig over a fresh data dir holding `config` as config.json (none
 *  when omitted). */
function load(config?: unknown) {
  const dir = tempDir("md-voice-cfg-");
  if (config !== undefined) fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return loadConfig(dir);
}

test("loadConfig: voice block has default values when not set", () => {
  const cfg = load();
  expect(cfg.voice.provider).toBe("openai");
  expect(cfg.voice.apiKey).toBe("");
  expect(cfg.voice.model).toBe("gpt-realtime-mini");
  expect(cfg.voice.voice).toBe("marin");
  expect(cfg.voice.language).toBe("auto");
  expect(cfg.voice.idleTimeoutMs).toBe(5 * 60 * 1000);
  expect(cfg.voice.maxSessionMs).toBe(25 * 60 * 1000);
});

test("loadConfig: voice block reads file overrides", () => {
  const cfg = load({
    voice: {
      apiKey: "sk-test",
      model: "gpt-realtime",
      voice: "sage",
      language: "zh",
      idleTimeoutMs: 60000,
      maxSessionMs: 120000
    }
  });
  expect(cfg.voice.apiKey).toBe("sk-test");
  expect(cfg.voice.model).toBe("gpt-realtime");
  expect(cfg.voice.voice).toBe("sage");
  expect(cfg.voice.language).toBe("zh");
  expect(cfg.voice.idleTimeoutMs).toBe(60000);
  expect(cfg.voice.maxSessionMs).toBe(120000);
});

test("loadConfig: voice provider can use a configured OpenAI provider name", () => {
  const cfg = load({
    models: {
      providers: {
        work: { type: "openai", apiKey: "sk-work" }
      }
    },
    voice: {
      provider: "work",
      model: "gpt-realtime-mini"
    }
  });
  expect(cfg.voice.provider).toBe("work");
  expect(cfg.voice.providerName).toBe("work");
  expect(cfg.voice.providerType).toBe("openai");
  expect(cfg.voice.apiKey).toBe("sk-work");
});

test("loadConfig: voice provider can use a configured OpenAI Codex provider name", () => {
  const cfg = load({
    models: {
      providers: {
        codex: { type: "codex" }
      }
    },
    voice: {
      provider: "codex",
      baseURL: "wss://stale.azure.example/openai/v1/realtime",
      deployment: "stale-deployment"
    }
  });
  expect(cfg.voice.provider).toBe("codex");
  expect(cfg.voice.providerName).toBe("codex");
  expect(cfg.voice.providerType).toBe("codex");
  expect(cfg.voice.apiKey).toBe("");
  expect(cfg.voice.model).toBe("gpt-realtime-1.5");
  expect(cfg.voice.baseURL).toBe("");
  expect(cfg.voice.deployment).toBe("");
});

// "codex" names a provider, as any other name does: it is not a type that
// picks one of the Codex connections.
test("loadConfig: a voice provider of codex with no provider by that name is OpenAI's own", () => {
  const cfg = load({
    models: { providers: { "work-codex": { type: "codex" } } },
    voice: { provider: "codex", apiKey: "sk-voice" }
  });
  expect([cfg.voice.provider, cfg.voice.providerName, cfg.voice.providerType]).toEqual(["openai", "", "openai"]);
});

// The save used to write a provider's name lowercased ("Codex" as "codex"):
// such a config still names its provider.
test("loadConfig: a voice provider saved lowercased still names its provider", () => {
  const cfg = load({
    models: { providers: { Codex: { type: "codex" } } },
    voice: { provider: "codex" }
  });
  expect([cfg.voice.provider, cfg.voice.providerName, cfg.voice.providerType]).toEqual(["Codex", "Codex", "codex"]);
  // "openai" stays OpenAI's own realtime API, whatever a provider is named.
  const own = load({ models: { providers: { OpenAI: { type: "openai", apiKey: "sk-p" } } }, voice: { provider: "openai", apiKey: "sk-voice" } });
  expect([own.voice.providerName, own.voice.providerType]).toEqual(["", "openai"]);
});

test("loadConfig: invalid timeouts are refused", () => {
  expect(configFileProblems({ voice: { idleTimeoutMs: -1, maxSessionMs: "bad" } })).toEqual([
    "voice.idleTimeoutMs: must be a whole number from 0 to 2147483647 (it is -1)",
    'voice.maxSessionMs: must be a whole number from 0 to 2147483647 (it is "bad")'
  ]);
});

test.each([
  { name: "defaults to the shared default", config: undefined, expected: DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT },
  { name: "reads the file's", config: { voice: { contextMessageCount: 5 } }, expected: 5 },
  { name: "takes 100", config: { voice: { contextMessageCount: 100 } }, expected: 100 }
])("loadConfig: voice.contextMessageCount $name", ({ config, expected }) => {
  expect(load(config).voice.contextMessageCount).toBe(expected);
});

test("loadConfig: voice.contextMessageCount outside 0 to 100 is refused", () => {
  expect([-1, 500].map((contextMessageCount) => configFileProblems({ voice: { contextMessageCount } }))).toEqual([
    ["voice.contextMessageCount: must be a whole number from 0 to 100 (it is -1)"],
    ["voice.contextMessageCount: must be a whole number from 0 to 100 (it is 500)"]
  ]);
});

test("loadConfig: the environment changes nothing in the voice section", () => {
  const env: Record<string, string> = {
    MANDATE_VOICE_API_KEY: "sk-env",
    MANDATE_VOICE_PROVIDER: "openai",
    MANDATE_VOICE_MODEL: "env-model",
    MANDATE_VOICE_VOICE: "env-voice",
    MANDATE_VOICE_LANGUAGE: "fr",
    MANDATE_VOICE_BASE_URL: "https://env.example/v1",
    MANDATE_VOICE_DEPLOYMENT: "env-deployment",
    MANDATE_VOICE_CONTEXT_MESSAGES: "20"
  };
  const file = { voice: { contextMessageCount: 5 } };
  const without = load(file).voice;
  const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    expect(load(file).voice).toEqual(without);
    expect(without.contextMessageCount).toBe(5);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
