import { runnableProviderConfigs } from "../src/server/runtime/agent-provider-config.js";
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, modelSupportsInput } from "../src/server/config.js";
import type { RetentionConfig } from "../src/server/config/types.js";
import { setStartOverrides } from "../src/server/config/start-overrides.js";
import { ConfigFileError } from "../src/server/config/file-check.js";
import { fileFromFlat } from "../src/server/config/file-layout.js";
import { tempDir } from "./helpers/temp.js";

function withCleanEnv(fn) {
  const keys = [
    "PORT",
    "MANDATE_POLL_INTERVAL_MS",
    "MANDATE_CAPTURE_LINES",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_API_KEY",
    "MANDATE_AGENT_LOG_REQUESTS",
    "MANDATE_LOG_LEVEL",
    "MANDATE_DEBUG",
    "MANDATE_HOST",
    "MANDATE_LOG_STACKS",
    "MANDATE_LLM_STREAM_TRACE",
    "MANDATE_SCHEDULES_DISABLED",
    "MANDATE_SKILLS_DIR"
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
      // Written as the file groups it; the fixtures name the app's flat keys.
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(fileFromFlat(config)), "utf8");
    }
    return fn(dir);
  });
}

/** The problem lines loadConfig refuses the file with; none when it loads. */
function problemsOf(config) {
  return withTempConfig(config, (dir) => {
    try {
      loadConfig(dir);
      return [];
    } catch (error) {
      if (error instanceof ConfigFileError) return error.problems;
      throw error;
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
    expected: { chatRetentionDays: 30, chatMaxTableBytes: 1024 * 1024 * 1024, chatToolResultHeadChars: 2000 }
  },
  {
    // A key set to null is one the file leaves out.
    name: "loadConfig reads a null retention value as the default",
    retention: { chatToolResultHeadChars: null },
    expected: { chatToolResultHeadChars: 2000 }
  },
  {
    // The floors must not swallow legitimate tuning: a week-long window, a small
    // but usable head, and a 64 MB ceiling are all things a user may mean.
    name: "loadConfig keeps retention values that are merely unusual",
    retention: { chatRetentionDays: 7, chatToolResultHeadChars: 500, chatMaxTableBytes: 64 * 1024 * 1024 },
    expected: { chatRetentionDays: 7, chatToolResultHeadChars: 500, chatMaxTableBytes: 64 * 1024 * 1024 }
  },
];

test.each(retentionCases)("$name", ({ retention, expected }) => {
  withTempConfig({ retention }, (dir) => {
    expect(loadConfig(dir).retention).toMatchObject(expected);
  });
});

// config.json is hand-editable, this block deletes text irreversibly on an
// hourly unattended job, and the most natural way to type "turn it off" -- a
// zero -- was the single most destructive value it took. Each value here is
// one a person could plausibly write; the server does not start on any.
test("loadConfig refuses retention values that would destroy data, or that are not numbers", () => {
  expect(problemsOf({ retention: { chatRetentionDays: 0, chatToolResultHeadChars: 0, chatMaxTableBytes: 0 } })).toEqual([
    "retention.chatRetentionDays: must be a whole number of at least 1 (it is 0)",
    "retention.chatMaxTableBytes: must be a whole number of at least 1048576 (it is 0)",
    "retention.chatToolResultHeadChars: must be a whole number of at least 200 (it is 0)"
  ]);
  // SQLite orders every INTEGER below every TEXT value: a string bound into
  // `length(content) > ?` was false for every row, the pass doing nothing.
  expect(problemsOf({ retention: { chatToolResultHeadChars: "2500", chatRetentionDays: "abc" } })).toEqual([
    'retention.chatRetentionDays: must be a whole number of at least 1 (it is "abc")',
    'retention.chatToolResultHeadChars: must be a whole number of at least 200 (it is "2500")'
  ]);
  expect(problemsOf({ retention: "off" })).toEqual(["retention: must be an object (it is text)"]);
});

test("loadConfig fills a provider's default base URL; its key is the file's, never the environment's", () => {
  withTempConfig(
    {
      models: {
        providers: {
          google: { type: "google" },
          openai: { type: "openai" },
          claude: { type: "anthropic" },
          named: { type: "anthropic", apiKey: "sk-file" }
        }
      }
    },
    (dir) => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-key";
      process.env.GOOGLE_API_KEY = "google-key-2";
      process.env.OPENAI_API_KEY = "openai-key";
      process.env.ANTHROPIC_API_KEY = "anthropic-key";
      const { providers } = loadConfig(dir).models;

      expect(providers.google).toMatchObject({ type: "google", baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "" });
      expect([providers.openai.apiKey, providers.claude.apiKey, providers.named.apiKey]).toEqual(["", "", "sk-file"]);
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
          modelFallbacks: [{ model: "backup/gpt-5.5" }, { model: "main/gpt-5.5" }]
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

test("loadConfig keeps a model's protocol on a custom provider only, and refuses unknown values", () => {
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
              { id: "model-c", protocol: "responses" }
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
        ["model-c", null]
      ]);
      expect(config.models.providers.direct.models[0].protocol).toBeUndefined();
    }
  );
  expect(problemsOf({ models: { providers: { proxy: { type: "openai-compatible", models: [{ id: "model-d", protocol: "carrier-pigeon" }] } } } }))
    .toEqual(['models.providers.proxy.models[0].protocol: must be one of responses, chat, messages (it is "carrier-pigeon")']);
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

test("a provider needs its type and a model ref its provider: neither is guessed from a name, both are refused", () => {
  expect(problemsOf({
    models: {
      default: { model: "main/gpt-5.5" },
      providers: {
        main: { type: "openai", apiKey: "main-key" },
        openai: { apiKey: "untyped-key" }
      }
    },
    agent: { workerModel: { model: "gpt-5-mini" }, workerModelFallbacks: [{ model: "gpt-5-nano" }, { model: "main/gpt-5-mini" }] }
  })).toEqual([
    "models.providers.openai.type: must be one of openai, openai-compatible, kilo, codex, anthropic, google (it is missing)",
    'agent.routes.worker.model: must be provider/model (it is "gpt-5-mini")',
    'agent.routes.worker.fallbacks[0].model: must be provider/model (it is "gpt-5-nano")'
  ]);
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
  expect(problemsOf({ logging: { level: "invalid" } })).toEqual(['logging.level: must be one of silent, error, warn, info, debug (it is "invalid")']);
});

test("the environment overrides none of the file's settings", () => {
  withTempConfig({ pollIntervalMs: 2000, captureLines: 60, agent: { logRequests: "metadata" } }, (dir) => {
    const read = () => { const c = loadConfig(dir); return { poll: c.pollIntervalMs, capture: c.captureLines, logRequests: c.agent.logRequests }; };
    const without = read();
    process.env.MANDATE_POLL_INTERVAL_MS = "9000";
    process.env.MANDATE_CAPTURE_LINES = "400";
    process.env.MANDATE_AGENT_LOG_REQUESTS = "full";
    expect(without).toEqual({ poll: 2000, capture: 60, logRequests: "metadata" });
    expect(read()).toEqual(without);
  });
});

test("the listen address is read without the spaces around it", () => {
  withTempConfig({ host: " 0.0.0.0 " }, (dir) => expect(loadConfig(dir).host).toBe("0.0.0.0"));
});

test("logging.stacks is off unless the file says true", () => {
  withTempConfig(null, (dir) => expect(loadConfig(dir).logging.stacks).toBe(false));
  withTempConfig({ logging: { stacks: true } }, (dir) => expect(loadConfig(dir).logging).toEqual({ level: "info", stacks: true, streamTrace: true }));
  expect(problemsOf({ logging: { level: "debug", stacks: "yes" } })).toEqual(['logging.stacks: must be true or false (it is "yes")']);
});

// A failed model stream logs its part-by-part trace, as it always has,
// unless the file turns that off.
test("logging.streamTrace is on unless the file says false; the environment does not turn it off", () => {
  withTempConfig(null, (dir) => {
    process.env.MANDATE_LLM_STREAM_TRACE = "0";
    expect(loadConfig(dir).logging.streamTrace).toBe(true);
  });
  withTempConfig({ logging: { streamTrace: false } }, (dir) => expect(loadConfig(dir).logging.streamTrace).toBe(false));
  expect(problemsOf({ logging: { streamTrace: "off" } })).toEqual(['logging.streamTrace: must be true or false (it is "off")']);
});

test("schedules.enabled is on unless the file says false; the environment does not turn it off", () => {
  withTempConfig(null, (dir) => {
    process.env.MANDATE_SCHEDULES_DISABLED = "1";
    expect(loadConfig(dir).schedules).toEqual({ enabled: true });
  });
  withTempConfig({ schedules: { enabled: false } }, (dir) => expect(loadConfig(dir).schedules).toEqual({ enabled: false }));
  expect(problemsOf({ schedules: { enabled: "no" } })).toEqual(['schedules.enabled: must be true or false (it is "no")']);
  expect(problemsOf({ schedules: "off" })).toEqual(["schedules: must be an object (it is text)"]);
});

test("skills.extraDirs keeps the file's paths, trimmed; the environment adds none", () => {
  withTempConfig(null, (dir) => {
    process.env.MANDATE_SKILLS_DIR = "/srv/env-skills";
    expect(loadConfig(dir).skills).toEqual({ extraDirs: [] });
  });
  withTempConfig({ skills: { extraDirs: [" /srv/team-skills ", "more-skills"] } }, (dir) =>
    expect(loadConfig(dir).skills).toEqual({ extraDirs: ["/srv/team-skills", "more-skills"] }));
  expect(problemsOf({ skills: { extraDirs: ["", 3] } })).toEqual([
    "skills.extraDirs[0]: must be a folder path (it is empty)",
    "skills.extraDirs[1]: must be a folder path (it is a number)"
  ]);
  expect(problemsOf({ skills: { extraDirs: "/a:/b" } })).toEqual(["skills.extraDirs: must be a list of folder paths (it is text)"]);
});

// `mandate serve --port/--host/--log-level`: the flags win over the file on
// every read (a Settings save reloads the file); the environment sets none of it.
test("the serve flags beat the file and outlast a reload; the environment sets nothing", () => {
  withTempConfig({ port: 4300, host: "127.0.0.1", logging: { level: "warn" } }, (dir) => {
    const read = () => { const c = loadConfig(dir); return { port: c.port, host: c.host, level: c.logging.level }; };
    process.env.PORT = "4400";
    process.env.MANDATE_HOST = "0.0.0.0";
    process.env.MANDATE_LOG_LEVEL = "error";
    process.env.MANDATE_DEBUG = "1";
    expect(read()).toEqual({ port: 4300, host: "127.0.0.1", level: "warn" });
    setStartOverrides({ port: 4500, host: "0.0.0.0", logLevel: "debug" });
    try {
      expect(read()).toEqual({ port: 4500, host: "0.0.0.0", level: "debug" });
      expect(read()).toEqual({ port: 4500, host: "0.0.0.0", level: "debug" });
      setStartOverrides({ port: Number.NaN });
      expect(read()).toEqual({ port: 4173, host: "127.0.0.1", level: "warn" });
    } finally {
      setStartOverrides({});
    }
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

// The personal agent's, the dream's and memory extraction's routes each read the same
// way; setting one leaves every other route on the default's.
const ownRoutes: { name: string; route: "personal" | "dream" | "extraction" }[] = [
  { name: "Personal agent's route is the default when unset or null, and its own when set", route: "personal" },
  { name: "the dream's route is the default when unset or null, and its own when set", route: "dream" },
  { name: "memory extraction's route is the default when unset or null, and its own when set", route: "extraction" }
];

test.each(ownRoutes)("$name", ({ route }) => {
  const models = {
    default: { model: "main/gpt-5.5", reasoningEffort: "high", modelFallbacks: [{ model: "backup/gpt-5.5" }] },
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
    for (const other of ["manager", "personal", "dream", "extraction"] as const) {
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

test("the skill review's route is its own where the file sets it; unset, whatever the Dream runs on", () => {
  const models = {
    default: { model: "main/gpt-5.5", reasoningEffort: "high", modelFallbacks: [] },
    providers: {
      main: { type: "openai", apiKey: "main-key" },
      backup: { type: "openai-compatible", apiKey: "backup-key", baseURL: "https://backup.example/v1" }
    }
  };
  withTempConfig({ models, agent: { dreamModel: { model: "backup/gpt-5.5", reasoningEffort: "low" } } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect([agent.skillReviewRouteSet, agent.skillReview.modelRef, agent.skillReview.reasoningEffort]).toEqual([false, "backup/gpt-5.5", "low"]);
  });
  // The Dream unset runs on the default route, and so does the review, as
  // Routing says ("uses the Dream's model"), whatever the managers run on.
  withTempConfig({ models, agent: { managerModel: { model: "backup/gpt-5.5", reasoningEffort: "medium" } } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect([agent.dream.modelRef, agent.skillReview.modelRef]).toEqual(["main/gpt-5.5", "main/gpt-5.5"]);
  });
  withTempConfig({ models, agent: { dreamModel: { model: "backup/gpt-5.5", reasoningEffort: "low" }, skillReviewModel: { model: "main/gpt-5.5", reasoningEffort: "high" }, skillReviewModelFallbacks: [] } }, (dir) => {
    const agent = loadConfig(dir).agent;
    expect([agent.skillReviewRouteSet, agent.skillReview.modelRef]).toEqual([true, "main/gpt-5.5"]);
  });
});

test("a route with no model has nothing to run a skill review on", () => {
  withTempConfig({}, (dir) => {
    expect(runnableProviderConfigs(loadConfig(dir), "skillReview")).toEqual([]);
  });
  const models = { default: { model: "main/gpt-5.5", reasoningEffort: "high", modelFallbacks: [] }, providers: { main: { type: "openai", apiKey: "main-key" } } };
  withTempConfig({ models }, (dir) => {
    expect(runnableProviderConfigs(loadConfig(dir), "skillReview").map((c) => c.model)).toEqual(["gpt-5.5"]);
  });
});

test("the subagent route is set only where the file sets it; unset, it holds the default's chain, which no subagent runs on", () => {
  const models = {
    default: { model: "main/gpt-5.5", reasoningEffort: "high", modelFallbacks: [{ model: "backup/gpt-5.5" }] },
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
  // Null is unset.
  withTempConfig({ models, agent: { subagentModel: null, subagentModelFallbacks: null } }, (dir) => {
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
    expect([agent.managerModel, agent.workerModel, agent.personalModel, agent.dreamModel]).toEqual([defaultFirst, defaultFirst, defaultFirst, defaultFirst]);
  });
});

// Idle compaction: on, 5 minutes before the cache expires, at 200k tokens and
// more, unless the file says otherwise within limits.
test("idle compaction defaults: on, 5 minutes before expiry, 200k", () => {
  withTempConfig(null, (dir) => expect(loadConfig(dir).agent).toMatchObject({ idleCompactionEnabled: true, idleCompactionLeadMinutes: 5, idleCompactionMinTokens: 200000 }));
  withTempConfig({ agent: { idleCompactionEnabled: false, idleCompactionLeadMinutes: 10, idleCompactionMinTokens: 150000 } }, (dir) =>
    expect(loadConfig(dir).agent).toMatchObject({ idleCompactionEnabled: false, idleCompactionLeadMinutes: 10, idleCompactionMinTokens: 150000 }));
  for (const lead of [0, 60, "x", 2.5]) {
    expect(problemsOf({ agent: { idleCompactionLeadMinutes: lead } })).toEqual([`agent.compaction.idle.leadMinutes: must be a whole number from 1 to 59 (it is ${JSON.stringify(lead)})`]);
  }
  expect(problemsOf({ agent: { idleCompactionMinTokens: 500, idleCompactionEnabled: "off" } })).toEqual([
    'agent.compaction.idle.enabled: must be true or false (it is "off")',
    "agent.compaction.idle.minTokens: must be a whole number of at least 1000 (it is 500)"
  ]);
});

// A value the server cannot use as written stops it; so does a file that is
// not JSON, or not an object.
test("loadConfig refuses a config.json it cannot use, naming the file and each problem", () => {
  const caught = (write: (file: string) => void) => {
    const dir = tempDir("mandate-config-bad-");
    write(path.join(dir, "config.json"));
    try {
      loadConfig(dir);
    } catch (error) {
      return { dir, error: error as ConfigFileError };
    }
    throw new Error("loadConfig took the file");
  };
  const invalid = caught((file) => fs.writeFileSync(file, JSON.stringify({ server: { port: "4777" } })));
  expect(invalid.error).toBeInstanceOf(ConfigFileError);
  expect([invalid.error.file, invalid.error.problems]).toEqual([path.join(invalid.dir, "config.json"), ['server.port: must be a whole number from 0 to 65535 (it is "4777")']]);
  const syntax = caught((file) => fs.writeFileSync(file, '{ "port": 4777, }'));
  expect(syntax.error.message).toStartWith(`${path.join(syntax.dir, "config.json")} is not valid JSON: `);
  const list = caught((file) => fs.writeFileSync(file, "[]"));
  expect(list.error.message).toBe(`${path.join(list.dir, "config.json")} must hold a JSON object`);
});
