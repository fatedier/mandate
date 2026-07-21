import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../../src/server/config.js";
import { DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT } from "../../src/shared/settings.js";

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "md-voice-cfg-"));
}

test("loadConfig: voice block has default values when not set", () => {
  const dir = freshDir();
  try {
    const cfg = loadConfig(dir);
    expect(cfg.voice.provider).toBe("openai");
    expect(cfg.voice.apiKey).toBe("");
    expect(cfg.voice.model).toBe("gpt-realtime-mini");
    expect(cfg.voice.voice).toBe("marin");
    expect(cfg.voice.language).toBe("auto");
    expect(cfg.voice.idleTimeoutMs).toBe(5 * 60 * 1000);
    expect(cfg.voice.maxSessionMs).toBe(25 * 60 * 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: voice block reads file overrides", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    voice: {
      apiKey: "sk-test",
      model: "gpt-realtime",
      voice: "sage",
      language: "zh",
      idleTimeoutMs: 60000,
      maxSessionMs: 120000
    }
  }));
  try {
    const cfg = loadConfig(dir);
    expect(cfg.voice.apiKey).toBe("sk-test");
    expect(cfg.voice.model).toBe("gpt-realtime");
    expect(cfg.voice.voice).toBe("sage");
    expect(cfg.voice.language).toBe("zh");
    expect(cfg.voice.idleTimeoutMs).toBe(60000);
    expect(cfg.voice.maxSessionMs).toBe(120000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: voice provider can use a configured OpenAI provider name", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    models: {
      providers: {
        work: { type: "openai", apiKey: "sk-work" }
      }
    },
    voice: {
      provider: "work",
      model: "gpt-realtime-mini"
    }
  }));
  try {
    const cfg = loadConfig(dir);
    expect(cfg.voice.provider).toBe("work");
    expect(cfg.voice.providerName).toBe("work");
    expect(cfg.voice.providerType).toBe("openai");
    expect(cfg.voice.apiKey).toBe("sk-work");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: voice provider can use a configured OpenAI Codex provider name", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
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
  }));
  try {
    const cfg = loadConfig(dir);
    expect(cfg.voice.provider).toBe("codex");
    expect(cfg.voice.providerName).toBe("codex");
    expect(cfg.voice.providerType).toBe("codex");
    expect(cfg.voice.apiKey).toBe("");
    expect(cfg.voice.model).toBe("gpt-realtime-1.5");
    expect(cfg.voice.baseURL).toBe("");
    expect(cfg.voice.deployment).toBe("");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: invalid timeouts fall back to defaults", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    voice: { idleTimeoutMs: -1, maxSessionMs: "bad" }
  }));
  try {
    const cfg = loadConfig(dir);
    expect(cfg.voice.idleTimeoutMs).toBe(5 * 60 * 1000);
    expect(cfg.voice.maxSessionMs).toBe(25 * 60 * 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: voice.contextMessageCount defaults to shared default", () => {
  const dir = freshDir();
  try {
    const cfg = loadConfig(dir);
    expect(cfg.voice.contextMessageCount).toBe(DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: voice.contextMessageCount reads file override", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    voice: { contextMessageCount: 5 }
  }));
  try {
    const cfg = loadConfig(dir);
    expect(cfg.voice.contextMessageCount).toBe(5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: voice.contextMessageCount clamps invalid values to default", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    voice: { contextMessageCount: -1 }
  }));
  try {
    const cfg = loadConfig(dir);
    expect(cfg.voice.contextMessageCount).toBe(DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: voice.contextMessageCount clamps to 100 maximum", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    voice: { contextMessageCount: 500 }
  }));
  try {
    const cfg = loadConfig(dir);
    expect(cfg.voice.contextMessageCount).toBe(100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: MANDATE_VOICE_CONTEXT_MESSAGES env overrides file", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    voice: { contextMessageCount: 5 }
  }));
  const old = process.env.MANDATE_VOICE_CONTEXT_MESSAGES;
  process.env.MANDATE_VOICE_CONTEXT_MESSAGES = "20";
  try {
    const cfg = loadConfig(dir);
    expect(cfg.voice.contextMessageCount).toBe(20);
  } finally {
    if (old === undefined) delete process.env.MANDATE_VOICE_CONTEXT_MESSAGES;
    else process.env.MANDATE_VOICE_CONTEXT_MESSAGES = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
