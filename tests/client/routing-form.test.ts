import { describe, expect, test } from "bun:test";
import {
  buildDefaultRoutePatch,
  buildWorkerRoutePatch,
  buildManagerRoutePatch,
  deriveDefaultRoute,
  deriveWorkerRoute,
  deriveManagerRoute,
  modelRefOptions
} from "@/routes/settings/routing-form";
import type { SettingsConfigResponse } from "@/routes/settings/types";

/** Only the fields the routing functions read; cast keeps the fixture small.
 *  Efforts deliberately include "" — legacy configs send it and the derive
 *  functions must normalize it to "provider-default". */
const config = {
  ok: true,
  models: {
    default: {
      model: "anthropic/claude-sonnet-4-5",
      reasoningEffort: "high",
      modelFallbacks: [{ model: "openai/gpt-5.5", reasoningEffort: "" }]
    },
    providers: {
      anthropic: {
        models: [{ id: "claude-sonnet-4-5", input: ["text"] }, { id: "claude-haiku-4-5", input: ["text"] }]
      },
      openai: {
        models: [{ id: "gpt-5.5", input: ["text"] }]
      }
    }
  },
  agent: {
    modelOverrides: { manager: true, worker: false },
    managerModel: { model: "openai/gpt-5.5", reasoningEffort: "medium" },
    managerModelFallbacks: [{ model: "anthropic/claude-haiku-4-5", reasoningEffort: "" }],
    workerModel: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "" },
    workerModelFallbacks: []
  }
} as unknown as SettingsConfigResponse;

describe("routing-form derive", () => {
  test("deriveDefaultRoute reads models.default and normalizes fallback efforts", () => {
    expect(deriveDefaultRoute(config)).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      reasoningEffort: "high",
      fallbacks: [{ model: "openai/gpt-5.5", reasoningEffort: "provider-default" }]
    });
  });

  test("deriveDefaultRoute normalizes an empty default effort to provider-default", () => {
    const legacy = {
      ...config,
      models: { ...config.models, default: { ...config.models.default, reasoningEffort: "" } }
    } as unknown as SettingsConfigResponse;
    expect(deriveDefaultRoute(legacy).reasoningEffort).toBe("provider-default");
  });

  test("deriveManagerRoute reads override flag, selection, and fallbacks", () => {
    expect(deriveManagerRoute(config)).toEqual({
      override: true,
      selection: { model: "openai/gpt-5.5", reasoningEffort: "medium" },
      fallbacks: [{ model: "anthropic/claude-haiku-4-5", reasoningEffort: "provider-default" }]
    });
  });

  test("deriveWorkerRoute reports override off and normalizes the selection effort", () => {
    expect(deriveWorkerRoute(config)).toEqual({
      override: false,
      selection: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "provider-default" },
      fallbacks: []
    });
  });

  test("derive agent routes treat missing modelOverrides as override off", () => {
    const bare = {
      ...config,
      agent: { ...config.agent, modelOverrides: undefined }
    } as unknown as SettingsConfigResponse;
    expect(deriveManagerRoute(bare).override).toBe(false);
    expect(deriveWorkerRoute(bare).override).toBe(false);
  });
});

describe("routing-form patches", () => {
  test("buildDefaultRoutePatch shapes { models: { default: { model, reasoningEffort, modelFallbacks } } }", () => {
    expect(
      buildDefaultRoutePatch({
        model: "openai/gpt-5.5",
        reasoningEffort: "low",
        fallbacks: [{ model: "anthropic/claude-haiku-4-5", reasoningEffort: "provider-default" }]
      })
    ).toEqual({
      models: {
        default: {
          model: "openai/gpt-5.5",
          reasoningEffort: "low",
          modelFallbacks: [{ model: "anthropic/claude-haiku-4-5", reasoningEffort: "provider-default" }]
        }
      }
    });
  });

  test("buildManagerRoutePatch with override on sends the selection and fallbacks", () => {
    expect(
      buildManagerRoutePatch({
        override: true,
        selection: { model: "openai/gpt-5.5", reasoningEffort: "medium" },
        fallbacks: [{ model: "anthropic/claude-haiku-4-5", reasoningEffort: "high" }]
      })
    ).toEqual({
      agent: {
        managerModel: { model: "openai/gpt-5.5", reasoningEffort: "medium" },
        managerModelFallbacks: [{ model: "anthropic/claude-haiku-4-5", reasoningEffort: "high" }]
      }
    });
  });

  test("buildManagerRoutePatch with override off nulls both fields", () => {
    expect(
      buildManagerRoutePatch({
        override: false,
        selection: { model: "openai/gpt-5.5", reasoningEffort: "medium" },
        fallbacks: [{ model: "anthropic/claude-haiku-4-5", reasoningEffort: "high" }]
      })
    ).toEqual({
      agent: {
        managerModel: null,
        managerModelFallbacks: null
      }
    });
  });

  test("buildWorkerRoutePatch uses the feature field names with the same null rule", () => {
    expect(
      buildWorkerRoutePatch({
        override: true,
        selection: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "xhigh" },
        fallbacks: []
      })
    ).toEqual({
      agent: {
        workerModel: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "xhigh" },
        workerModelFallbacks: []
      }
    });
    expect(
      buildWorkerRoutePatch({
        override: false,
        selection: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "xhigh" },
        fallbacks: [{ model: "openai/gpt-5.5", reasoningEffort: "low" }]
      })
    ).toEqual({
      agent: {
        workerModel: null,
        workerModelFallbacks: null
      }
    });
  });

  test("unit patches do not overlap: default touches models only, agents touch agent only", () => {
    const defaultPatch = buildDefaultRoutePatch(deriveDefaultRoute(config));
    const managerPatch = buildManagerRoutePatch(deriveManagerRoute(config));
    const workerPatch = buildWorkerRoutePatch(deriveWorkerRoute(config));
    expect(Object.keys(defaultPatch)).toEqual(["models"]);
    expect(Object.keys(managerPatch)).toEqual(["agent"]);
    expect(Object.keys(workerPatch)).toEqual(["agent"]);
    expect(Object.keys(managerPatch.agent ?? {})).toEqual([
      "managerModel",
      "managerModelFallbacks"
    ]);
    expect(Object.keys(workerPatch.agent ?? {})).toEqual([
      "workerModel",
      "workerModelFallbacks"
    ]);
  });
});

describe("modelRefOptions", () => {
  test("flattens providers into provider/model refs in config order", () => {
    expect(modelRefOptions(config)).toEqual([
      { value: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
      { value: "anthropic/claude-haiku-4-5", label: "anthropic/claude-haiku-4-5" },
      { value: "openai/gpt-5.5", label: "openai/gpt-5.5" }
    ]);
  });

  test("a current ref missing from providers is still offered, first", () => {
    const options = modelRefOptions(config, "removed/legacy-model");
    expect(options[0]).toEqual({ value: "removed/legacy-model", label: "removed/legacy-model" });
    expect(options).toHaveLength(4);
  });

  test("a current ref already in providers is not duplicated", () => {
    expect(modelRefOptions(config, "openai/gpt-5.5")).toHaveLength(3);
  });

  test("an empty current ref adds nothing", () => {
    expect(modelRefOptions(config, "")).toHaveLength(3);
  });
});
