import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../src/server/config.js";
import { DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT } from "../../src/shared/settings.js";
import { tempDir } from "../helpers/temp.js";

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

test("loadConfig: invalid timeouts fall back to defaults", () => {
  const cfg = load({
    voice: { idleTimeoutMs: -1, maxSessionMs: "bad" }
  });
  expect(cfg.voice.idleTimeoutMs).toBe(5 * 60 * 1000);
  expect(cfg.voice.maxSessionMs).toBe(25 * 60 * 1000);
});

test.each([
  { name: "defaults to the shared default", config: undefined, expected: DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT },
  { name: "reads the file's", config: { voice: { contextMessageCount: 5 } }, expected: 5 },
  { name: "falls back to the default when invalid", config: { voice: { contextMessageCount: -1 } }, expected: DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT },
  { name: "clamps to 100 at most", config: { voice: { contextMessageCount: 500 } }, expected: 100 }
])("loadConfig: voice.contextMessageCount $name", ({ config, expected }) => {
  expect(load(config).voice.contextMessageCount).toBe(expected);
});

test("loadConfig: MANDATE_VOICE_CONTEXT_MESSAGES env overrides file", () => {
  const old = process.env.MANDATE_VOICE_CONTEXT_MESSAGES;
  process.env.MANDATE_VOICE_CONTEXT_MESSAGES = "20";
  try {
    expect(load({ voice: { contextMessageCount: 5 } }).voice.contextMessageCount).toBe(20);
  } finally {
    if (old === undefined) delete process.env.MANDATE_VOICE_CONTEXT_MESSAGES;
    else process.env.MANDATE_VOICE_CONTEXT_MESSAGES = old;
  }
});
