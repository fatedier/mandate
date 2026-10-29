import { expect, test } from "bun:test";
import { buildQuickModelPayload } from "@/routes/projects/setup/quick-model";
import type { SettingsConfigResponse } from "@/routes/settings/types";

function configWith(models: Array<Record<string, unknown>>): SettingsConfigResponse {
  return {
    models: {
      default: { model: "", reasoningEffort: "provider-default", modelFallbacks: [] },
      providers: {
        proxy: { type: "openai-compatible", baseURL: "http://127.0.0.1:9/v1", models, apiKeyConfigured: false }
      }
    },
    agent: {
      managerModel: { model: "", reasoningEffort: "provider-default" },
      managerModelFallbacks: [],
      workerModel: { model: "", reasoningEffort: "provider-default" },
      workerModelFallbacks: [], globalModel: { model: "", reasoningEffort: "provider-default" }, globalModelFallbacks: []
    }
  } as unknown as SettingsConfigResponse;
}

const form = {
  providerType: "openai-compatible" as const,
  providerName: "proxy",
  model: "model-a",
  apiKey: "sk-new",
  baseURL: "http://127.0.0.1:9/v1",
  organizationId: ""
};

test("finishing setup for a model that already speaks Messages keeps its protocol", () => {
  const patch = buildQuickModelPayload(configWith([{ id: "model-a", input: ["text"], protocol: "messages" }]), form);
  expect(patch.models!.providers!.proxy!.models).toEqual([{ id: "model-a", input: ["text", "image"], protocol: "messages" }]);
});

test("a model new to the provider starts with no protocol", () => {
  const patch = buildQuickModelPayload(configWith([{ id: "model-b", input: ["text"], protocol: "chat" }]), form);
  expect(patch.models!.providers!.proxy!.models).toEqual([{ id: "model-a", input: ["text", "image"] }]);
});

test("finishing setup with a decision model makes it a chat model: it becomes the agents' default", () => {
  const patch = buildQuickModelPayload(configWith([{ id: "model-a", input: ["text"], kind: "decision" }]), form);
  expect(patch.models!.providers!.proxy!.models![0]!.kind).toBeUndefined();
});

