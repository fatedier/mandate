import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { clearKiloModelApis, replaceKiloModelApis } from "../src/server/config/kilo-model-apis.js";
import { modelCacheLifetimeMinutes, resolveModelSelection } from "../src/server/config/model-resolution.js";
import { agentProviderConfigFromResolved } from "../src/server/runtime/agent-provider-config.js";
import { createAgentProvider } from "../src/server/modules/agent/llm-provider.js";
import { tempDir } from "./helpers/temp.js";

// Every resolved model knows the API it speaks: a Kilo model the one Kilo
// tags it with (Chat when untagged), a custom gateway's model its protocol,
// the other types their one API.

afterEach(() => clearKiloModelApis());

function config() {
  const dir = tempDir("md-model-api-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    models: {
      providers: {
        kilo: { type: "kilo", apiKey: "k-test", organizationId: "org-test", models: [{ id: "vendor/claude-x" }, { id: "vendor/gpt-x" }, { id: "vendor/other-x" }] },
        gw: { type: "openai-compatible", baseURL: "https://gw.example/v1", apiKey: "sk-test", models: [{ id: "m-default" }, { id: "m-chat", protocol: "chat" }, { id: "m-messages", protocol: "messages" }] },
        ant: { type: "anthropic", apiKey: "sk-ant-test", models: [{ id: "claude-x" }] },
        oai: { type: "openai", apiKey: "sk-test", models: [{ id: "gpt-x" }] },
        goo: { type: "google", apiKey: "g-test", models: [{ id: "gemini-x" }] }
      }
    }
  }));
  return loadConfig(dir);
}

const resolve = (cfg: ReturnType<typeof config>, model: string) => resolveModelSelection(cfg, { model, reasoningEffort: "medium" });

test("a Kilo model takes the API Kilo tags it with; an untagged one is Chat", () => {
  replaceKiloModelApis("kilo", new Map([["vendor/claude-x", "messages"], ["vendor/gpt-x", "responses"]]));
  const cfg = config();
  expect(resolve(cfg, "kilo/vendor/claude-x")).toMatchObject({ providerType: "kilo", api: "messages", organizationId: "org-test" });
  expect(resolve(cfg, "kilo/vendor/gpt-x")).toMatchObject({ providerType: "kilo", api: "responses", organizationId: "org-test" });
  expect(resolve(cfg, "kilo/vendor/other-x")).toMatchObject({ providerType: "kilo", api: "chat", organizationId: "org-test" });
});

test("a custom gateway's model speaks its protocol; Responses by default", () => {
  const cfg = config();
  expect(resolve(cfg, "gw/m-default").api).toBe("responses");
  expect(resolve(cfg, "gw/m-chat").api).toBe("chat");
  expect(resolve(cfg, "gw/m-messages").api).toBe("messages");
});

test("the other types speak their one API", () => {
  const cfg = config();
  expect(resolve(cfg, "ant/claude-x").api).toBe("messages");
  expect(resolve(cfg, "oai/gpt-x").api).toBe("responses");
  expect(resolve(cfg, "goo/gemini-x").api).toBe("gemini");
});

test("the agent provider config carries the API and the Kilo organisation", () => {
  replaceKiloModelApis("kilo", new Map([["vendor/claude-x", "messages"]]));
  const cfg = config();
  const agent = agentProviderConfigFromResolved(resolve(cfg, "kilo/vendor/claude-x"));
  expect(agent.api).toBe("messages");
  expect(agent.organizationId).toBe("org-test");
  expect(agentProviderConfigFromResolved(resolve(cfg, "gw/m-chat")).api).toBe("chat");
  expect(createAgentProvider(agentProviderConfigFromResolved(resolve(cfg, "gw/m-chat"))).meta.api).toBe("chat");
});

// Each model's typed cache lifetime: whole minutes,
// 0 or more; absent or unreadable in the file, none (the family's default).
test("a model's typed cache lifetime", () => {
  const dir = tempDir("md-model-lifetime-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    models: { providers: { gw: { type: "openai-compatible", baseURL: "https://gw.example/v1", apiKey: "sk-test", models: [
      { id: "m45", cacheLifetimeMinutes: 45 }, { id: "m0", cacheLifetimeMinutes: 0 }, { id: "plain" },
      { id: "neg", cacheLifetimeMinutes: -1 }, { id: "frac", cacheLifetimeMinutes: 2.5 }, { id: "text", cacheLifetimeMinutes: "45" }, { id: "big", cacheLifetimeMinutes: 1441 }
    ] } } }
  }));
  const cfg = loadConfig(dir);
  expect(["m45", "m0", "plain", "neg", "frac", "text", "big", "missing"].map((id) => modelCacheLifetimeMinutes(cfg, `gw/${id}`)))
    .toEqual([45, 0, undefined, undefined, undefined, undefined, undefined, undefined]);
});
