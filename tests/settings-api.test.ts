import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../src/server/config.js";
import {
  mountSettingsRoutes,
  type SettingsRoutesDeps
} from "../src/server/modules/settings/settings-routes.js";
import { saveCodexTokens } from "../src/server/modules/codex/codex-auth-store.js";
import { tempDir } from "./helpers/temp.js";

const SETTINGS_ENV_KEYS = [
  "MANDATE_DATA_DIR",
  "PORT",
  "MANDATE_HOST",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MANDATE_VOICE_API_KEY"
] as const;

type SettingsEnvKey = (typeof SETTINGS_ENV_KEYS)[number];

function withSettingsApp(
  fn: (ctx: { dir: string; app: Hono }) => Promise<void> | void,
  env: Partial<Record<SettingsEnvKey, string | undefined>> = {},
  routeDeps: SettingsRoutesDeps = {}
) {
  const dir = tempDir("md-settings-");
  const previous = snapshotEnv(SETTINGS_ENV_KEYS);

  for (const key of SETTINGS_ENV_KEYS) delete process.env[key];
  process.env.MANDATE_DATA_DIR = dir;
  for (const [key, value] of Object.entries(env) as [SettingsEnvKey, string | undefined][]) {
    restoreEnv(key, value);
  }

  const app = new Hono();
  mountSettingsRoutes(app, routeDeps);

  return Promise.resolve(fn({ dir, app })).finally(() => restoreEnvSnapshot(previous));
}

test("settings config: GET uses defaults without creating config.json or leaking secrets", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.models.default.model).toBe("");
    expect(body.models.default.reasoningEffort).toBe("provider-default");
    expect(body.models.default.modelFallbacks).toEqual([]);
    expect(body.models.providers).toEqual({});
    expect(body.server.host).toBe("127.0.0.1");
    expect(body.server.port).toBe(4173);
    // Nobody's taste is built in: a preference is what the user writes.
    expect(body.agent.preferences).toBe("");
    expect(body.agent.compressionThresholdTokens).toBe(200000);
    expect(body.agent.managerModel).toEqual({ model: "", reasoningEffort: "provider-default" });
    expect(body.agent.workerModel).toEqual({ model: "", reasoningEffort: "provider-default" });
    expect(body.agent.modelOverrides).toEqual({ manager: false, worker: false, global: false, dream: false, extraction: false, subagent: false, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });
    expect(body.memory.embedding.model).toBe("");
    expect(body.memory.dream.enabled).toBe(true);
    expect(body.voice.apiKeyConfigured).toBe(false);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
  });
});

test("settings config: compression threshold persists, hot reloads, and resets to default", async () => {
  const reloadedThresholds: number[] = [];
  await withSettingsApp(
    async ({ dir, app }) => {
      for (const compressionThresholdTokens of [128000, 200000]) {
        const res = await app.request("/api/settings/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: { compressionThresholdTokens } })
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          restartRequired: false,
          agent: { compressionThresholdTokens }
        });
        const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
        expect(saved.agent.compressionThresholdTokens).toBe(compressionThresholdTokens);
        const fresh = await app.request("/api/settings/config");
        expect((await fresh.json()).agent.compressionThresholdTokens).toBe(compressionThresholdTokens);
      }
      expect(reloadedThresholds).toStrictEqual([128000, 200000]);
    },
    {},
    {
      reloadConfig: () => {
        const config = loadConfig();
        reloadedThresholds.push(config.agent.compressionThresholdTokens);
        return config;
      }
    }
  );
});

test("settings config: model changes hot reload without restart", async () => {
  let reloads = 0;
  await withSettingsApp(
    async ({ app }) => {
      const res = await app.request("/api/settings/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          models: {
            default: {
              model: "work/gpt-5.5",
              modelFallbacks: ["backup/gpt-5.5"]
            },
            providers: {
              work: { type: "openai", apiKey: "sk-openai" },
              backup: {
                type: "openai-compatible",
                apiKey: "sk-backup",
                baseURL: "https://backup.example/v1"
              }
            }
          },
          agent: {
            managerModel: "work/gpt-5.5",
            managerModelFallbacks: ["backup/gpt-5.5"],
            workerModel: "work/gpt-5.5",
            workerModelFallbacks: ["backup/gpt-5.5"]
          },
          voice: {
            provider: "work",
            model: "gpt-realtime-2"
          }
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.restartRequired).toBe(false);
      expect(body.models.default.model).toBe("work/gpt-5.5");
      expect(body.models.default.reasoningEffort).toBe("provider-default");
      expect(body.models.default.modelFallbacks).toEqual([{
        model: "backup/gpt-5.5",
        reasoningEffort: "provider-default"
      }]);
      expect(body.agent.managerModel).toEqual({
        model: "work/gpt-5.5",
        reasoningEffort: "provider-default"
      });
      expect(body.agent.managerModelFallbacks).toEqual([{
        model: "backup/gpt-5.5",
        reasoningEffort: "provider-default"
      }]);
      expect(body.agent.workerModelFallbacks).toEqual([{
        model: "backup/gpt-5.5",
        reasoningEffort: "provider-default"
      }]);
      expect(body.agent.modelOverrides).toEqual({ manager: true, worker: true, global: false, dream: false, extraction: false, subagent: false, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });
      expect(body.voice.model).toBe("gpt-realtime-2");
      expect(reloads).toBe(1);
    },
    {},
    {
      reloadConfig: () => {
        reloads += 1;
        return loadConfig();
      }
    }
  );
});

test("settings config: Max is an effort a route and its fallbacks keep, saved and loaded again", async () => {
  await withSettingsApp(async ({ app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          default: { model: "work/gpt-5.5", reasoningEffort: "max", modelFallbacks: [{ model: "backup/claude-sonnet-4-6", reasoningEffort: "max" }] },
          providers: { work: { type: "openai", apiKey: "sk-openai" }, backup: { type: "anthropic", apiKey: "sk-anthropic" } }
        },
        agent: { workerModel: { model: "backup/claude-sonnet-4-6", reasoningEffort: "max" }, workerModelFallbacks: [] }
      })
    });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect([saved.models.default.reasoningEffort, saved.models.default.modelFallbacks[0].reasoningEffort, saved.agent.workerModel.reasoningEffort]).toEqual(["max", "max", "max"]);
    const loaded = await (await app.request("/api/settings/config")).json();
    expect([loaded.models.default.reasoningEffort, loaded.models.default.modelFallbacks[0].reasoningEffort, loaded.agent.workerModel.reasoningEffort]).toEqual(["max", "max", "max"]);
  });
});

test("settings config: POST saves default model reasoning effort", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          default: {
            model: "work/gpt-5.5",
            reasoningEffort: "medium",
            modelFallbacks: [
              { model: "backup/claude-sonnet-4-6", reasoningEffort: "low" }
            ]
          },
          providers: {
            work: { type: "openai", apiKey: "sk-openai" },
            backup: { type: "anthropic", apiKey: "sk-anthropic" }
          }
        }
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.default).toMatchObject({
      model: "work/gpt-5.5",
      reasoningEffort: "medium"
    });
    expect(body.models.default.modelFallbacks).toEqual([{
      model: "backup/claude-sonnet-4-6",
      reasoningEffort: "low"
    }]);
    expect(body.agent.managerModel).toEqual({
      model: "work/gpt-5.5",
      reasoningEffort: "medium"
    });
    expect(body.agent.workerModel).toEqual({
      model: "work/gpt-5.5",
      reasoningEffort: "medium"
    });
    expect(body.agent.workerModelFallbacks).toEqual([{
      model: "backup/claude-sonnet-4-6",
      reasoningEffort: "low"
    }]);
    expect(body.agent.modelOverrides).toEqual({ manager: false, worker: false, global: false, dream: false, extraction: false, subagent: false, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.models.default).toEqual({
      model: "work/gpt-5.5",
      reasoningEffort: "medium",
      modelFallbacks: [
        { model: "backup/claude-sonnet-4-6", reasoningEffort: "low" }
      ]
    });
  });
});

test("settings config: POST saves reasoning effort on selected agent models", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          default: {
            model: "work/gpt-5.5"
          },
          providers: {
            work: { type: "openai", apiKey: "sk-openai" },
            backup: { type: "anthropic", apiKey: "sk-anthropic" }
          }
        },
        agent: {
          managerModel: { model: "work/gpt-5.5", reasoningEffort: "high" },
          managerModelFallbacks: [
            { model: "backup/claude-sonnet-4-6", reasoningEffort: "medium" }
          ],
          workerModel: { model: "work/gpt-5-mini", reasoningEffort: "minimal" },
          workerModelFallbacks: [
            { model: "backup/claude-haiku-4-5", reasoningEffort: "low" }
          ]
        }
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent.managerModel).toEqual({
      model: "work/gpt-5.5",
      reasoningEffort: "high"
    });
    expect(body.agent.managerModelFallbacks).toEqual([{
      model: "backup/claude-sonnet-4-6",
      reasoningEffort: "medium"
    }]);
    expect(body.agent.workerModel).toEqual({
      model: "work/gpt-5-mini",
      reasoningEffort: "minimal"
    });
    expect(body.agent.workerModelFallbacks).toEqual([{
      model: "backup/claude-haiku-4-5",
      reasoningEffort: "low"
    }]);
    expect(body.agent.modelOverrides).toEqual({ manager: true, worker: true, global: false, dream: false, extraction: false, subagent: false, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.agent.managerModel).toEqual({
      model: "work/gpt-5.5",
      reasoningEffort: "high"
    });
    expect(file.agent.workerModelFallbacks).toEqual([{
      model: "backup/claude-haiku-4-5",
      reasoningEffort: "low"
    }]);
  });
});

test("settings config: POST null agent model overrides restores default inheritance", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        models: {
          default: {
            model: "work/gpt-5.5",
            reasoningEffort: "medium",
            modelFallbacks: [
              { model: "backup/claude-sonnet-4-6", reasoningEffort: "low" }
            ]
          },
          providers: {
            work: { type: "openai", apiKey: "sk-openai" },
            backup: { type: "anthropic", apiKey: "sk-anthropic" }
          }
        },
        agent: {
          managerModel: { model: "backup/claude-opus-4-7", reasoningEffort: "high" },
          managerModelFallbacks: [],
          workerModel: { model: "work/gpt-5-mini", reasoningEffort: "minimal" },
          workerModelFallbacks: []
        }
      })
    );

    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: {
          managerModel: null,
          managerModelFallbacks: null,
          workerModel: null,
          workerModelFallbacks: null
        }
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent.modelOverrides).toEqual({ manager: false, worker: false, global: false, dream: false, extraction: false, subagent: false, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });
    expect(body.agent.managerModel).toEqual({
      model: "work/gpt-5.5",
      reasoningEffort: "medium"
    });
    expect(body.agent.workerModel).toEqual({
      model: "work/gpt-5.5",
      reasoningEffort: "medium"
    });
    expect(body.agent.managerModelFallbacks).toEqual([{
      model: "backup/claude-sonnet-4-6",
      reasoningEffort: "low"
    }]);
    expect(body.agent.workerModelFallbacks).toEqual([{
      model: "backup/claude-sonnet-4-6",
      reasoningEffort: "low"
    }]);

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(Object.hasOwn(file.agent, "managerModel")).toBe(false);
    expect(Object.hasOwn(file.agent, "managerModelFallbacks")).toBe(false);
    expect(Object.hasOwn(file.agent, "workerModel")).toBe(false);
    expect(Object.hasOwn(file.agent, "workerModelFallbacks")).toBe(false);
  });
});

test("settings config: GET applies explicit server env overrides", async () => {
  await withSettingsApp(
    async ({ app }) => {
      const res = await app.request("/api/settings/config");
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.server.host).toBe("0.0.0.0");
      expect(body.server.port).toBe(5123);
    },
    {
      MANDATE_HOST: "0.0.0.0",
      PORT: "5123"
    }
  );
});

test("settings config: POST writes config.json and does not return API keys", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          default: {
            model: "claude/claude-sonnet-4-6"
          },
          providers: {
            claude: { type: "anthropic", apiKey: "sk-anthropic" },
            work: { type: "openai", apiKey: "sk-openai", baseURL: "https://api.openai.com/v1" }
          }
        },
        agent: {
          preferences: "Prefer Claude for planning and Codex for implementation.",
          managerModel: "claude/claude-sonnet-4-6",
          workerModel: "work/gpt-5-mini"
        },
        memory: {
          embedding: {
            model: "openai/text-embedding-3-small"
          },
          dream: {
            enabled: false
          }
        },
        voice: {
          provider: "openai",
          model: "gpt-realtime-mini",
          voice: "marin",
          apiKey: "sk-voice"
        }
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const responseText = JSON.stringify(body);

    expect(body.restartRequired).toBe(false);
    expect(body.voice.apiKeyConfigured).toBe(true);
    expect(responseText).not.toContain("sk-anthropic");
    expect(responseText).not.toContain("sk-openai");
    expect(responseText).not.toContain("sk-voice");

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.models.providers.claude.type).toBe("anthropic");
    expect(file.models.providers.claude.apiKey).toBe("sk-anthropic");
    expect(file.models.providers.work.type).toBe("openai");
    expect(file.models.providers.work.apiKey).toBe("sk-openai");
    expect(file.agent.preferences).toBe("Prefer Claude for planning and Codex for implementation.");
    expect(file.agent.workerModel).toEqual({
      model: "work/gpt-5-mini",
      reasoningEffort: "provider-default"
    });
    expect(file.memory.embedding.model).toBe("openai/text-embedding-3-small");
    expect(file.memory.dream.enabled).toBe(false);
    expect(file.voice.apiKey).toBe("sk-voice");
  });
});

test("settings config: POST writes server host and port", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server: {
          host: "0.0.0.0",
          port: 4789
        }
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server.host).toBe("0.0.0.0");
    expect(body.server.port).toBe(4789);
    expect(body.restartRequired).toBe(true);

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.host).toBe("0.0.0.0");
    expect(file.port).toBe(4789);
  });
});

test("settings config: POST writes agent log request mode", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: { logRequests: "off" }
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent.logRequests).toBe("off");

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.agent.logRequests).toBe("off");
  });
});

// What the config POST refuses: a 400 with ok: false and an error naming the
// field. The provider type's error is pinned whole.
const rejections: { name: string; patch: Record<string, unknown>; error: RegExp }[] = [
  {
    name: "settings config: rejects unsupported agent model reasoning effort",
    patch: { agent: { managerModel: { model: "work/gpt-5.5", reasoningEffort: "extreme" } } },
    error: /reasoningEffort is not supported/
  },
  {
    name: "settings config: rejects unsupported default model reasoning effort",
    patch: { models: { default: { model: "work/gpt-5.5", reasoningEffort: "extreme" } } },
    error: /reasoningEffort is not supported/
  },
  {
    name: "settings config: rejects invalid server host",
    patch: { server: { host: " " } },
    error: /server\.host/
  },
  {
    name: "settings config: rejects invalid server port",
    patch: { server: { port: 70000 } },
    error: /server\.port/
  },
  {
    name: "settings config: rejects unsupported provider types",
    patch: { models: { providers: { proxy: { type: "unsupported-provider", apiKey: "sk-proxy" } } } },
    error: /^type is not supported$/
  },
  {
    name: "settings config: rejects an unknown model protocol",
    patch: { models: { providers: { proxy: { type: "openai-compatible", models: [{ id: "model-a", protocol: "smoke-signal" }] } } } },
    error: /models\[\]\.protocol/
  },
  {
    name: "settings config: rejects invalid provider model reasoning support",
    patch: {
      models: {
        providers: {
          work: {
            type: "openai",
            apiKey: "sk-work",
            models: [{ id: "gpt-5.5", input: ["text"], supportsReasoning: "force" }]
          }
        }
      }
    },
    error: /supportsReasoning must be a boolean/
  },
  {
    name: "settings config: rejects voice context message count above shared limit",
    patch: { voice: { contextMessageCount: 101 } },
    error: /contextMessageCount/
  }
];

test.each(rejections)("$name", async ({ patch, error }) => {
  await withSettingsApp(async ({ app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(error);
  });
});

// The worker token budget is gone. A tab opened before that
// still sends it with the rest of its form: the rest is saved, it is not.
test("settings config: the worker token budget is not offered, and one still sent is dropped while the rest is saved", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const shown = await (await app.request("/api/settings/config")).json() as { agent: Record<string, unknown> };
    expect(Object.keys(shown.agent)).toContain("compressionThresholdTokens");
    expect("workerTokenBudget" in shown.agent).toBe(false);
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { workerTokenBudget: 0, preferences: "Reply in Chinese." } })
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).agent).toEqual({ preferences: "Reply in Chinese." });
  });
});

test("settings config: POST prunes unknown section keys", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        agent: { workerTokenBudget: 25, unexpected: true },
        memory: {
          embedding: { model: "", unexpected: true },
          dream: { enabled: true, unexpected: true },
          unexpected: true
        }
      }),
      "utf8"
    );

    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: { compressionThresholdTokens: 150000 },
        memory: { dream: { enabled: false } }
      })
    });
    expect(res.status).toBe(200);

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    // The file's own leftover (a setting that is gone) is pruned with the rest.
    expect(file.agent).toEqual({ compressionThresholdTokens: 150000 });
    expect(file.memory).toEqual({
      embedding: { model: "" },
      dream: { enabled: false }
    });
  });
});

test("settings config: blank secret preserves current key and clear removes it", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        models: { providers: { myprovider: { type: "openai-compatible", apiKey: "sk-current" } } }
      }),
      "utf8"
    );

    let res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: { providers: { myprovider: { type: "openai-compatible", apiKey: "" } } }
      })
    });
    expect(res.status).toBe(200);
    let file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.models.providers.myprovider.apiKey).toBe("sk-current");

    res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: { providers: { myprovider: { type: "openai-compatible", clearApiKey: true } } }
      })
    });
    expect(res.status).toBe(200);
    file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.models.providers.myprovider.apiKey).toBe("");
  });
});

test("settings config: provider names are preserved exactly", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          default: {
            model: "team-proxy/gpt-5.5"
          },
          providers: {
            "team-proxy": { type: "openai-compatible", apiKey: "sk-1" },
            OpenAIProxy: { type: "openai", apiKey: "sk-2" }
          }
        }
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.models.providers)).toEqual(["team-proxy", "OpenAIProxy"]);
    expect(body.models.default.model).toBe("team-proxy/gpt-5.5");

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(Object.keys(file.models.providers)).toEqual(["team-proxy", "OpenAIProxy"]);
  });
});

test("settings config: Kilo Gateway providers save organization id", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          default: {
            model: "kilo/kilo-auto/balanced"
          },
          providers: {
            kilo: {
              type: "kilo",
              apiKey: "sk-kilo",
              organizationId: "org_123"
            }
          }
        },
        agent: {
          managerModel: "kilo/kilo-auto/balanced",
          workerModel: "kilo/kilo-auto/balanced"
        }
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const responseText = JSON.stringify(body);

    expect(body.models.providers.kilo).toMatchObject({
      type: "kilo",
      baseURL: "https://api.kilo.ai/api/gateway",
      organizationId: "org_123",
      apiKeyConfigured: true
    });
    expect(body.agent.managerModel).toMatchObject({ model: "kilo/kilo-auto/balanced" });
    expect(responseText).not.toContain("sk-kilo");

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.models.providers.kilo).toMatchObject({
      type: "kilo",
      apiKey: "sk-kilo",
      organizationId: "org_123"
    });
  });
});

test("settings provider models: a failing live listing falls back to configured models", async () => {
  let fetchCount = 0;
  await withSettingsApp(
    async ({ app }) => {
      const saveRes = await app.request("/api/settings/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          models: {
            providers: {
              work: {
                type: "openai",
                apiKey: "sk-work",
                models: [{ id: "gpt-4.1-mini", input: ["image"], supportsReasoning: true }]
              }
            }
          }
        })
      });
      expect(saveRes.status).toBe(200);

      const res = await app.request("/api/settings/providers/work/models");
      expect(res.status).toBe(200);
      const body = await res.json();
      // A keyed provider now attempts a live listing; this client throws, so
      // the catalog degrades to the configured models.
      expect(fetchCount).toBe(1);
      expect(body).toMatchObject({
        ok: true,
        providerName: "work",
        providerType: "openai",
        source: "configured",
        cached: false
      });
      expect(body.models).toEqual([
        {
          id: "gpt-4.1-mini",
          name: "gpt-4.1-mini",
          input: ["text", "image"],
          supportsReasoning: true,
          contextLength: null,
          outputModalities: [],
          supportedParameters: []
        }
      ]);
    },
    {},
    {
      httpClient: {
        async fetch() {
          fetchCount += 1;
          throw new Error("unexpected fetch");
        }
      }
    }
  );
});

test("settings provider models: a transient live failure is not cached for an hour", async () => {
  let failNext = true;
  await withSettingsApp(
    async ({ app }) => {
      const saveRes = await app.request("/api/settings/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          models: {
            providers: {
              gw: {
                type: "openai-compatible",
                apiKey: "sk-gw",
                baseURL: "https://gw.example/v1",
                models: []
              }
            }
          }
        })
      });
      expect(saveRes.status).toBe(200);

      const first = await (await app.request("/api/settings/providers/gw/models")).json();
      expect(first.source).toBe("configured");

      failNext = false;
      // No refresh flag: the fallback must not have been pinned by the cache.
      const second = await (await app.request("/api/settings/providers/gw/models")).json();
      expect(second.source).toBe("live");
      expect(second.models.map((m: { id: string }) => m.id)).toContain("gw-model-1");
    },
    {},
    {
      httpClient: {
        async fetch() {
          if (failNext) throw new Error("transient");
          return new Response(JSON.stringify({ data: [{ id: "gw-model-1" }] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
    }
  );
});

test("settings provider models: Codex returns the built-in GPT-5.6 catalog", async () => {
  await withSettingsApp(async ({ app }) => {
    const saveRes = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          providers: {
            codex: {
              type: "codex",
              models: [
                { id: "gpt-5.6-sol", input: ["text"], supportsReasoning: false },
                { id: "custom-codex", input: ["text"] }
              ]
            }
          }
        }
      })
    });
    expect(saveRes.status).toBe(200);

    const res = await app.request("/api/settings/providers/codex/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      providerName: "codex",
      providerType: "codex",
      source: "builtin",
      cached: false
    });
    expect(body.models.map((model: { id: string }) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "custom-codex"
    ]);
    expect(body.models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      input: ["text", "image"],
      supportsReasoning: true
    });
  });
});

async function saveProxy(app: Hono, apiKey: string) {
  const res = await app.request("/api/settings/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ models: { providers: { proxy: { type: "openai-compatible", baseURL: "http://127.0.0.1:9/v1", apiKey, models: [{ id: "model-a", input: ["text"] }] } } } })
  });
  expect(res.status).toBe(200);
}

async function checkProxy(app: Hono, body: Record<string, unknown> = {}, name = "proxy") {
  const res = await app.request(`/api/settings/providers/${name}/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test("settings provider check: a listing that answers is ready with its model count", async () => {
  await withSettingsApp(async ({ app }) => {
    await saveProxy(app, "sk-one");
    const { status, body } = await checkProxy(app);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, providerName: "proxy", result: "ready", modelCount: 2 });
    expect(typeof body.checkedAt).toBe("string");
  }, {}, { httpClient: { fetch: async () => Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] }) } });
});

test("settings provider check: a refused key fails with the status and the provider's message", async () => {
  await withSettingsApp(async ({ app }) => {
    await saveProxy(app, "sk-one");
    expect((await checkProxy(app)).body).toMatchObject({ ok: true, result: "failed", httpStatus: 401, message: "401 Unauthorized: bad key" });
  }, {}, { httpClient: { fetch: async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, statusText: "Unauthorized" }) } });
});

test("settings provider check: a fresh result is reused within maxAgeMs, and a replaced key is checked anew", async () => {
  let calls = 0;
  await withSettingsApp(async ({ app }) => {
    await saveProxy(app, "sk-one");
    await checkProxy(app);
    await checkProxy(app, { maxAgeMs: 3_600_000 });
    expect(calls).toBe(1);
    await checkProxy(app);
    expect(calls).toBe(2);
    await saveProxy(app, "sk-two");
    await checkProxy(app, { maxAgeMs: 3_600_000 });
    expect(calls).toBe(3);
  }, {}, { httpClient: { fetch: async () => { calls += 1; return Response.json({ data: [{ id: "model-a" }] }); } } });
});

test("settings provider check: a failed check is never answered again from the cache; it is checked anew", async () => {
  let calls = 0;
  await withSettingsApp(async ({ app }) => {
    await saveProxy(app, "sk-one");
    expect((await checkProxy(app)).body.result).toBe("failed");
    expect((await checkProxy(app, { maxAgeMs: 3_600_000 })).body.result).toBe("ready");
    expect(calls).toBe(2);
  }, {}, { httpClient: { fetch: async () => {
    calls += 1;
    return calls === 1 ? new Response("down", { status: 503, statusText: "Service Unavailable" }) : Response.json({ data: [{ id: "model-a" }] });
  } } });
});

test("settings provider models: a listing for the old key that lands after a key change is never served for the new key", async () => {
  let releaseFirst: (() => void) | null = null;
  let calls = 0;
  await withSettingsApp(async ({ app }) => {
    await saveProxy(app, "sk-one");
    const first = app.request("/api/settings/providers/proxy/models");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await saveProxy(app, "sk-two");
    releaseFirst!();
    await first;
    const res = await app.request("/api/settings/providers/proxy/models");
    const body = await res.json();
    expect(body.models.map((m: { id: string }) => m.id)).toContain("model-for-sk-two");
    expect(body.models.map((m: { id: string }) => m.id)).not.toContain("model-for-sk-one");
  }, {}, { httpClient: { fetch: async (_url, init) => {
    calls += 1;
    const key = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    const answer = () => Response.json({ data: [{ id: `model-for-${key}` }] });
    if (calls === 1) return new Promise<Response>((resolve) => { releaseFirst = () => resolve(answer()); });
    return answer();
  } } });
});

test("settings provider check: a ready check refreshes the catalog Add models reads", async () => {
  let listed = ["model-a"];
  await withSettingsApp(async ({ app }) => {
    await saveProxy(app, "sk-one");
    const before = await (await app.request("/api/settings/providers/proxy/models")).json();
    expect(before.models.map((m: { id: string }) => m.id)).toEqual(["model-a"]);
    listed = ["model-a", "model-b"];
    await checkProxy(app);
    const after = await (await app.request("/api/settings/providers/proxy/models")).json();
    expect(after.models.map((m: { id: string }) => m.id)).toEqual(["model-a", "model-b"]);
  }, {}, { httpClient: { fetch: async () => Response.json({ data: listed.map((id) => ({ id })) }) } });
});

test("settings provider check: no key is unchecked and nothing is fetched; Codex is its sign-in", async () => {
  let calls = 0;
  await withSettingsApp(async ({ app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: { providers: {
        proxy: { type: "openai-compatible", baseURL: "http://127.0.0.1:9/v1", models: [] },
        codex: { type: "codex", models: [] }
      } } })
    });
    expect(res.status).toBe(200);
    expect((await checkProxy(app)).body).toMatchObject({ ok: true, result: "unchecked", reason: "no-key" });
    expect((await checkProxy(app, {}, "codex")).body).toMatchObject({ ok: true, result: "unchecked", reason: "signed-in-only" });
    expect(calls).toBe(0);
  }, {}, { httpClient: { fetch: async () => { calls += 1; return Response.json({ data: [] }); } } });
});

test("settings provider check: an unknown provider is a 400", async () => {
  await withSettingsApp(async ({ app }) => {
    const { status, body } = await checkProxy(app, {}, "nobody");
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });
});

test("settings config: provider model capabilities are saved and returned", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          default: {
            model: "work/gpt-5.5"
          },
          providers: {
            work: {
              type: "openai",
              apiKey: "sk-work",
              models: [
                {
                  id: "gpt-5.5",
                  input: ["text", "image", "audio", "video", "document"],
                  supportsReasoning: true
                },
                {
                  id: "gpt-5.4-mini",
                  input: ["image", "text", "document"],
                  supportsReasoning: false
                }
              ]
            }
          }
        }
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.providers.work.models).toEqual([
      { id: "gpt-5.5", input: ["text", "image"], supportsReasoning: true },
      { id: "gpt-5.4-mini", input: ["text", "image"], supportsReasoning: false }
    ]);

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.models.providers.work.models).toEqual([
      { id: "gpt-5.5", input: ["text", "image"], supportsReasoning: true },
      { id: "gpt-5.4-mini", input: ["text", "image"], supportsReasoning: false }
    ]);
  });
});

test("settings config: a custom provider's model protocol is saved and returned; another type's is dropped", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          providers: {
            proxy: {
              type: "openai-compatible",
              baseURL: "http://127.0.0.1:9/v1",
              apiKey: "sk-proxy",
              models: [
                { id: "model-a", input: ["text"], protocol: "messages" },
                { id: "model-b", input: ["text"], protocol: "responses" }
              ]
            },
            direct: {
              type: "anthropic",
              apiKey: "sk-direct",
              models: [{ id: "model-c", input: ["text"], protocol: "chat" }]
            }
          }
        }
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.providers.proxy.models).toEqual([
      { id: "model-a", input: ["text"], protocol: "messages" },
      { id: "model-b", input: ["text"] }
    ]);
    expect(body.models.providers.direct.models).toEqual([{ id: "model-c", input: ["text"] }]);
    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.models.providers.proxy.models[0]).toEqual({ id: "model-a", input: ["text"], protocol: "messages" });
    expect(file.models.providers.direct.models[0].protocol).toBeUndefined();
  });
});

test("settings config: OpenAI Codex providers use OAuth auth state instead of API keys", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    let res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          default: {
            model: "codex/gpt-5.5"
          },
          providers: {
            codex: {
              type: "codex",
              serviceTier: "priority",
              apiKey: "should-not-be-stored"
            }
          }
        }
      })
    });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.models.providers.codex.apiKeyConfigured).toBe(false);
    expect(body.models.providers.codex.serviceTier).toBe("priority");
    expect(body.models.providers.codex.models.map((model: { id: string }) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5"
    ]);
    expect(body.models.providers.codex.auth).toMatchObject({
      status: "missing",
      configured: false,
      profileId: "codex:default"
    });

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.models.providers.codex.type).toBe("codex");
    expect(file.models.providers.codex.serviceTier).toBe("priority");
    expect(file.models.providers.codex.apiKey).toBeUndefined();

    saveCodexTokens(
      "codex",
      {
        access_token: fakeJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" }
        }),
        refresh_token: "refresh-token",
        id_token: fakeJwt({ email: "dev@example.test" }),
        expires_in: 3600
      },
      dir
    );

    res = await app.request("/api/settings/config");
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.models.providers.codex.apiKeyConfigured).toBe(true);
    expect(body.models.providers.codex.auth).toMatchObject({
      status: "authenticated",
      configured: true,
      email: "dev@example.test",
      accountId: "acct_test"
    });

    res = await app.request("/api/settings/auth/codex/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerName: "codex" })
    });
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.auth).toMatchObject({ status: "missing", configured: false });
  });
});

test("settings config: voice can use an OpenAI Codex provider OAuth state", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          providers: {
            codex: { type: "codex" }
          }
        },
        voice: {
          provider: "codex",
          model: "gpt-realtime-1.5",
          voice: "marin",
          baseURL: "wss://stale.azure.example/openai/v1/realtime",
          deployment: "stale-deployment",
          apiKey: "should-not-be-stored"
        }
      })
    });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.voice.provider).toBe("codex");
    expect(body.voice.providerName).toBe("codex");
    expect(body.voice.providerType).toBe("codex");
    expect(body.voice.apiKeyConfigured).toBe(false);
    expect(body.voice.auth).toMatchObject({
      status: "missing",
      configured: false,
      profileId: "codex:default"
    });

    let file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.voice.provider).toBe("codex");
    expect(file.voice.apiKey).toBeUndefined();
    expect(file.voice.baseURL).toBeUndefined();
    expect(file.voice.deployment).toBeUndefined();

    saveCodexTokens(
      "codex",
      {
        access_token: fakeJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_voice" }
        }),
        refresh_token: "refresh-token",
        id_token: fakeJwt({ email: "voice@example.test" }),
        expires_in: 3600
      },
      dir
    );

    const getRes = await app.request("/api/settings/config");
    expect(getRes.status).toBe(200);
    body = await getRes.json();
    expect(body.voice.apiKeyConfigured).toBe(true);
    expect(body.voice.auth).toMatchObject({
      status: "authenticated",
      configured: true,
      email: "voice@example.test",
      accountId: "acct_voice"
    });
  });
});

test.each([
  { agent: { compressionThresholdTokens: 150000 } },
  { server: { port: 4599 } }
])("settings config: retired agent keys are ignored and pruned on save (%j)", async (patch) => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        models: {
          default: { model: "claude/claude-sonnet-4-6", reasoningEffort: "medium" },
          providers: {
            claude: { type: "anthropic", apiKey: "sk-anthropic" }
          }
        },
        agent: {
          preferences: "Keep these preferences.",
          overviewModel: { model: "claude/claude-opus-4-7", reasoningEffort: "high" },
          overviewModelFallbacks: ["claude/claude-haiku-4-5"],
          featureModel: "claude/claude-opus-4-7",
          featureModelFallbacks: ["claude/claude-haiku-4-5"]
        }
      })
    );

    const before = await app.request("/api/settings/config");
    expect(before.status).toBe(200);
    const expectedAgent = {
      modelOverrides: { manager: false, worker: false },
      managerModel: { model: "claude/claude-sonnet-4-6", reasoningEffort: "medium" },
      workerModel: { model: "claude/claude-sonnet-4-6", reasoningEffort: "medium" },
      managerModelFallbacks: [],
      workerModelFallbacks: []
    };
    expect((await before.json()).agent).toMatchObject(expectedAgent);

    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    expect(res.status).toBe(200);
    expect((await res.json()).agent).toMatchObject(expectedAgent);

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.agent).toEqual({ preferences: "Keep these preferences.", ...patch.agent });
    if (patch.server) expect(file.port).toBe(patch.server.port);
  });
});

function fakeJwt(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature"
  ].join(".");
}

function snapshotEnv<K extends string>(keys: readonly K[]): Record<K, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<
    K,
    string | undefined
  >;
}

function restoreEnvSnapshot(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    restoreEnv(key, value);
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test("settings config: Your agent's route is saved on its own, and null puts it back on the default", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      models: {
        default: { model: "work/gpt-5.5", reasoningEffort: "medium", modelFallbacks: [{ model: "backup/claude-sonnet-4-6", reasoningEffort: "low" }] },
        providers: { work: { type: "openai", apiKey: "sk-openai" }, backup: { type: "anthropic", apiKey: "sk-anthropic" } }
      }
    }));
    const post = (agent: Record<string, unknown>) => app.request("/api/settings/config", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent })
    });
    const before = await (await app.request("/api/settings/config")).json();
    expect(before.agent.globalModel).toEqual({ model: "work/gpt-5.5", reasoningEffort: "medium" });
    expect(before.agent.globalModelFallbacks).toEqual([{ model: "backup/claude-sonnet-4-6", reasoningEffort: "low" }]);
    expect(before.agent.modelOverrides.global).toBe(false);

    const saved = await post({
      globalModel: { model: "backup/claude-opus-4-7", reasoningEffort: "high" },
      globalModelFallbacks: [{ model: "work/gpt-5.5", reasoningEffort: "high" }]
    });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.agent.globalModel).toEqual({ model: "backup/claude-opus-4-7", reasoningEffort: "high" });
    expect(body.agent.globalModelFallbacks).toEqual([{ model: "work/gpt-5.5", reasoningEffort: "high" }]);
    expect(body.agent.modelOverrides).toEqual({ manager: false, worker: false, global: true, dream: false, extraction: false, subagent: false, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });
    // The manager's is untouched.
    expect(body.agent.managerModel).toEqual({ model: "work/gpt-5.5", reasoningEffort: "medium" });
    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.agent.globalModel).toEqual({ model: "backup/claude-opus-4-7", reasoningEffort: "high" });

    const cleared = await (await post({ globalModel: null, globalModelFallbacks: null })).json();
    expect(cleared.agent.modelOverrides.global).toBe(false);
    expect(cleared.agent.globalModel).toEqual({ model: "work/gpt-5.5", reasoningEffort: "medium" });
    expect(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).agent, "globalModel")).toBe(false);
  });
});

test("settings config: saving Your agent's model, even the default's, makes it a route of its own", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      models: { default: { model: "work/gpt-5.5", reasoningEffort: "medium" }, providers: { work: { type: "openai", apiKey: "sk-openai" } } }
    }));
    const res = await app.request("/api/settings/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { globalModel: { model: "work/gpt-5.5", reasoningEffort: "medium" } } })
    });
    expect((await res.json()).agent.modelOverrides.global).toBe(true);
  });
});

test("settings config: the dream's and memory extraction's routes are saved on their own, and null puts them back on the default", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      models: {
        default: { model: "work/gpt-5.5", reasoningEffort: "medium", modelFallbacks: [{ model: "backup/claude-sonnet-4-6", reasoningEffort: "low" }] },
        providers: { work: { type: "openai", apiKey: "sk-openai" }, backup: { type: "anthropic", apiKey: "sk-anthropic" } }
      }
    }));
    const post = async (agent: Record<string, unknown>) => (await app.request("/api/settings/config", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent })
    })).json();
    const fileAgent = () => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).agent ?? {};
    const defaultFirst = { model: "work/gpt-5.5", reasoningEffort: "medium" };
    const before = await (await app.request("/api/settings/config")).json();
    for (const route of ["dream", "extraction"] as const) {
      expect(before.agent[`${route}Model`]).toEqual(defaultFirst);
      expect(before.agent[`${route}ModelFallbacks`]).toEqual([{ model: "backup/claude-sonnet-4-6", reasoningEffort: "low" }]);
    }

    const dream = await post({ dreamModel: { model: "backup/claude-opus-4-7", reasoningEffort: "medium" }, dreamModelFallbacks: [] });
    expect(dream.agent.dreamModel).toEqual({ model: "backup/claude-opus-4-7", reasoningEffort: "medium" });
    expect(dream.agent.dreamModelFallbacks).toEqual([]);
    expect(dream.agent.modelOverrides).toEqual({ manager: false, worker: false, global: false, dream: true, extraction: false, subagent: false, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });
    // The extraction's is untouched.
    expect(dream.agent.extractionModel).toEqual(defaultFirst);

    const both = await post({
      extractionModel: { model: "work/gpt-5.5", reasoningEffort: "low" },
      extractionModelFallbacks: [{ model: "backup/claude-sonnet-4-6", reasoningEffort: "low" }]
    });
    expect(both.agent.extractionModel).toEqual({ model: "work/gpt-5.5", reasoningEffort: "low" });
    expect(both.agent.modelOverrides).toEqual({ manager: false, worker: false, global: false, dream: true, extraction: true, subagent: false, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });
    expect(fileAgent().dreamModel).toEqual({ model: "backup/claude-opus-4-7", reasoningEffort: "medium" });
    expect(fileAgent().extractionModel).toEqual({ model: "work/gpt-5.5", reasoningEffort: "low" });

    const cleared = await post({ dreamModel: null, dreamModelFallbacks: null, extractionModel: null, extractionModelFallbacks: null });
    expect(cleared.agent.modelOverrides).toEqual({ manager: false, worker: false, global: false, dream: false, extraction: false, subagent: false, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });
    expect(cleared.agent.dreamModel).toEqual(defaultFirst);
    expect(["dreamModel", "dreamModelFallbacks", "extractionModel", "extractionModelFallbacks"].filter((key) => Object.hasOwn(fileAgent(), key))).toEqual([]);
  });
});

test("settings config: a route whose keys the file holds as null follows the default, also in a save's answer", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      models: { default: { model: "work/gpt-5.5", reasoningEffort: "medium" }, providers: { work: { type: "openai", apiKey: "sk-openai" } } },
      agent: {
        managerModel: null, managerModelFallbacks: null, workerModel: null, workerModelFallbacks: null, globalModel: null, globalModelFallbacks: null,
        dreamModel: null, dreamModelFallbacks: null, extractionModel: null, extractionModelFallbacks: null,
        subagentModel: null, subagentModelFallbacks: null
      }
    }));
    // A save of something else answers with the routes as they are.
    const res = await app.request("/api/settings/config", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: { preferences: "Short replies." } })
    });
    expect((await res.json()).agent.modelOverrides).toEqual({ manager: false, worker: false, global: false, dream: false, extraction: false, subagent: false, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });
  });
});

test("settings config: the subagent route is saved on its own; unset it reads as not set, with the default's chain, and null unsets it", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      models: {
        default: { model: "work/gpt-5.5", reasoningEffort: "medium", modelFallbacks: [{ model: "backup/claude-sonnet-4-6", reasoningEffort: "low" }] },
        providers: { work: { type: "openai", apiKey: "sk-openai" }, backup: { type: "anthropic", apiKey: "sk-anthropic" } }
      }
    }));
    const post = async (agent: Record<string, unknown>) => (await app.request("/api/settings/config", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent })
    })).json();
    const fileAgent = () => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).agent ?? {};
    const before = await (await app.request("/api/settings/config")).json();
    expect(before.agent.modelOverrides.subagent).toBe(false);
    // Where switching it on starts: the default's chain.
    expect(before.agent.subagentModel).toEqual({ model: "work/gpt-5.5", reasoningEffort: "medium" });
    expect(before.agent.subagentModelFallbacks).toEqual([{ model: "backup/claude-sonnet-4-6", reasoningEffort: "low" }]);

    const own = await post({ subagentModel: { model: "backup/claude-opus-4-7", reasoningEffort: "high" }, subagentModelFallbacks: [] });
    expect(own.agent.subagentModel).toEqual({ model: "backup/claude-opus-4-7", reasoningEffort: "high" });
    expect(own.agent.subagentModelFallbacks).toEqual([]);
    expect(own.agent.modelOverrides).toEqual({ manager: false, worker: false, global: false, dream: false, extraction: false, subagent: true, page: false, managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false });
    expect(fileAgent().subagentModel).toEqual({ model: "backup/claude-opus-4-7", reasoningEffort: "high" });
    expect(fileAgent().subagentModelFallbacks).toEqual([]);

    const cleared = await post({ subagentModel: null, subagentModelFallbacks: null });
    expect(cleared.agent.modelOverrides.subagent).toBe(false);
    expect(cleared.agent.subagentModel).toEqual({ model: "work/gpt-5.5", reasoningEffort: "medium" });
    expect(["subagentModel", "subagentModelFallbacks"].filter((key) => Object.hasOwn(fileAgent(), key))).toEqual([]);
  });
});

test("settings config: the page updates' route is saved on its own, apart from the subagents', and null unsets it", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      models: {
        default: { model: "work/gpt-5.5", reasoningEffort: "medium" },
        providers: { work: { type: "openai", apiKey: "sk-openai" }, backup: { type: "anthropic", apiKey: "sk-anthropic" } }
      }
    }));
    const post = async (agent: Record<string, unknown>) => (await app.request("/api/settings/config", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent })
    })).json();
    const fileAgent = () => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).agent ?? {};
    const before = await (await app.request("/api/settings/config")).json();
    expect([before.agent.modelOverrides.page, before.agent.pageModel]).toEqual([false, { model: "work/gpt-5.5", reasoningEffort: "medium" }]);
    const own = await post({ pageModel: { model: "backup/claude-opus-4-7", reasoningEffort: "high" }, pageModelFallbacks: [] });
    expect(own.agent.pageModel).toEqual({ model: "backup/claude-opus-4-7", reasoningEffort: "high" });
    expect([own.agent.modelOverrides.page, own.agent.modelOverrides.subagent]).toEqual([true, false]);
    expect(fileAgent().pageModel).toEqual({ model: "backup/claude-opus-4-7", reasoningEffort: "high" });
    const cleared = await post({ pageModel: null, pageModelFallbacks: null });
    expect(cleared.agent.modelOverrides.page).toBe(false);
    expect(["pageModel", "pageModelFallbacks"].filter((key) => Object.hasOwn(fileAgent(), key))).toEqual([]);
  });
});

test("settings config: a subagent route saved as the default's own chain is still set, in the save's answer and on the next read", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      models: { default: { model: "work/gpt-5.5", reasoningEffort: "medium" }, providers: { work: { type: "openai", apiKey: "sk-openai" } } }
    }));
    const res = await app.request("/api/settings/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { subagentModel: { model: "work/gpt-5.5", reasoningEffort: "medium" }, subagentModelFallbacks: [] } })
    });
    expect((await res.json()).agent.modelOverrides.subagent).toBe(true);
    // A subagent runs on it, not on the asking agent's route: the next read says so too.
    const read = await (await app.request("/api/settings/config")).json();
    expect(read.agent.modelOverrides.subagent).toBe(true);
    expect(read.agent.subagentModel).toEqual({ model: "work/gpt-5.5", reasoningEffort: "medium" });
  });
});

// --- Web search ---------------------------------------------------------

const writeConfig = (dir: string, value: unknown) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(value));
const readConfigFile = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const postWebSearch = (app: Hono, webSearch: unknown) =>
  app.request("/api/settings/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ webSearch }) });

test("web search: every kind is listed with its fields, and a key is never sent", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    writeConfig(dir, {
      models: { providers: {
        p: { type: "openai", apiKey: "sk-test-provider", models: [{ id: "m1" }] },
        a: { type: "anthropic", apiKey: "sk-test-anthropic", models: [{ id: "c1" }] },
        k: { type: "kilo", apiKey: "kk", models: [{ id: "x" }] }
      } },
      webSearch: { use: "tavily", kinds: { tavily: { apiKey: "tvly-secret-key" } } }
    });
    const text = await (await app.request("/api/settings/config")).text();
    expect(text).not.toContain("tvly-secret-key");
    const body = JSON.parse(text);
    expect(body.webSearch.use).toBe("tavily");
    expect(body.webSearch.kinds.map((k: { id: string; label: string }) => [k.id, k.label])).toEqual([["model", "Model search"], ["tavily", "Tavily"], ["exa", "Exa"], ["searxng", "SearXNG"]]);
    const [model, tavily, exa, searxng] = body.webSearch.kinds;
    expect([tavily.setUp, tavily.description, tavily.fields]).toEqual([true, "Tavily's search API.", [{ key: "apiKey", type: "secret", label: "API key", required: true, value: "", configured: true }]]);
    expect([exa.setUp, exa.fields[0].configured]).toEqual([false, false]);
    expect(searxng.fields).toEqual([{ key: "address", type: "url", label: "Address", required: true, value: "", placeholder: "https://search.example.com" }]);
    expect(model.fields[0]).toMatchObject({ key: "model", type: "model", label: "Model", description: "Only models on the Responses or Messages API can search.", value: "" });
    expect(model.fields[0].options).toEqual([{ value: "p/m1", label: "p/m1 · Responses" }, { value: "a/c1", label: "a/c1 · Messages" }]);
    expect(model.fields[1]).toMatchObject({ key: "api", type: "choice", label: "API", value: "model" });
    expect(model.fields[1].options.map((o: { label: string }) => o.label)).toEqual(["As the model is set", "Responses", "Messages"]);
    expect(model.fields[2]).toMatchObject({ key: "effort", type: "choice", label: "Reasoning effort", value: "low" });
  });
});

test("web search: a saved model no longer listed stays the first option, as it is", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    writeConfig(dir, { models: { providers: { p: { type: "openai", apiKey: "k", models: [{ id: "m1" }] } } }, webSearch: { use: "model", kinds: { model: { model: "p/old" } } } });
    const body = await (await app.request("/api/settings/config")).json();
    expect(body.webSearch.kinds[0].fields[0].options).toEqual([{ value: "p/old", label: "p/old" }, { value: "p/m1", label: "p/m1 · Responses" }]);
  });
});

test("web search: a use this build lacks reads as off and keeps its values", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    writeConfig(dir, { webSearch: { use: "retired", kinds: { retired: { key: "v" } } } });
    const body = await (await app.request("/api/settings/config")).json();
    expect(body.webSearch.use).toBe("off");
    expect((await postWebSearch(app, { kinds: { exa: { apiKey: "ex" } } })).status).toBe(200);
    expect(readConfigFile(dir).webSearch.kinds.retired).toEqual({ key: "v" });
  });
});

test("web search: each kind's setup is kept across choices; a blank key keeps the key, null removes it", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    expect((await postWebSearch(app, { use: "exa", kinds: { exa: { apiKey: " ex-key " } } })).status).toBe(200);
    expect(readConfigFile(dir).webSearch).toEqual({ use: "exa", kinds: { exa: { apiKey: "ex-key" } } });
    expect((await postWebSearch(app, { use: "searxng", kinds: { searxng: { address: "https://s.test" } } })).status).toBe(200);
    expect(readConfigFile(dir).webSearch).toEqual({ use: "searxng", kinds: { exa: { apiKey: "ex-key" }, searxng: { address: "https://s.test" } } });
    await postWebSearch(app, { kinds: { exa: { apiKey: "" } } });
    expect(readConfigFile(dir).webSearch.kinds.exa).toEqual({ apiKey: "ex-key" });
    const body = await (await postWebSearch(app, { kinds: { exa: { apiKey: null } } })).json();
    expect(readConfigFile(dir).webSearch.kinds.exa).toBeUndefined();
    expect(body.webSearch.kinds.find((k: { id: string }) => k.id === "exa").fields[0].configured).toBe(false);
    await postWebSearch(app, { kinds: { searxng: { address: "" } } });
    await postWebSearch(app, { use: "off" });
    expect(fs.existsSync(path.join(dir, "config.json")) ? readConfigFile(dir).webSearch : undefined).toBeUndefined();
  });
});

test("web search: an unknown kind, an unknown field, a bad address and a bad choice are refused", async () => {
  await withSettingsApp(async ({ app }) => {
    for (const [patch, error] of [
      [{ use: "bing" }, "webSearch.use is not supported"],
      [{ kinds: { bing: { apiKey: "x" } } }, "bing is not supported"],
      [{ kinds: { exa: { region: "cn" } } }, "region is not supported"],
      [{ kinds: { searxng: { address: "ftp://s.test" } } }, "Address must be an http or https address"],
      [{ kinds: { model: { effort: "huge" } } }, "effort is not supported"],
      [{ kinds: { exa: { apiKey: 7 } } }, "apiKey must be a string"]
    ] as const) {
      const res = await postWebSearch(app, patch);
      expect([res.status, (await res.json()).error]).toEqual([400, error]);
    }
  });
});

// Kilo's per-model tags are internal: a listing hands them to the registry and
// they stay out of every Settings answer, a check's cached listing included.
test("settings provider models: Kilo's tags stay out of the answer after a check fills the catalog", async () => {
  const handed: Array<[string, Record<string, string>]> = [];
  await withSettingsApp(async ({ app }) => {
    const saved = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: { providers: { kilo: { type: "kilo", apiKey: "sk-kilo", models: [{ id: "vendor/claude-x", input: ["text"] }] } } } })
    });
    expect(saved.status).toBe(200);
    expect((await checkProxy(app, {}, "kilo")).body.result).toBe("ready");
    const body = await (await app.request("/api/settings/providers/kilo/models")).json();
    expect(body.models.map((m: { id: string }) => m.id)).toContain("vendor/claude-x");
    expect("kiloApis" in body).toBe(false);
    // Both the check and a fresh listing hand the tags to the registry.
    await app.request("/api/settings/providers/kilo/models?refresh=1");
    expect(handed).toEqual([["kilo", { "vendor/claude-x": "messages" }], ["kilo", { "vendor/claude-x": "messages" }]]);
  }, {}, {
    httpClient: { fetch: async () => Response.json({ data: [{ id: "vendor/claude-x", opencode: { ai_sdk_provider: "anthropic" } }] }) },
    onKiloModelApis: (connection, apis) => { handed.push([connection, Object.fromEntries(apis)]); }
  });
});

// A Kilo list depends on the organisation: a listing for the old one that
// lands after the organisation changed is never served for the new one.
test("settings provider models: a Kilo listing for the old organisation that lands after a change is never served", async () => {
  let releaseFirst: (() => void) | null = null;
  let calls = 0;
  const saveKilo = async (app: Hono, organizationId: string) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: { providers: { kilo: { type: "kilo", apiKey: "sk-kilo", organizationId, models: [{ id: "vendor/model-x", input: ["text"] }] } } } })
    });
    expect(res.status).toBe(200);
  };
  await withSettingsApp(async ({ app }) => {
    await saveKilo(app, "org-one");
    const first = app.request("/api/settings/providers/kilo/models");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await saveKilo(app, "org-two");
    releaseFirst!();
    await first;
    const body = await (await app.request("/api/settings/providers/kilo/models")).json();
    expect(body.models.map((m: { id: string }) => m.id)).toContain("model-for-org-two");
    expect(body.models.map((m: { id: string }) => m.id)).not.toContain("model-for-org-one");
  }, {}, { httpClient: { fetch: async (_url, init) => {
    calls += 1;
    const org = new Headers(init?.headers).get("x-kilocode-organizationid") ?? "";
    const answer = () => Response.json({ data: [{ id: `model-for-${org}` }] });
    if (calls === 1) return new Promise<Response>((resolve) => { releaseFirst = () => resolve(answer()); });
    return answer();
  } } });
});

test("settings config: idle compaction round-trips, is kept on a save, and is refused out of range", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    const get = async () => (await (await app.request("/api/settings/config")).json()).agent;
    const post = (agent: Record<string, unknown>) => app.request("/api/settings/config", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent })
    });
    expect(await get()).toMatchObject({ idleCompactionEnabled: true, idleCompactionLeadMinutes: 5, idleCompactionMinTokens: 200000 });
    expect((await post({ idleCompactionEnabled: false, idleCompactionLeadMinutes: 10, idleCompactionMinTokens: 150000 })).status).toBe(200);
    expect((await post({ preferences: "Prefer short replies." })).status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).agent;
    expect(saved).toMatchObject({ idleCompactionEnabled: false, idleCompactionLeadMinutes: 10, idleCompactionMinTokens: 150000 });
    expect(await get()).toMatchObject({ idleCompactionEnabled: false, idleCompactionLeadMinutes: 10, idleCompactionMinTokens: 150000 });
    for (const bad of [
      { idleCompactionLeadMinutes: 0 }, { idleCompactionLeadMinutes: 60 }, { idleCompactionMinTokens: 999 },
      // Whole numbers only, no coercion.
      { idleCompactionLeadMinutes: true }, { idleCompactionLeadMinutes: "10" }, { idleCompactionLeadMinutes: [10] },
      { idleCompactionLeadMinutes: 7.5 }, { idleCompactionMinTokens: 150000.5 }, { idleCompactionMinTokens: "150000" }
    ]) {
      expect((await post(bad)).status).not.toBe(200);
    }
  });
});
