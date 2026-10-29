import { expect, test } from "bun:test";
import type { ProviderModelCatalogItem } from "@shared/api-contracts";
import {
  groupCatalog,
  inUseLine,
  markLetter,
  modelRoutingUses,
  modelVendor,
  providerRoutingUses,
  providerTypeLabel,
  routingUseLabel
} from "@/routes/settings/provider-display";
import type { SettingsConfigResponse } from "@/routes/settings/types";

function routing(overrides: {
  manager?: string; worker?: string; global?: string; dream?: string; extraction?: string; subagent?: string;
  managerFallbacks?: string[]; workerFallbacks?: string[]; globalFallbacks?: string[]; dreamFallbacks?: string[]; extractionFallbacks?: string[];
  subagentFallbacks?: string[];
} = {}): SettingsConfigResponse {
  const selection = (model: string) => ({ model, reasoningEffort: "provider-default" });
  return {
    models: {
      default: { model: "proxy/model-a", reasoningEffort: "provider-default", modelFallbacks: [selection("proxy/model-b")] },
      providers: {}
    },
    agent: {
      modelOverrides: {
        manager: overrides.manager !== undefined, worker: overrides.worker !== undefined, global: overrides.global !== undefined,
        dream: overrides.dream !== undefined, extraction: overrides.extraction !== undefined, subagent: overrides.subagent !== undefined
      },
      managerModel: selection(overrides.manager ?? "proxy/model-a"),
      managerModelFallbacks: (overrides.managerFallbacks ?? []).map(selection),
      workerModel: selection(overrides.worker ?? "proxy/model-a"),
      workerModelFallbacks: (overrides.workerFallbacks ?? []).map(selection),
      globalModel: selection(overrides.global ?? "proxy/model-a"),
      globalModelFallbacks: (overrides.globalFallbacks ?? []).map(selection),
      dreamModel: selection(overrides.dream ?? "proxy/model-a"),
      dreamModelFallbacks: (overrides.dreamFallbacks ?? []).map(selection),
      extractionModel: selection(overrides.extraction ?? "proxy/model-a"),
      extractionModelFallbacks: (overrides.extractionFallbacks ?? []).map(selection),
      subagentModel: selection(overrides.subagent ?? "proxy/model-a"),
      subagentModelFallbacks: (overrides.subagentFallbacks ?? []).map(selection)
    }
  } as unknown as SettingsConfigResponse;
}

function item(id: string): ProviderModelCatalogItem {
  return { id, name: id, input: ["text"], contextLength: null, outputModalities: [], supportedParameters: [] };
}

test("a provider's type in words", () => {
  expect((["openai", "anthropic", "google", "kilo", "codex", "openai-compatible"] as const).map(providerTypeLabel)).toEqual([
    "OpenAI API", "Anthropic", "Google", "Kilo Gateway", "OpenAI Codex", "OpenAI compatible"
  ]);
});

test("a mark is the first letter or digit, upper-cased", () => {
  expect([markLetter("provider-1"), markLetter("_x"), markLetter("9lives"), markLetter("--")]).toEqual(["P", "X", "9", "?"]);
});

test("a model's vendor: its id's prefix, else the provider's own maker", () => {
  expect(modelVendor("anthropic/claude-opus-5-5", "openai-compatible")).toEqual({ prefix: "anthropic", label: "Anthropic", letter: "A" });
  expect(modelVendor("x-ai/grok-4.7", "kilo")).toEqual({ prefix: "x-ai", label: "xAI", letter: "X" });
  expect(modelVendor("zeta/model-q", "kilo")).toEqual({ prefix: "zeta", label: "zeta", letter: "Z" });
  expect(modelVendor("gpt-6.1-sol", "codex")).toEqual({ prefix: "openai", label: "OpenAI", letter: "O" });
  expect(modelVendor("plain-model", "openai-compatible")).toEqual({ prefix: "", label: "", letter: "P" });
});

test("what Routing uses a model for, overrides only when they are on", () => {
  expect(modelRoutingUses(routing(), "proxy/model-a")).toEqual(["default"]);
  expect(modelRoutingUses(routing(), "proxy/model-b")).toEqual(["fallback"]);
  expect(modelRoutingUses(routing(), "proxy/model-c")).toEqual([]);
  const overridden = routing({ worker: "proxy/model-b", manager: "proxy/model-c", managerFallbacks: ["proxy/model-d"] });
  expect(modelRoutingUses(overridden, "proxy/model-b")).toEqual(["fallback", "worker"]);
  expect(modelRoutingUses(overridden, "proxy/model-c")).toEqual(["manager"]);
  expect(modelRoutingUses(overridden, "proxy/model-d")).toEqual(["fallback"]);
});

test("a provider's uses are its models' uses, in one order", () => {
  expect(providerRoutingUses(routing(), "proxy", ["model-b", "model-a", "model-z"])).toEqual(["default", "fallback"]);
  expect(providerRoutingUses(routing(), "other", ["model-a"])).toEqual([]);
  expect(routingUseLabel("default", "tag")).toBe("Default");
  expect(routingUseLabel("default", "subline")).toBe("default model");
});

test("the catalog groups by vendor only when it serves two or more", () => {
  expect(groupCatalog([item("model-a"), item("model-b")], "openai").map((g) => [g.label, g.items.length])).toEqual([["", 2]]);
  expect(groupCatalog([item("anthropic/a"), item("anthropic/b")], "kilo").map((g) => g.label)).toEqual([""]);
  expect(
    groupCatalog([item("anthropic/a"), item("openai/b"), item("anthropic/c"), item("plain")], "openai-compatible").map((g) => [g.label, g.items.map((i) => i.id)])
  ).toEqual([
    ["Anthropic", ["anthropic/a", "anthropic/c"]],
    ["OpenAI", ["openai/b"]],
    ["Other", ["plain"]]
  ]);
});

test("a model on Your agent's own route is tagged so, and its fallbacks count as fallbacks", () => {
  const own = routing({ global: "proxy/model-e", globalFallbacks: ["proxy/model-f"] });
  expect(modelRoutingUses(own, "proxy/model-e")).toEqual(["global"]);
  expect(modelRoutingUses(own, "proxy/model-f")).toEqual(["fallback"]);
  expect(routingUseLabel("global", "tag")).toBe("Your agent");
  expect(routingUseLabel("global", "subline")).toBe("Your agent");
  // Off, its saved selection uses nothing.
  expect(modelRoutingUses(routing(), "proxy/model-e")).toEqual([]);
});

test("a model on the dream's or memory extraction's own route is tagged so and cannot go; their fallbacks count as fallbacks", () => {
  const own = routing({ dream: "proxy/model-g", dreamFallbacks: ["proxy/model-h"], extraction: "proxy/model-i" });
  expect(modelRoutingUses(own, "proxy/model-g")).toEqual(["dream"]);
  expect(modelRoutingUses(own, "proxy/model-h")).toEqual(["fallback"]);
  expect(modelRoutingUses(own, "proxy/model-i")).toEqual(["extraction"]);
  expect(providerRoutingUses(own, "proxy", ["model-i", "model-g"])).toEqual(["dream", "extraction"]);
  expect([routingUseLabel("dream", "tag"), routingUseLabel("extraction", "tag")]).toEqual(["Dream", "Memory extraction"]);
  expect(inUseLine(modelRoutingUses(own, "proxy/model-i"), false)).toBe("In use by Routing (memory extraction). Change that first.");
  // Off, their saved selections use nothing.
  expect(modelRoutingUses(routing(), "proxy/model-g")).toEqual([]);
});

test("a model on the subagent route, while it is set, is tagged so and cannot go; unset, the route holds nothing", () => {
  const own = routing({ subagent: "proxy/model-j", subagentFallbacks: ["proxy/model-k"] });
  expect(modelRoutingUses(own, "proxy/model-j")).toEqual(["subagent"]);
  expect(modelRoutingUses(own, "proxy/model-k")).toEqual(["fallback"]);
  expect(providerRoutingUses(own, "proxy", ["model-j"])).toEqual(["subagent"]);
  expect([routingUseLabel("subagent", "tag"), routingUseLabel("subagent", "subline")]).toEqual(["Subagents", "subagents"]);
  expect(inUseLine(modelRoutingUses(own, "proxy/model-j"), false)).toBe("In use by Routing (subagents). Change that first.");
  // Its tag sits after the workers' and before the dream's, as its lane does.
  expect(modelRoutingUses(routing({ worker: "proxy/model-j", subagent: "proxy/model-j", dream: "proxy/model-j" }), "proxy/model-j"))
    .toEqual(["worker", "subagent", "dream"]);
  // Unset: a subagent runs on the asking agent's route, whose models count
  // there; the subagent route's saved selection blocks nothing.
  const unset = { ...own, agent: { ...own.agent, modelOverrides: { ...own.agent.modelOverrides, subagent: false } } } as unknown as SettingsConfigResponse;
  expect(modelRoutingUses(unset, "proxy/model-j")).toEqual([]);
  expect(inUseLine(providerRoutingUses(unset, "proxy", ["model-j", "model-k"]), false)).toBeNull();
});
