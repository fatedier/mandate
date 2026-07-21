import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../src/server/config.js";
import { DEFAULT_AGENT_PREFERENCES } from "../src/server/config/defaults.js";
import {
  mountSettingsRoutes,
  type SettingsRoutesDeps
} from "../src/server/modules/settings/settings-routes.js";
import { saveCodexTokens } from "../src/server/modules/codex/codex-auth-store.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-settings-"));
  const previous = snapshotEnv(SETTINGS_ENV_KEYS);

  for (const key of SETTINGS_ENV_KEYS) delete process.env[key];
  process.env.MANDATE_DATA_DIR = dir;
  for (const [key, value] of Object.entries(env) as [SettingsEnvKey, string | undefined][]) {
    restoreEnv(key, value);
  }

  const app = new Hono();
  mountSettingsRoutes(app, routeDeps);

  const restore = () => {
    restoreEnvSnapshot(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return Promise.resolve(fn({ dir, app })).finally(restore);
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
    expect(body.agent.preferences).toBe(DEFAULT_AGENT_PREFERENCES);
    expect(body.agent.compressionThresholdTokens).toBe(200000);
    expect(body.agent.managerModel).toEqual({ model: "", reasoningEffort: "provider-default" });
    expect(body.agent.workerModel).toEqual({ model: "", reasoningEffort: "provider-default" });
    expect(body.agent.modelOverrides).toEqual({ manager: false, worker: false });
    expect(body.agent.manager.model).toBe("");
    expect(body.agent.worker.model).toBe("");
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
      expect(reloadedThresholds).toEqual([128000, 200000]);
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
      expect(body.agent.modelOverrides).toEqual({ manager: true, worker: true });
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
    expect(body.agent.modelOverrides).toEqual({ manager: false, worker: false });

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
    expect(body.agent.modelOverrides).toEqual({ manager: true, worker: true });

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
    expect(body.agent.modelOverrides).toEqual({ manager: false, worker: false });
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
    expect(body.agent.manager.apiKeyConfigured).toBe(true);
    expect(body.agent.worker.apiKeyConfigured).toBe(true);
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

test("settings config: rejects unsupported agent model reasoning effort", async () => {
  await withSettingsApp(async ({ app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: {
          managerModel: {
            model: "work/gpt-5.5",
            reasoningEffort: "extreme"
          }
        }
      })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("reasoningEffort is not supported");
  });
});

test("settings config: rejects unsupported default model reasoning effort", async () => {
  await withSettingsApp(async ({ app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          default: {
            model: "work/gpt-5.5",
            reasoningEffort: "extreme"
          }
        }
      })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("reasoningEffort is not supported");
  });
});

test("settings config: POST prunes unknown section keys", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        analysis: { maxConcurrent: 2, unexpected: true },
        agent: { maxStepsPerWake: 25, unexpected: true },
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
        agent: { maxStepsPerWake: 50 },
        memory: { dream: { enabled: false } }
      })
    });
    expect(res.status).toBe(200);

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(file.analysis).toBeUndefined();
    expect(file.agent).toEqual({ maxStepsPerWake: 50 });
    expect(file.memory).toEqual({
      embedding: { model: "" },
      dream: { enabled: false }
    });
  });
});

test("settings config: rejects invalid server host and port", async () => {
  await withSettingsApp(async ({ app }) => {
    let res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server: {
          host: " "
        }
      })
    });
    expect(res.status).toBe(400);
    let body = await res.json();
    expect(body.error).toMatch(/server\.host/);

    res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server: {
          port: 70000
        }
      })
    });
    expect(res.status).toBe(400);
    body = await res.json();
    expect(body.error).toMatch(/server\.port/);
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
            model: "llm-proxy/gpt-5.5"
          },
          providers: {
            "llm-proxy": { type: "openai-compatible", apiKey: "sk-1" },
            OpenAIProxy: { type: "openai", apiKey: "sk-2" }
          }
        }
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.models.providers)).toEqual(["llm-proxy", "OpenAIProxy"]);
    expect(body.models.default.model).toBe("llm-proxy/gpt-5.5");

    const file = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(Object.keys(file.models.providers)).toEqual(["llm-proxy", "OpenAIProxy"]);
  });
});

test("settings config: rejects unsupported provider types", async () => {
  await withSettingsApp(async ({ app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          providers: {
            proxy: { type: "unsupported-provider", apiKey: "sk-proxy" }
          }
        }
      })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "type is not supported" });
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
    expect(body.agent.manager).toMatchObject({
      model: "kilo/kilo-auto/balanced",
      provider: "kilo",
      apiKeyConfigured: true
    });
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

test("settings provider models: a provider without a key never fetches", async () => {
  let fetchCount = 0;
  await withSettingsApp(
    async ({ app }) => {
      const saveRes = await app.request("/api/settings/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          models: {
            providers: {
              keyless: {
                type: "openai",
                models: [{ id: "gpt-4.1-mini", input: ["text"] }]
              }
            }
          }
        })
      });
      expect(saveRes.status).toBe(200);

      const res = await app.request("/api/settings/providers/keyless/models");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(fetchCount).toBe(0);
      expect(body.source).toBe("configured");
      expect(body.models.map((m: { id: string }) => m.id)).toEqual(["gpt-4.1-mini"]);
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

test("settings config: rejects invalid provider model reasoning support", async () => {
  await withSettingsApp(async ({ app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          providers: {
            work: {
              type: "openai",
              apiKey: "sk-work",
              models: [{ id: "gpt-5.5", input: ["text"], supportsReasoning: "force" }]
            }
          }
        }
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("supportsReasoning must be a boolean");
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
    expect(body.agent.worker.apiKeyConfigured).toBe(false);
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
    expect(body.agent.worker.apiKeyConfigured).toBe(true);
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

test("settings config: rejects voice context message count above shared limit", async () => {
  await withSettingsApp(async ({ app }) => {
    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        voice: {
          contextMessageCount: 101
        }
      })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("contextMessageCount");
  });
});

test("settings config: renaming an OpenAI Codex provider moves its OAuth profile", async () => {
  await withSettingsApp(async ({ dir, app }) => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        models: {
          providers: {
            Codex: { type: "codex" }
          }
        }
      }),
      "utf8"
    );
    saveCodexTokens(
      "Codex",
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

    const res = await app.request("/api/settings/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: {
          providers: {
            codex: {
              previousName: "Codex",
              type: "codex"
            }
          }
        }
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.models.providers)).toEqual(["codex"]);
    expect(body.models.providers.codex.auth).toMatchObject({
      status: "authenticated",
      configured: true,
      email: "dev@example.test",
      accountId: "acct_test",
      profileId: "codex:default"
    });

    const authFile = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    expect(Object.keys(authFile.profiles)).toEqual(["codex:default"]);
    expect(authFile.profiles["codex:default"].providerName).toBe("codex");
    expect(authFile.providerDefaults).toEqual({ codex: "codex:default" });
  });
});

test.each([
  { agent: { maxStepsPerWake: 25 } },
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
