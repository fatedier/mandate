import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, modelSupportsInput } from "../src/server/config.js";

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandate-config-"));
    try {
      if (config) {
        fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf8");
      }
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("loadConfig defaults memory config", () => {
  withTempConfig(null, (dir) => {
    expect(loadConfig(dir).memory.embedding.model).toBe("");
    expect(loadConfig(dir).memory.dream.enabled).toBe(true);
  });
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

test("loadConfig deep-merges a partial retention override with the defaults", () => {
  withTempConfig(
    {
      retention: {
        chatRetentionDays: 30
      }
    },
    (dir) => {
      const retention = loadConfig(dir).retention;
      expect(retention.chatRetentionDays).toBe(30);
      // Unspecified fields must fall back to their defaults rather than
      // becoming undefined -- retention needs the same field-by-field merge
      // memory and voice already get, not a whole-object replace.
      expect(retention.chatMaxTableBytes).toBe(512 * 1024 * 1024);
      expect(retention.chatToolResultHeadChars).toBe(2000);
    }
  );
});

// config.json is hand-editable, this block deletes text irreversibly on an hourly
// unattended job, and the most natural way to type "turn it off" -- a zero -- was
// the single most destructive value it accepted. Each case below is a value a
// person could plausibly write.
test("loadConfig rejects retention values that would destroy data", () => {
  withTempConfig(
    {
      retention: {
        // "Off", as a user would guess it: every thread instantly past the
        // window, hourly, with no confirmation.
        chatRetentionDays: 0,
        // A head of zero leaves nothing but the marker.
        chatToolResultHeadChars: 0,
        // A ceiling every real database is permanently over silently converts
        // the age-gated policy into "shorten everything".
        chatMaxTableBytes: 0
      }
    },
    (dir) => {
      const retention = loadConfig(dir).retention;
      expect(retention.chatRetentionDays).toBe(90);
      expect(retention.chatToolResultHeadChars).toBe(2000);
      expect(retention.chatMaxTableBytes).toBe(512 * 1024 * 1024);
    }
  );
});

test("loadConfig coerces quoted retention numbers instead of passing strings to SQLite", () => {
  withTempConfig(
    { retention: { chatToolResultHeadChars: "2500", chatRetentionDays: "45" } },
    (dir) => {
      const retention = loadConfig(dir).retention;
      // SQLite orders every INTEGER below every TEXT value, so a string bound
      // into `length(content) > ?` is false for every row and the pass does
      // nothing at all, silently and forever.
      expect(typeof retention.chatToolResultHeadChars).toBe("number");
      expect(retention.chatToolResultHeadChars).toBe(2500);
      expect(typeof retention.chatRetentionDays).toBe("number");
      expect(retention.chatRetentionDays).toBe(45);
    }
  );
});

test("loadConfig falls back when a retention value is not a number at all", () => {
  withTempConfig(
    { retention: { chatRetentionDays: "abc", chatToolResultHeadChars: null } },
    (dir) => {
      const retention = loadConfig(dir).retention;
      // NaN days reaches new Date(NaN).toISOString(), which throws inside the
      // retention job's catch -- an hourly failure with no visible symptom.
      expect(retention.chatRetentionDays).toBe(90);
      expect(retention.chatToolResultHeadChars).toBe(2000);
    }
  );
});

test("loadConfig keeps retention values that are merely unusual", () => {
  // The floors must not swallow legitimate tuning: a week-long window, a small
  // but usable head, and a 64 MB ceiling are all things a user may mean.
  withTempConfig(
    {
      retention: {
        chatRetentionDays: 7,
        chatToolResultHeadChars: 500,
        chatMaxTableBytes: 64 * 1024 * 1024
      }
    },
    (dir) => {
      const retention = loadConfig(dir).retention;
      expect(retention.chatRetentionDays).toBe(7);
      expect(retention.chatToolResultHeadChars).toBe(500);
      expect(retention.chatMaxTableBytes).toBe(64 * 1024 * 1024);
    }
  );
});

test("loadConfig replaces a retention block that is not an object", () => {
  withTempConfig({ retention: "off" }, (dir) => {
    expect(loadConfig(dir).retention.chatRetentionDays).toBe(90);
    expect(loadConfig(dir).retention.chatToolResultHeadChars).toBe(2000);
  });
});

test("loadConfig normalizes provider defaults and environment API keys", () => {
  withTempConfig(
    {
      models: {
        providers: {
          google: { type: "google" },
          kilo: { type: "kilo", apiKey: "kilo-key", organizationId: "org_123" }
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
      expect(config.models.providers.kilo).toMatchObject({
        type: "kilo",
        baseURL: "https://api.kilo.ai/api/gateway",
        apiKey: "kilo-key",
        organizationId: "org_123"
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
      expect(config.agent.managerModelFallbackRefs).toEqual([]);
      expect(config.agent.managerFallbacks).toEqual([]);
      expect(config.agent.workerModelFallbacks).toEqual([{
        model: "backup/gpt-5.5",
        reasoningEffort: "provider-default"
      }]);
      expect(config.agent.workerModelFallbackRefs).toEqual(["backup/gpt-5.5"]);
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
      expect(config.agent.managerModelFallbackRefs).toEqual(["backup/claude-sonnet-4-6"]);
      expect(config.agent.workerModelFallbackRefs).toEqual(["backup/claude-sonnet-4-6"]);
    }
  );
});

test("MANDATE_AGENT_MANAGER_MODEL / MANDATE_AGENT_WORKER_MODEL override the agent models", () => {
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
      process.env.MANDATE_AGENT_MANAGER_MODEL = "backup/claude-opus-4-7";
      process.env.MANDATE_AGENT_WORKER_MODEL = "main/gpt-5-mini";
      const config = loadConfig(dir);
      expect(config.agent.manager.modelRef).toBe("backup/claude-opus-4-7");
      expect(config.agent.worker.modelRef).toBe("main/gpt-5-mini");
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
