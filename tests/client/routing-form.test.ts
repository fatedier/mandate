import { describe, expect, test } from "bun:test";
import {
  agentChain,
  buildDefaultRoutePatch,
  buildWorkerRoutePatch,
  buildManagerRoutePatch,
  buildGlobalRoutePatch,
  buildAgentRoutePatch,
  defaultChain,
  deriveAgentRoute,
  deriveDefaultRoute,
  deriveGlobalRoute,
  deriveWorkerRoute,
  deriveManagerRoute,
  modelMenuGroups,
  modelRefOptions,
  moveStep,
  withAgentChain,
  withDefaultChain,
  type AgentRoute,
  type AgentRouteForm
} from "@/routes/settings/routing-form";
import type { AgentModelSelection, ReasoningEffort, SettingsConfigResponse, SettingsConfigUpdate } from "@/routes/settings/types";

/** Only the fields the routing functions read; cast keeps the fixture small. */
const config = {
  ok: true,
  models: {
    default: {
      model: "anthropic/claude-sonnet-4-5",
      reasoningEffort: "high",
      modelFallbacks: [{ model: "openai/gpt-5.5", reasoningEffort: "provider-default" }]
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
    managerModelFallbacks: [{ model: "anthropic/claude-haiku-4-5", reasoningEffort: "provider-default" }],
    workerModel: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "provider-default" },
    workerModelFallbacks: [],
    globalModel: { model: "anthropic/claude-haiku-4-5", reasoningEffort: "low" },
    globalModelFallbacks: [{ model: "openai/gpt-5.5", reasoningEffort: "provider-default" }],
    dreamModel: { model: "openai/gpt-5.5", reasoningEffort: "provider-default" },
    dreamModelFallbacks: [],
    extractionModel: { model: "anthropic/claude-haiku-4-5", reasoningEffort: "medium" },
    extractionModelFallbacks: [{ model: "anthropic/claude-sonnet-4-5", reasoningEffort: "provider-default" }],
    subagentModel: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "provider-default" },
    subagentModelFallbacks: [{ model: "openai/gpt-5.5", reasoningEffort: "high" }]
  }
} as unknown as SettingsConfigResponse;

/** The routes the fixture above gives a chain of their own. */
const fixtureRoutes: AgentRoute[] = ["manager", "worker", "global", "dream", "extraction", "subagent"];

/** The fixture with only `route`'s override flag on. */
function onlyOverride(route: AgentRoute): SettingsConfigResponse {
  const modelOverrides = Object.fromEntries(fixtureRoutes.map((r) => [r, r === route]));
  return { ...config, agent: { ...config.agent, modelOverrides } } as unknown as SettingsConfigResponse;
}

describe("routing-form derive", () => {
  test("deriveDefaultRoute reads models.default", () => {
    expect(deriveDefaultRoute(config)).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      reasoningEffort: "high",
      fallbacks: [{ model: "openai/gpt-5.5", reasoningEffort: "provider-default" }]
    });
  });

  // Each row reads the fixture's own fields for its routes; then, with only
  // one route's flag on, that route alone reads as overridden.
  const deriveRows: Array<{
    name: string;
    expected: Partial<Record<AgentRoute, AgentRouteForm>>;
    /** The route's own wrapper, where it has one: it must read the same. */
    wrapper?: (config: SettingsConfigResponse) => AgentRouteForm;
  }> = [
    {
      name: "deriveManagerRoute reads override flag, selection, and fallbacks",
      wrapper: deriveManagerRoute,
      expected: {
        manager: {
          override: true,
          selection: { model: "openai/gpt-5.5", reasoningEffort: "medium" },
          fallbacks: [{ model: "anthropic/claude-haiku-4-5", reasoningEffort: "provider-default" }]
        }
      }
    },
    {
      name: "deriveWorkerRoute reports override off and normalizes the selection effort",
      wrapper: deriveWorkerRoute,
      expected: {
        worker: {
          override: false,
          selection: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "provider-default" },
          fallbacks: []
        }
      }
    },
    {
      name: "deriveGlobalRoute reads its own override flag, selection and fallbacks",
      wrapper: deriveGlobalRoute,
      expected: {
        global: {
          override: false,
          selection: { model: "anthropic/claude-haiku-4-5", reasoningEffort: "low" },
          fallbacks: [{ model: "openai/gpt-5.5", reasoningEffort: "provider-default" }]
        }
      }
    },
    {
      name: "deriveAgentRoute reads each route's own override flag, selection and fallbacks",
      expected: {
        dream: {
          override: false,
          selection: { model: "openai/gpt-5.5", reasoningEffort: "provider-default" },
          fallbacks: []
        },
        extraction: {
          override: false,
          selection: { model: "anthropic/claude-haiku-4-5", reasoningEffort: "medium" },
          fallbacks: [{ model: "anthropic/claude-sonnet-4-5", reasoningEffort: "provider-default" }]
        }
      }
    },
    {
      name: "deriveAgentRoute reads its own override flag, selection and fallbacks",
      expected: {
        subagent: {
          override: false,
          selection: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "provider-default" },
          fallbacks: [{ model: "openai/gpt-5.5", reasoningEffort: "high" }]
        }
      }
    }
  ];

  test.each(deriveRows)("$name", ({ expected, wrapper }) => {
    for (const [route, form] of Object.entries(expected) as Array<[AgentRoute, AgentRouteForm]>) {
      expect(deriveAgentRoute(config, route)).toEqual(form);
      if (wrapper) expect(wrapper(config)).toEqual(form);
      const own = onlyOverride(route);
      expect(fixtureRoutes.filter((r) => deriveAgentRoute(own, r).override)).toEqual([route]);
      if (wrapper) expect(wrapper(own).override).toBe(true);
    }
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

  // A route's patch writes its own two fields: the chain while its override
  // is on, null on both when off (the server then clears the route).
  const chain = {
    selection: { model: "openai/gpt-5.5", reasoningEffort: "high" as const },
    fallbacks: [{ model: "anthropic/claude-haiku-4-5", reasoningEffort: "low" as const }]
  };
  const patchRows: Array<{
    name: string;
    /** The two fields each route's patch writes, spelled out. */
    fields: Partial<Record<AgentRoute, [model: string, fallbacks: string]>>;
    /** The route's own wrapper, where it has one: it must give the same patch. */
    wrapper?: (form: AgentRouteForm) => SettingsConfigUpdate;
    /** The override states sent: both unless the row names one. */
    overrides?: boolean[];
    /** The chain sent: `chain` unless the row has its own. */
    form?: Omit<AgentRouteForm, "override">;
  }> = [
    {
      name: "buildManagerRoutePatch with override on sends the selection and fallbacks",
      fields: { manager: ["managerModel", "managerModelFallbacks"] },
      wrapper: buildManagerRoutePatch,
      overrides: [true]
    },
    {
      name: "buildManagerRoutePatch with override off nulls both fields",
      fields: { manager: ["managerModel", "managerModelFallbacks"] },
      wrapper: buildManagerRoutePatch,
      overrides: [false]
    },
    {
      name: "buildWorkerRoutePatch uses the feature field names with the same null rule",
      fields: { worker: ["workerModel", "workerModelFallbacks"] },
      wrapper: buildWorkerRoutePatch,
      // No fallbacks: the chain on is an empty list, not null.
      form: { selection: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "xhigh" }, fallbacks: [] }
    },
    {
      name: "buildGlobalRoutePatch sends its chain when on, nulls both fields when off",
      fields: { global: ["globalModel", "globalModelFallbacks"] },
      wrapper: buildGlobalRoutePatch
    },
    {
      name: "buildAgentRoutePatch sends a route's chain when on, nulls both of its fields when off",
      fields: { dream: ["dreamModel", "dreamModelFallbacks"], extraction: ["extractionModel", "extractionModelFallbacks"] }
    },
    {
      name: "buildAgentRoutePatch sends its chain when on, and null for both of its fields when off",
      fields: { subagent: ["subagentModel", "subagentModelFallbacks"] }
    }
  ];

  test.each(patchRows)("$name", ({ fields, wrapper, overrides = [true, false], form = chain }) => {
    for (const [route, [model, fallbacks]] of Object.entries(fields) as Array<[AgentRoute, [string, string]]>) {
      for (const override of overrides) {
        const patch = { agent: override ? { [model]: form.selection, [fallbacks]: form.fallbacks } : { [model]: null, [fallbacks]: null } };
        expect(buildAgentRoutePatch(route, { override, ...form })).toEqual(patch);
        if (wrapper) expect(wrapper({ override, ...form })).toEqual(patch);
      }
    }
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

describe("route chains", () => {
  const step = (model: string, reasoningEffort: ReasoningEffort = "provider-default"): AgentModelSelection => ({ model, reasoningEffort });

  test("a route's chain is its model then its fallbacks, and back", () => {
    const form = { model: "a/one", reasoningEffort: "high" as const, fallbacks: [step("b/two"), step("c/three", "low")] };
    expect(defaultChain(form)).toEqual([step("a/one", "high"), step("b/two"), step("c/three", "low")]);
    expect(withDefaultChain(form, [step("b/two"), step("a/one", "high")])).toEqual({ model: "b/two", reasoningEffort: "provider-default", fallbacks: [step("a/one", "high")] });
    const agent = { override: true, selection: step("a/one", "xhigh"), fallbacks: [step("b/two")] };
    expect(agentChain(agent)).toEqual([step("a/one", "xhigh"), step("b/two")]);
    expect(withAgentChain(agent, [step("b/two")])).toEqual({ override: true, selection: step("b/two"), fallbacks: [] });
    // A route keeps a first choice: an empty chain changes nothing.
    expect(withDefaultChain(form, [])).toBe(form);
    expect(withAgentChain(agent, [])).toBe(agent);
  });

  test("a step moves to another place in the chain, the rest keeping their order", () => {
    const chain = [step("a"), step("b"), step("c"), step("d")];
    expect(moveStep(chain, 2, 0).map((s) => s.model)).toEqual(["c", "a", "b", "d"]);
    expect(moveStep(chain, 0, 3).map((s) => s.model)).toEqual(["b", "c", "d", "a"]);
    expect(moveStep(chain, 1, 1).map((s) => s.model)).toEqual(["a", "b", "c", "d"]);
    expect(moveStep(chain, 0, 9).map((s) => s.model)).toEqual(["a", "b", "c", "d"]);
  });

  test("the model menu groups the configured models by provider, marking the ones already on the route", () => {
    const config = {
      models: {
        providers: {
          "provider-1": { type: "openai-compatible", models: [{ id: "anthropic/claude-opus-5-5" }, { id: "openai/gpt-6.1-sol" }] },
          kilo: { type: "kilo", models: [{ id: "x-ai/grok-4.7" }] },
          empty: { type: "openai", models: [] }
        }
      }
    } as unknown as SettingsConfigResponse;
    const groups = modelMenuGroups(config, new Set(["provider-1/openai/gpt-6.1-sol", "kilo/x-ai/grok-4.7"]), "kilo/x-ai/grok-4.7");
    expect(groups.map((g) => [g.provider, g.models.map((m) => [m.ref, m.modelId, m.used])])).toEqual([
      ["provider-1", [["provider-1/anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5", false], ["provider-1/openai/gpt-6.1-sol", "openai/gpt-6.1-sol", true]]],
      // A step's own model is not "used" by another step.
      ["kilo", [["kilo/x-ai/grok-4.7", "x-ai/grok-4.7", false]]]
    ]);
  });
});
