import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, modelSupportsInput } from "../src/server/config.js";
import type { RetentionConfig } from "../src/server/config/types.js";
import { tempDir } from "./helpers/temp.js";
import { applyAgentPatch } from "../src/server/modules/settings/config-section-patches.js";

function withCleanEnv(fn) {
  const keys = [
    "PORT",
    "MANDATE_POLL_INTERVAL_MS",
    "MANDATE_CAPTURE_LINES",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_API_KEY",
    "MANDATE_AGENT_MANAGER_MODEL",
    "MANDATE_AGENT_WORKER_MODEL",
    "MANDATE_AGENT_OVERVIEW_MODEL",
    "MANDATE_AGENT_FEATURE_MODEL",
    "MANDATE_AGENT_MAX_STEPS",
    "MANDATE_AGENT_LOG_REQUESTS",
    "MANDATE_LOG_LEVEL",
    "MANDATE_DEBUG"
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    delete process.env[key];
  }

  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (previous.get(key) === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous.get(key);
      }
    }
  }
}

function withTempConfig(config, fn) {
  return withCleanEnv(() => {
    const dir = tempDir("mandate-config-");
    if (config) {
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf8");
    }
    return fn(dir);
  });
}

test("loadConfig defaults memory config", () => {
  withTempConfig(null, (dir) => {
    expect(loadConfig(dir).memory.embedding.model).toBe("");
    expect(loadConfig(dir).memory.dream.enabled).toBe(true);
  });
});

// The cache seal's switch is in the file alone (no Settings control): on
// unless the file says false.
test("agent.cacheSealEnabled is on unless the file says false", () => {
  withTempConfig(null, (dir) => expect(loadConfig(dir).agent.cacheSealEnabled).toBe(true));
  withTempConfig({ agent: { cacheSealEnabled: true } }, (dir) => expect(loadConfig(dir).agent.cacheSealEnabled).toBe(true));
  withTempConfig({ agent: { cacheSealEnabled: false } }, (dir) => expect(loadConfig(dir).agent.cacheSealEnabled).toBe(false));
});

test("saving the agent section from Settings keeps cacheSealEnabled", () => {
  const root = { agent: { cacheSealEnabled: false, preferences: "old" } };
  applyAgentPatch(root, { preferences: "new" });
  expect(root.agent).toEqual({ cacheSealEnabled: false, preferences: "new" });
});

test("loadConfig reads memory config", () => {
  withTempConfig(
    {
      memory: {
        embedding: {
          model: "openai/text-embedding-3-small"
        },
        dream: {
          enabled: false
        }
      }
    },
    (dir) => {
      const memory = loadConfig(dir).memory;
      expect(memory.embedding.model).toBe("openai/text-embedding-3-small");
      expect(memory.dream.enabled).toBe(false);
    }
  );
});

// Each row writes a retention block into config.json and reads back the fields
// it names. toMatchObject compares numbers strictly, so a quoted "2500" read
// back as a string fails its row.
const retentionCases: { name: string; retention: unknown; expected: Partial<RetentionConfig> }[] = [
  {
    // Unspecified fields must fall back to their defaults rather than
    // becoming undefined -- retention needs the same field-by-field merge
    // memory and voice already get, not a whole-object replace.
    name: "loadConfig deep-merges a partial retention override with the defaults",
    retention: { chatRetentionDays: 30 },
    expected: { chatRetentionDays: 30, chatMaxTableBytes: 512 * 1024 * 1024, chatToolResultHeadChars: 2000 }
  },
  // config.json is hand-editable, this block deletes text irreversibly on an hourly
  // unattended job, and the most natural way to type "turn it off" -- a zero -- was
  // the single most destructive value it accepted. Each value in this row is one a
  // person could plausibly write.
  {
    name: "loadConfig rejects retention values that would destroy data",
    retention: {
      // "Off", as a user would guess it: every thread instantly past the
      // window, hourly, with no confirmation.
      chatRetentionDays: 0,
      // A head of zero leaves nothing but the marker.
      chatToolResultHeadChars: 0,
      // A ceiling every real database is permanently over silently converts
      // the age-gated policy into "shorten everything".
      chatMaxTableBytes: 0
    },
    expected: { chatRetentionDays: 90, chatToolResultHeadChars: 2000, chatMaxTableBytes: 512 * 1024 * 1024 }
  },
  {
    // SQLite orders every INTEGER below every TEXT value, so a string bound
    // into `length(content) > ?` is false for every row and the pass does
    // nothing at all, silently and forever.
    name: "loadConfig coerces quoted retention numbers instead of passing strings to SQLite",
    retention: { chatToolResultHeadChars: "2500", chatRetentionDays: "45" },
    expected: { chatToolResultHeadChars: 2500, chatRetentionDays: 45 }
  },
  {
    // NaN days reaches new Date(NaN).toISOString(), which throws inside the
    // retention job's catch -- an hourly failure with no visible symptom.
    name: "loadConfig falls back when a retention value is not a number at all",
    retention: { chatRetentionDays: "abc", chatToolResultHeadChars: null },
    expected: { chatRetentionDays: 90, chatToolResultHeadChars: 2000 }
  },
  {
    // The floors must not swallow legitimate tuning: a week-long window, a small
    // but usable head, and a 64 MB ceiling are all things a user may mean.
    name: "loadConfig keeps retention values that are merely unusual",
    retention: { chatRetentionDays: 7, chatToolResultHeadChars: 500, chatMaxTableBytes: 64 * 1024 * 1024 },
    expected: { chatRetentionDays: 7, chatToolResultHeadChars: 500, chatMaxTableBytes: 64 * 1024 * 1024 }
  },
  {
    name: "loadConfig replaces a retention block that is not an object",
    retention: "off",
    expected: { chatRetentionDays: 90, chatToolResultHeadChars: 2000 }
  }
];

test.each(retentionCases)("$name", ({ retention, expected }) => {
  withTempConfig({ retention }, (dir) => {
    expect(loadConfig(dir).retention).toMatchObject(expected);
  });
});

test("loadConfig normalizes provider defaults and environment API keys", () => {
  withTempConfig(
    {
      models: {
        providers: {
          google: { type: "google" }
        }
      }
    },
    (dir) => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-key";
      const config = loadConfig(dir);

      expect(config.models.providers.google).toMatchObject({
        type: "google",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "google-key"
      });
    }
  );
});

test("loadConfig resolves Kilo Gateway provider settings", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "kilo/kilo-auto/balanced"
        },
        providers: {
          kilo: {
            type: "kilo",
            apiKey: "sk-kilo",
            organizationId: "org_abc"
          }
        }
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.models.providers.kilo).toMatchObject({
        type: "kilo",
        baseURL: "https://api.kilo.ai/api/gateway",
        apiKey: "sk-kilo",
        organizationId: "org_abc"
      });
      expect(config.agent.worker).toMatchObject({
        providerName: "kilo",
        provider: "kilo",
        model: "kilo-auto/balanced",
        modelRef: "kilo/kilo-auto/balanced",
        baseURL: "https://api.kilo.ai/api/gateway",
        apiKey: "sk-kilo",
        organizationId: "org_abc"
      });
    }
  );
});

test("loadConfig resolves models.default and provider credentials", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "main/gpt-4.1"
        },
        providers: {
          main: {
            type: "openai",
            apiKey: "openai-key",
            baseURL: "https://openai.example/v1",
            models: [
              { id: "gpt-4.1", input: ["text", "image", "audio", "video", "document"] },
              { id: "gpt-4.1-mini", input: ["text"] }
            ]
          }
        }
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.models.default.model).toBe("main/gpt-4.1");
      expect(config.models.providers.main.type).toBe("openai");
      expect(config.models.providers.main.models).toEqual([
        { id: "gpt-4.1", input: ["text", "image", "audio", "video", "document"] },
        { id: "gpt-4.1-mini", input: ["text"] }
      ]);
      expect(modelSupportsInput(config, "main/gpt-4.1", "text")).toBe(true);
      expect(modelSupportsInput(config, "main/gpt-4.1", "image")).toBe(true);
      expect(modelSupportsInput(config, "main/gpt-4.1", "audio")).toBe(true);
      expect(modelSupportsInput(config, "main/gpt-4.1-mini", "text")).toBe(true);
      expect(modelSupportsInput(config, "main/gpt-4.1-mini", "image")).toBe(false);
      expect(config.agent.worker).toMatchObject({
        providerName: "main",
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "openai-key"
      });
    }
  );
});

test("loadConfig resolves default and role-specific model fallbacks", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "main/gpt-5.5",
          modelFallbacks: ["backup/gpt-5.5", "main/gpt-5.5"]
        },
        providers: {
          main: { type: "openai", apiKey: "main-key" },
          backup: {
            type: "openai-compatible",
            apiKey: "backup-key",
            baseURL: "https://backup.example/v1"
          }
        }
      },
      agent: {
        managerModel: "main/gpt-5.5",
        managerModelFallbacks: []
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.models.default.modelFallbacks).toEqual([{
        model: "backup/gpt-5.5",
        reasoningEffort: "provider-default"
      }]);
      expect(config.agent.managerModelFallbacks).toEqual([]);
      expect(config.agent.managerFallbacks).toEqual([]);
      expect(config.agent.workerModelFallbacks).toEqual([{
        model: "backup/gpt-5.5",
        reasoningEffort: "provider-default"
      }]);
      expect(config.agent.workerFallbacks).toEqual([
        expect.objectContaining({
          providerName: "backup",
          provider: "openai-compatible",
          model: "gpt-5.5",
          modelRef: "backup/gpt-5.5",
          reasoningEffort: "provider-default",
          apiKey: "backup-key",
          baseURL: "https://backup.example/v1"
        })
      ]);
    }
  );
});

test("loadConfig supports reasoning effort on the default model selection", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "main/gpt-5.5",
          reasoningEffort: "medium",
          modelFallbacks: [
            { model: "backup/claude-sonnet-4-6", reasoningEffort: "low" },
            { model: "main/gpt-5.5", reasoningEffort: "high" }
          ]
        },
        providers: {
          main: { type: "openai", apiKey: "main-key" },
          backup: { type: "anthropic", apiKey: "backup-key" }
        }
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.models.default.reasoningEffort).toBe("medium");
      expect(config.models.default.modelFallbacks).toEqual([{
        model: "backup/claude-sonnet-4-6",
        reasoningEffort: "low"
      }]);
      expect(config.agent.managerModel).toEqual({
        model: "main/gpt-5.5",
        reasoningEffort: "medium"
      });
      expect(config.agent.workerModel).toEqual({
        model: "main/gpt-5.5",
        reasoningEffort: "medium"
      });
      expect(config.agent.workerModelFallbacks).toEqual([{
        model: "backup/claude-sonnet-4-6",
        reasoningEffort: "low"
      }]);
      expect(config.agent.worker).toMatchObject({
        modelRef: "main/gpt-5.5",
        reasoningEffort: "medium"
      });
      expect(config.agent.workerFallbacks[0]).toMatchObject({
        modelRef: "backup/claude-sonnet-4-6",
        reasoningEffort: "low"
      });
    }
  );
});

test("loadConfig resolves reasoning support from provider model capabilities", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "main/gpt-5.5",
          reasoningEffort: "high",
          modelFallbacks: [
            { model: "backup/claude-sonnet-4-6", reasoningEffort: "medium" }
          ]
        },
        providers: {
          main: {
            type: "openai",
            apiKey: "main-key",
            models: [{ id: "gpt-5.5", input: ["text"], supportsReasoning: true }]
          },
          backup: {
            type: "anthropic",
            apiKey: "backup-key",
            models: [{ id: "claude-sonnet-4-6", input: ["text"], supportsReasoning: false }]
          }
        }
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.models.providers.main.models[0]).toMatchObject({
        id: "gpt-5.5",
        supportsReasoning: true
      });
      expect(config.models.providers.backup.models[0]).toMatchObject({
        id: "claude-sonnet-4-6",
        supportsReasoning: false
      });
      expect(config.agent.manager).toMatchObject({
        modelRef: "main/gpt-5.5",
        reasoningEffort: "high",
        supportsReasoning: true
      });
      expect(config.agent.workerFallbacks[0]).toMatchObject({
        modelRef: "backup/claude-sonnet-4-6",
        reasoningEffort: "medium",
        supportsReasoning: false
      });
    }
  );
});

test("loadConfig keeps a model's protocol on a custom provider only, and drops unknown values", () => {
  withTempConfig(
    {
      models: {
        providers: {
          proxy: {
            type: "openai-compatible",
            baseURL: "http://127.0.0.1:9/v1",
            apiKey: "proxy-key",
            models: [
              { id: "model-a", protocol: "messages" },
              { id: "model-b", protocol: "chat" },
              { id: "model-c", protocol: "responses" },
              { id: "model-d", protocol: "carrier-pigeon" }
            ]
          },
          direct: {
            type: "openai",
            apiKey: "direct-key",
            models: [{ id: "model-e", protocol: "messages" }]
          }
        }
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.models.providers.proxy.models.map((m) => [m.id, m.protocol ?? null])).toEqual([
        ["model-a", "messages"],
        ["model-b", "chat"],
        ["model-c", null],
        ["model-d", null]
      ]);
      expect(config.models.providers.direct.models[0].protocol).toBeUndefined();
    }
  );
});

test("loadConfig treats null agent model selections as default inheritance", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "main/gpt-5.5",
          reasoningEffort: "high",
          modelFallbacks: [
            { model: "backup/claude-sonnet-4-6", reasoningEffort: "medium" }
          ]
        },
        providers: {
          main: { type: "openai", apiKey: "main-key" },
          backup: { type: "anthropic", apiKey: "backup-key" }
        }
      },
      agent: {
        managerModel: null,
        managerModelFallbacks: null,
        workerModel: null,
        workerModelFallbacks: null
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.agent.managerModel).toEqual({
        model: "main/gpt-5.5",
        reasoningEffort: "high"
      });
      expect(config.agent.workerModel).toEqual({
        model: "main/gpt-5.5",
        reasoningEffort: "high"
      });
      expect(config.agent.managerModelFallbacks).toEqual([{
        model: "backup/claude-sonnet-4-6",
        reasoningEffort: "medium"
      }]);
      expect(config.agent.workerModelFallbacks).toEqual([{
        model: "backup/claude-sonnet-4-6",
        reasoningEffort: "medium"
      }]);
    }
  );
});

test("loadConfig supports reasoning effort on selected agent models", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "main/gpt-5.5"
        },
        providers: {
          main: { type: "openai", apiKey: "main-key" },
          backup: { type: "anthropic", apiKey: "backup-key" }
        }
      },
      agent: {
        managerModel: { model: "main/gpt-5.5", reasoningEffort: "high" },
        managerModelFallbacks: [
          { model: "backup/claude-sonnet-4-6", reasoningEffort: "medium" }
        ],
        workerModel: { model: "main/gpt-5-mini", reasoningEffort: "minimal" },
        workerModelFallbacks: [
          { model: "backup/claude-haiku-4-5", reasoningEffort: "low" }
        ]
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.agent.managerModel).toEqual({
        model: "main/gpt-5.5",
        reasoningEffort: "high"
      });
      expect(config.agent.manager).toMatchObject({
        modelRef: "main/gpt-5.5",
        reasoningEffort: "high"
      });
      expect(config.agent.managerFallbacks[0]).toMatchObject({
        modelRef: "backup/claude-sonnet-4-6",
        reasoningEffort: "medium"
      });
      expect(config.agent.worker).toMatchObject({
        modelRef: "main/gpt-5-mini",
        reasoningEffort: "minimal"
      });
      expect(config.agent.workerFallbacks[0]).toMatchObject({
        modelRef: "backup/claude-haiku-4-5",
        reasoningEffort: "low"
      });
    }
  );
});

test("loadConfig supports OpenAI Codex OAuth providers without API keys", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "codex/gpt-5.5"
        },
        providers: {
          codex: {
            type: "codex",
            apiKey: "ignored-key",
            serviceTier: "priority"
          }
        }
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.models.providers.codex).toMatchObject({
        type: "codex",
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "",
        serviceTier: "priority"
      });
      expect(config.agent.worker).toMatchObject({
        providerName: "codex",
        provider: "codex",
        model: "gpt-5.5",
        modelRef: "codex/gpt-5.5",
        apiKey: "",
        serviceTier: "priority"
      });
      expect(modelSupportsInput(config, "codex/gpt-5.5", "image")).toBe(true);
    }
  );
});

test("retired agent config keys do not override default routing", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "main/gpt-5.5",
          reasoningEffort: "medium",
          modelFallbacks: ["backup/claude-sonnet-4-6"]
        },
        providers: {
          main: { type: "openai", apiKey: "main-key" },
          backup: { type: "anthropic", apiKey: "backup-key" }
        }
      },
      agent: {
        overviewModel: "backup/claude-opus-4-7",
        overviewModelFallbacks: ["backup/claude-haiku-4-5"],
        featureModel: "main/gpt-5-mini",
        featureModelFallbacks: []
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      for (const role of ["manager", "worker"] as const) {
        expect(config.agent[role].modelRef).toBe("main/gpt-5.5");
        expect(config.agent[role].reasoningEffort).toBe("medium");
      }
      expect(config.agent.managerModelFallbacks.map((f) => f.model)).toEqual(["backup/claude-sonnet-4-6"]);
      expect(config.agent.workerModelFallbacks.map((f) => f.model)).toEqual(["backup/claude-sonnet-4-6"]);
    }
  );
});

test("a provider needs its type and a model ref its provider: neither is guessed from a name", () => {
  withTempConfig(
    {
      models: {
        default: { model: "main/gpt-5.5" },
        providers: {
          main: { type: "openai", apiKey: "main-key" },
          openai: { apiKey: "untyped-key" }
        }
      },
      agent: { workerModel: "gpt-5-mini", workerModelFallbacks: ["gpt-5-nano", "main/gpt-5-mini"] }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(Object.keys(config.models.providers)).toEqual(["main"]);
      expect(config.agent.worker.modelRef).toBe("main/gpt-5.5");
      expect(config.agent.workerModelFallbacks.map((f) => f.model)).toEqual(["main/gpt-5-mini"]);
    }
  );
});

test("retired agent model environment variables do not override default routing", () => {
  withTempConfig(
    {
      models: {
        default: { model: "main/gpt-5.5" },
        providers: {
          main: { type: "openai", apiKey: "main-key" },
          backup: { type: "anthropic", apiKey: "backup-key" }
        }
      }
    },
    (dir) => {
      process.env.MANDATE_AGENT_OVERVIEW_MODEL = "backup/claude-opus-4-7";
      process.env.MANDATE_AGENT_FEATURE_MODEL = "main/gpt-5-mini";
      process.env.MANDATE_AGENT_MANAGER_MODEL = "backup/claude-opus-4-7";
      process.env.MANDATE_AGENT_WORKER_MODEL = "main/gpt-5-mini";
      const config = loadConfig(dir);
      expect(config.agent.manager.modelRef).toBe("main/gpt-5.5");
      expect(config.agent.worker.modelRef).toBe("main/gpt-5.5");
    }
  );
});

test("loadConfig supports manager and worker agent model overrides", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "claude/claude-sonnet-4-6"
        },
        providers: {
          claude: { type: "anthropic", apiKey: "anthropic-key" },
          work: { type: "openai", apiKey: "openai-key" }
        }
      },
      agent: {
        managerModel: "claude/claude-opus-4-7",
        workerModel: "work/gpt-5-mini"
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.agent.manager).toMatchObject({
        providerName: "claude",
        provider: "anthropic",
        model: "claude-opus-4-7",
        modelRef: "claude/claude-opus-4-7",
        apiKey: "anthropic-key"
      });
      expect(config.agent.worker).toMatchObject({
        providerName: "work",
        provider: "openai",
        model: "gpt-5-mini",
        modelRef: "work/gpt-5-mini",
        apiKey: "openai-key"
      });
    }
  );
});

test("loadConfig defaults models and providers to empty on first run", () => {
  withTempConfig(null, (dir) => {
    const config = loadConfig(dir);
    expect(config.models.default.model).toBe("");
    expect(config.models.providers).toEqual({});
    expect(config.agent.manager.modelRef).toBe("");
    expect(config.agent.worker.modelRef).toBe("");
  });
});

test("loadConfig supports runtime log level", () => {
  withTempConfig(null, (dir) => {
    expect(loadConfig(dir).logging.level).toBe("info");
  });
  withTempConfig({ logging: { level: "debug" } }, (dir) => {
    expect(loadConfig(dir).logging.level).toBe("debug");
  });
  withTempConfig({ logging: { level: "invalid" } }, (dir) => {
    expect(loadConfig(dir).logging.level).toBe("info");
  });
  withTempConfig({ logging: { level: "warn" } }, (dir) => {
    process.env.MANDATE_LOG_LEVEL = "error";
    expect(loadConfig(dir).logging.level).toBe("error");
  });
  withTempConfig({ logging: { level: "warn" } }, (dir) => {
    process.env.MANDATE_DEBUG = "1";
    expect(loadConfig(dir).logging.level).toBe("debug");
  });
});

test("capabilities default on: unmarked reasoning resolves true, a missing input reads as text+image, an unlisted model takes images", () => {
  withTempConfig(
    {
      models: {
        default: {
          model: "gw/unmarked",
          modelFallbacks: [{ model: "gw/marked-off" }, { model: "gw/not-listed" }]
        },
        providers: {
          gw: {
            type: "openai-compatible",
            apiKey: "k",
            baseURL: "https://gw.example/v1",
            models: [{ id: "unmarked" }, { id: "marked-off", input: ["text"], supportsReasoning: false }]
          }
        }
      }
    },
    (dir) => {
      const config = loadConfig(dir);
      expect(config.models.providers.gw.models).toEqual([
        { id: "unmarked", input: ["text", "image"] },
        { id: "marked-off", input: ["text"], supportsReasoning: false }
      ]);
      expect(config.agent.worker.supportsReasoning).toBe(true);
      expect(config.agent.workerFallbacks.map((f) => [f.modelRef, f.supportsReasoning])).toEqual([
        ["gw/marked-off", false],
        ["gw/not-listed", true]
      ]);
      expect([
        modelSupportsInput(config, "gw/unmarked", "image"),
        modelSupportsInput(config, "gw/marked-off", "image"),
        modelSupportsInput(config, "gw/not-listed", "image"),
        modelSupportsInput(config, "gw/not-listed", "audio")
      ]).toEqual([true, false, true, false]);
    }
  );
});

// Your agent's, the dream's and memory extraction's routes each read the same
// way; setting one leaves every other route on the default's.
const ownRoutes: { name: string; route: "global" | "dream" | "extraction" }[] = [
  { name: "Your agent's route is the default when unset or null, and its own when set", route: "global" },
  { name: "the dream's route is the default when unset or null, and its own when set", route: "dream" },
  { name: "memory extraction's route is the default when unset or null, and its own when set", route: "extraction" }
];

test.each(ownRoutes)("$name", ({ route }) => {
  const models = {
    default: { model: "main/gpt-5.5", reasoningEffort: "high", modelFallbacks: ["backup/gpt-5.5"] },
    providers: {
      main: { type: "openai", apiKey: "main-key" },
      backup: { type: "openai-compatible", apiKey: "backup-key", baseURL: "https://backup.example/v1" }
    }
  };
  const defaultFirst = { model: "main/gpt-5.5", reasoningEffort: "high" } as const;
  // Unset, though the manager has a route of its own: the default's, not the manager's.
  withTempConfig({ models, agent: { managerModel: "backup/gpt-5.5", managerModelFallbacks: [] } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect(agent[`${route}Model`]).toEqual(defaultFirst);
    expect(agent[route]).toEqual(expect.objectContaining({ providerName: "main", model: "gpt-5.5", modelRef: "main/gpt-5.5" }));
    expect(agent[`${route}ModelFallbacks`]).toEqual([{ model: "backup/gpt-5.5", reasoningEffort: "provider-default" }]);
    expect(agent[`${route}Fallbacks`]).toEqual([expect.objectContaining({ providerName: "backup", modelRef: "backup/gpt-5.5" })]);
  });
  withTempConfig({ models, agent: { [`${route}Model`]: null, [`${route}ModelFallbacks`]: null } }, (dir) => {
    expect(loadConfig(dir).agent[`${route}Model`]).toEqual(defaultFirst);
  });
  withTempConfig({ models, agent: {
    [`${route}Model`]: { model: "backup/gpt-5.5", reasoningEffort: "low" },
    [`${route}ModelFallbacks`]: [{ model: "main/gpt-5.5", reasoningEffort: "low" }]
  } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect(agent[`${route}Model`]).toEqual({ model: "backup/gpt-5.5", reasoningEffort: "low" });
    expect(agent[route]).toEqual(expect.objectContaining({ providerName: "backup", modelRef: "backup/gpt-5.5", reasoningEffort: "low" }));
    // Its own fallbacks, not the default's.
    expect(agent[`${route}ModelFallbacks`]).toEqual([{ model: "main/gpt-5.5", reasoningEffort: "low" }]);
    expect(agent[`${route}Fallbacks`]).toEqual([expect.objectContaining({ modelRef: "main/gpt-5.5" })]);
    // The other routes stay the default's.
    for (const other of ["manager", "global", "dream", "extraction"] as const) {
      if (other !== route) expect(agent[`${other}Model`]).toEqual(defaultFirst);
    }
  });
});

test("the page updates' route is set only where the file sets it, apart from the subagent route", () => {
  const models = {
    default: { model: "main/gpt-5.5", reasoningEffort: "high", modelFallbacks: [] },
    providers: {
      main: { type: "openai", apiKey: "main-key" },
      backup: { type: "openai-compatible", apiKey: "backup-key", baseURL: "https://backup.example/v1" }
    }
  };
  withTempConfig({ models, agent: { subagentModel: "backup/gpt-5.5", subagentModelFallbacks: [] } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect([agent.subagentRouteSet, agent.pageRouteSet, agent.page.modelRef]).toEqual([true, false, "main/gpt-5.5"]);
  });
  withTempConfig({ models, agent: { pageRouteSet: true, pageModel: null } }, (dir) => {
    expect(loadConfig(dir).agent.pageRouteSet).toBe(false);
  });
  withTempConfig({ models, agent: { pageModel: { model: "backup/gpt-5.5", reasoningEffort: "low" }, pageModelFallbacks: [] } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect([agent.pageRouteSet, agent.subagentRouteSet]).toEqual([true, false]);
    expect(agent.page).toEqual(expect.objectContaining({ providerName: "backup", modelRef: "backup/gpt-5.5", reasoningEffort: "low" }));
  });
  withTempConfig({ models, agent: { pageModelFallbacks: [] } }, (dir) => {
    expect(loadConfig(dir).agent.pageRouteSet).toBe(true);
  });
});

test("the subagent route is set only where the file sets it; unset, it holds the default's chain, which no subagent runs on", () => {
  const models = {
    default: { model: "main/gpt-5.5", reasoningEffort: "high", modelFallbacks: ["backup/gpt-5.5"] },
    providers: {
      main: { type: "openai", apiKey: "main-key" },
      backup: { type: "openai-compatible", apiKey: "backup-key", baseURL: "https://backup.example/v1" }
    }
  };
  const defaultFirst = { model: "main/gpt-5.5", reasoningEffort: "high" as const };
  // Unset, though the manager has a route of its own: not set, and its chain is
  // the default's (where switching it on starts), not the manager's.
  withTempConfig({ models, agent: { managerModel: "backup/gpt-5.5", managerModelFallbacks: [] } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect(agent.subagentRouteSet).toBe(false);
    expect(agent.subagentModel).toEqual(defaultFirst);
    expect(agent.subagent).toEqual(expect.objectContaining({ providerName: "main", modelRef: "main/gpt-5.5" }));
    expect(agent.subagentFallbacks).toEqual([expect.objectContaining({ providerName: "backup", modelRef: "backup/gpt-5.5" })]);
  });
  // Null and blank are unset.
  withTempConfig({ models, agent: { subagentModel: null, subagentModelFallbacks: null } }, (dir) => {
    expect(loadConfig(dir).agent.subagentRouteSet).toBe(false);
  });
  withTempConfig({ models, agent: { subagentModel: "  " } }, (dir) => {
    expect(loadConfig(dir).agent.subagentRouteSet).toBe(false);
  });
  // A flag written into the file by hand decides nothing.
  withTempConfig({ models, agent: { subagentRouteSet: true } }, (dir) => {
    expect(loadConfig(dir).agent.subagentRouteSet).toBe(false);
  });
  // Set to the default's own model, it is set all the same.
  withTempConfig({ models, agent: { subagentModel: { model: "main/gpt-5.5", reasoningEffort: "high" } } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect([agent.subagentRouteSet, agent.subagentModel]).toEqual([true, defaultFirst]);
  });
  // Its fallbacks alone set it too: the default's first model, then its own fallbacks.
  withTempConfig({ models, agent: { subagentModelFallbacks: [] } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect([agent.subagentRouteSet, agent.subagentModel, agent.subagentModelFallbacks]).toEqual([true, defaultFirst, []]);
  });
  // Its own chain; the other routes stay the default's.
  withTempConfig({ models, agent: {
    subagentModel: { model: "backup/gpt-5.5", reasoningEffort: "low" },
    subagentModelFallbacks: [{ model: "main/gpt-5.5", reasoningEffort: "low" }]
  } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect(agent.subagentRouteSet).toBe(true);
    expect(agent.subagent).toEqual(expect.objectContaining({ providerName: "backup", modelRef: "backup/gpt-5.5", reasoningEffort: "low" }));
    expect(agent.subagentModelFallbacks).toEqual([{ model: "main/gpt-5.5", reasoningEffort: "low" }]);
    expect(agent.subagentFallbacks).toEqual([expect.objectContaining({ modelRef: "main/gpt-5.5" })]);
    expect([agent.managerModel, agent.workerModel, agent.globalModel, agent.dreamModel]).toEqual([defaultFirst, defaultFirst, defaultFirst, defaultFirst]);
  });
});

// Idle compaction: on, 5 minutes before the cache expires, at 200k tokens and
// more, unless the file says otherwise within limits.
test("idle compaction defaults: on, 5 minutes before expiry, 200k", () => {
  withTempConfig(null, (dir) => expect(loadConfig(dir).agent).toMatchObject({ idleCompactionEnabled: true, idleCompactionLeadMinutes: 5, idleCompactionMinTokens: 200000 }));
  withTempConfig({ agent: { idleCompactionEnabled: false, idleCompactionLeadMinutes: 10, idleCompactionMinTokens: 150000 } }, (dir) =>
    expect(loadConfig(dir).agent).toMatchObject({ idleCompactionEnabled: false, idleCompactionLeadMinutes: 10, idleCompactionMinTokens: 150000 }));
  for (const lead of [0, 60, "x", 2.5]) {
    withTempConfig({ agent: { idleCompactionLeadMinutes: lead } }, (dir) => expect(loadConfig(dir).agent.idleCompactionLeadMinutes).toBe(5));
  }
  withTempConfig({ agent: { idleCompactionMinTokens: 500 } }, (dir) => expect(loadConfig(dir).agent.idleCompactionMinTokens).toBe(200000));
  // On unless the file says false: anything else is on.
  withTempConfig({ agent: { idleCompactionEnabled: "off" } }, (dir) => expect(loadConfig(dir).agent.idleCompactionEnabled).toBe(true));
});
