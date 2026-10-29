import type { ProviderModelCatalogItem } from "@shared/api-contracts";
import type { AgentRoute } from "./routing-form";
import type { AgentModelSelection, ProviderType, SettingsConfigResponse } from "./types";

/** The provider type in words, said once under the provider's name. */
const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  openai: "OpenAI API",
  anthropic: "Anthropic",
  google: "Google",
  kilo: "Kilo Gateway",
  codex: "OpenAI Codex",
  "openai-compatible": "OpenAI compatible"
};

export function providerTypeLabel(type: ProviderType): string {
  return PROVIDER_TYPE_LABELS[type];
}

/** Where each provider hands out its API keys, as its own docs link it. */
export const API_KEY_PAGES: Partial<Record<ProviderType, string>> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://platform.claude.com/settings/keys",
  google: "https://aistudio.google.com/apikey",
  kilo: "https://app.kilo.ai"
};

/** The letter a mark shows: the first letter or digit, upper-cased. */
export function markLetter(text: string): string {
  const match = /[\p{L}\p{N}]/u.exec(text);
  return match ? match[0].toUpperCase() : "?";
}

const VENDOR_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "x-ai": "xAI",
  "meta-llama": "Meta",
  mistralai: "Mistral",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  moonshotai: "Moonshot"
};

/** The vendor a provider of one maker serves, for ids without a prefix. */
const PROVIDER_VENDOR: Partial<Record<ProviderType, string>> = {
  openai: "openai",
  codex: "openai",
  anthropic: "anthropic",
  google: "google"
};

/** Whose model an id names: the prefix before its first "/", else the
 *  provider's own vendor; "" when neither says. */
export function modelVendor(
  modelId: string,
  providerType: ProviderType
): { prefix: string; label: string; letter: string } {
  const slash = modelId.indexOf("/");
  const prefix = slash > 0 ? modelId.slice(0, slash) : (PROVIDER_VENDOR[providerType] ?? "");
  const label = prefix ? (VENDOR_LABELS[prefix] ?? prefix) : "";
  return { prefix, label, letter: markLetter(label || modelId) };
}

export type RoutingUse = "default" | "fallback" | AgentRoute | "decisions";

/** The agents' routes: only a chat model can serve them. */
const OWN_ROUTES: readonly AgentRoute[] = ["global", "manager", "worker", "subagent", "page", "dream", "extraction"];
const ROUTING_ORDER: readonly RoutingUse[] = ["default", "fallback", ...OWN_ROUTES, "decisions", "managerRequestCheck", "managerStopCheck", "memoryRepeatCheck"];

/** What Routing uses a model for: the default model, a fallback (of the
 *  default route or of a route of its own that is on), or the first model of
 *  a route of its own; Decisions while it is on, each use of Decisions
 *  (manager request check, manager stop check, memory repeat check) while it
 *  is on and its own route is. The subagent route off holds nothing: a subagent then runs on
 *  the asking agent's route, whose models count there; nor does the page
 *  updates' route off. */
export function modelRoutingUses(config: SettingsConfigResponse, modelRef: string): RoutingUse[] {
  return routingUses(config, modelRef, { judgements: true });
}

/** The uses of a model that only a chat model can serve: the default route's
 *  and the agents' own. A model with one cannot become a decision model. */
export function modelAgentUses(config: SettingsConfigResponse, modelRef: string): RoutingUse[] {
  return routingUses(config, modelRef, { judgements: false });
}

function routingUses(config: SettingsConfigResponse, modelRef: string, opts: { judgements: boolean }): RoutingUse[] {
  const uses = new Set<RoutingUse>();
  const { models, agent } = config;
  if (models.default.model === modelRef) uses.add("default");
  const fallbacks = [...models.default.modelFallbacks];
  const routes: Array<{ use: RoutingUse; first: AgentModelSelection; rest: readonly AgentModelSelection[] }> = OWN_ROUTES
    .filter((route) => agent.modelOverrides[route])
    .map((route) => ({ use: route, first: agent[`${route}Model` as const], rest: agent[`${route}ModelFallbacks` as const] }));
  if (opts.judgements && agent.decisionsEnabled) {
    routes.push({ use: "decisions", first: agent.decisionsModel, rest: agent.decisionsModelFallbacks });
  }
  if (opts.judgements && agent.modelOverrides.managerRequestCheck && agent.managerRequestCheckEnabled) {
    routes.push({ use: "managerRequestCheck", first: agent.managerRequestCheckModel, rest: agent.managerRequestCheckModelFallbacks });
  }
  if (opts.judgements && agent.modelOverrides.managerStopCheck && agent.managerStopCheckEnabled) {
    routes.push({ use: "managerStopCheck", first: agent.managerStopCheckModel, rest: agent.managerStopCheckModelFallbacks });
  }
  if (opts.judgements && agent.modelOverrides.memoryRepeatCheck && agent.memoryRepeatCheckEnabled) {
    routes.push({ use: "memoryRepeatCheck", first: agent.memoryRepeatCheckModel, rest: agent.memoryRepeatCheckModelFallbacks });
  }
  for (const route of routes) {
    if (route.first.model === modelRef) uses.add(route.use);
    fallbacks.push(...route.rest);
  }
  if (fallbacks.some((selection) => selection.model === modelRef)) uses.add("fallback");
  return ROUTING_ORDER.filter((use) => uses.has(use));
}

/** Every use Routing makes of a provider's models. */
export function providerRoutingUses(
  config: SettingsConfigResponse,
  providerName: string,
  modelIds: readonly string[]
): RoutingUse[] {
  const uses = new Set(modelIds.flatMap((id) => modelRoutingUses(config, `${providerName}/${id}`)));
  return ROUTING_ORDER.filter((use) => uses.has(use));
}

const ROUTING_LABELS: Record<RoutingUse, { tag: string; subline: string }> = {
  default: { tag: "Default", subline: "default model" },
  fallback: { tag: "Fallback", subline: "fallback" },
  global: { tag: "Your agent", subline: "Your agent" },
  manager: { tag: "Manager", subline: "manager" },
  worker: { tag: "Worker", subline: "worker" },
  subagent: { tag: "Subagents", subline: "subagents" },
  page: { tag: "Page updates", subline: "page updates" },
  dream: { tag: "Dream", subline: "dream" },
  extraction: { tag: "Memory extraction", subline: "memory extraction" },
  decisions: { tag: "Decisions", subline: "decisions" },
  managerRequestCheck: { tag: "Manager request check", subline: "manager request check" },
  managerStopCheck: { tag: "Manager stop check", subline: "manager stop check" },
  memoryRepeatCheck: { tag: "Memory repeat check", subline: "memory repeat check" }
};

export function routingUseLabel(use: RoutingUse, form: "tag" | "subline"): string {
  return ROUTING_LABELS[use][form];
}

/** Why a model, or a provider's models, cannot be removed: what uses them,
 *  Routing (the routes that are on) and Memory's embeddings. Null when
 *  nothing does. */
export function inUseLine(uses: readonly RoutingUse[], embeddings: boolean): string | null {
  const users: string[] = [];
  if (uses.length > 0) users.push(`Routing (${uses.map((use) => routingUseLabel(use, "subline")).join(", ")})`);
  if (embeddings) users.push("Memory embeddings");
  if (users.length === 0) return null;
  return users.length === 1
    ? `In use by ${users[0]}. Change that first.`
    : `In use by ${users.join(" and ")}. Change those first.`;
}

/** A provider's listed models in vendor groups, when it serves two vendors
 *  or more; one unnamed group otherwise. Groups keep first-seen order. */
export function groupCatalog(
  items: readonly ProviderModelCatalogItem[],
  providerType: ProviderType
): Array<{ label: string; items: ProviderModelCatalogItem[] }> {
  const groups = new Map<string, { label: string; items: ProviderModelCatalogItem[] }>();
  for (const item of items) {
    const { prefix, label } = modelVendor(item.id, providerType);
    const group = groups.get(prefix) ?? { label: label || "Other", items: [] };
    group.items.push(item);
    groups.set(prefix, group);
  }
  if (groups.size < 2) return [{ label: "", items: [...items] }];
  return [...groups.values()];
}
