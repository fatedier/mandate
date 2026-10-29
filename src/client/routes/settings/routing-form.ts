import type {
  AgentModelSelection,
  ProviderType,
  ReasoningEffort,
  SettingsConfigResponse,
  SettingsConfigUpdate
} from "./types";

export type DefaultRouteForm = {
  model: string;
  reasoningEffort: ReasoningEffort;
  fallbacks: AgentModelSelection[];
};

export type AgentRouteForm = {
  override: boolean;
  selection: AgentModelSelection;
  fallbacks: AgentModelSelection[];
};

/** A copy of a selection, so the form edits its own. */
function normalizeSelection(selection: AgentModelSelection): AgentModelSelection {
  return { model: selection.model, reasoningEffort: selection.reasoningEffort };
}

export function deriveDefaultRoute(config: SettingsConfigResponse): DefaultRouteForm {
  return {
    model: config.models.default.model,
    reasoningEffort: config.models.default.reasoningEffort,
    fallbacks: config.models.default.modelFallbacks.map(normalizeSelection)
  };
}

/** The routes that can run on a chain of their own. */
export type AgentRoute = keyof SettingsConfigResponse["agent"]["modelOverrides"];

export function deriveAgentRoute(config: SettingsConfigResponse, route: AgentRoute): AgentRouteForm {
  return {
    override: Boolean(config.agent.modelOverrides?.[route]),
    selection: normalizeSelection(config.agent[`${route}Model` as const]),
    fallbacks: config.agent[`${route}ModelFallbacks` as const].map(normalizeSelection)
  };
}

export function deriveManagerRoute(config: SettingsConfigResponse): AgentRouteForm {
  return deriveAgentRoute(config, "manager");
}

export function deriveGlobalRoute(config: SettingsConfigResponse): AgentRouteForm {
  return deriveAgentRoute(config, "global");
}

export function deriveWorkerRoute(config: SettingsConfigResponse): AgentRouteForm {
  return deriveAgentRoute(config, "worker");
}

export function buildDefaultRoutePatch(form: DefaultRouteForm): SettingsConfigUpdate {
  return {
    models: {
      default: {
        model: form.model,
        reasoningEffort: form.reasoningEffort,
        modelFallbacks: form.fallbacks.map(normalizeSelection)
      }
    }
  };
}

/** Override off persists as null on both fields — the server clears the route
 *  and it follows the default route (the subagent route: the route of the
 *  agent that asks). */
export function buildAgentRoutePatch(route: AgentRoute, form: AgentRouteForm): SettingsConfigUpdate {
  const agent: NonNullable<SettingsConfigUpdate["agent"]> = {
    [`${route}Model`]: form.override ? normalizeSelection(form.selection) : null,
    [`${route}ModelFallbacks`]: form.override ? form.fallbacks.map(normalizeSelection) : null
  };
  return { agent };
}

export function buildManagerRoutePatch(form: AgentRouteForm): SettingsConfigUpdate {
  return buildAgentRoutePatch("manager", form);
}

export function buildGlobalRoutePatch(form: AgentRouteForm): SettingsConfigUpdate {
  return buildAgentRoutePatch("global", form);
}

export function buildWorkerRoutePatch(form: AgentRouteForm): SettingsConfigUpdate {
  return buildAgentRoutePatch("worker", form);
}

/** A chain not set yet: one step that asks for a model. */
const NO_STEP: AgentModelSelection = { model: "", reasoningEffort: "provider-default" };

/** Decisions: its chain, and whether it is on. Off keeps the chain. */
export type DecisionsForm = {
  enabled: boolean;
  selection: AgentModelSelection;
  fallbacks: AgentModelSelection[];
};

export function deriveDecisions(config: SettingsConfigResponse): DecisionsForm {
  return {
    enabled: Boolean(config.agent.decisionsEnabled),
    selection: normalizeSelection(config.agent.decisionsModel ?? NO_STEP),
    fallbacks: (config.agent.decisionsModelFallbacks ?? []).map(normalizeSelection)
  };
}

/** The switch, with the chain's steps that have a model: a model added
 *  behind a first choice still asking for one becomes the first choice, and
 *  a chain with none is not sent. */
export function buildDecisionsPatch(form: DecisionsForm): SettingsConfigUpdate {
  const [first, ...rest] = [form.selection, ...form.fallbacks].filter((step) => step.model);
  return {
    agent: {
      decisionsEnabled: form.enabled,
      ...(first ? { decisionsModel: normalizeSelection(first), decisionsModelFallbacks: rest.map(normalizeSelection) } : {})
    }
  };
}

/** Whether Decisions runs: on, with a model. */
export function decisionsRun(config: SettingsConfigResponse): boolean {
  return Boolean(config.agent.decisionsEnabled && config.agent.decisionsModel?.model);
}

/** A use of Decisions (manager request check, manager stop check, memory repeat check). */
export type JudgementUse = "managerRequestCheck" | "managerStopCheck" | "memoryRepeatCheck";

/** A use of Decisions' own route; while it has none, the chain it would
 *  start from is Decisions'. */
export function deriveJudgementUseRoute(config: SettingsConfigResponse, route: JudgementUse): AgentRouteForm {
  if (config.agent.modelOverrides?.[route]) return deriveAgentRoute(config, route);
  const decisions = deriveDecisions(config);
  return { override: false, selection: decisions.selection, fallbacks: decisions.fallbacks };
}

/** As Decisions' chain: a model added behind a first choice still asking
 *  for one (Decisions had none to start from) becomes the first choice. */
export function buildJudgementUseRoutePatch(route: JudgementUse, form: AgentRouteForm): SettingsConfigUpdate {
  const [first, ...rest] = agentChain(form).filter((step) => step.model);
  return buildAgentRoutePatch(route, first ? { ...form, selection: first, fallbacks: rest } : form);
}

/** Whether a `provider/model` ref names a decision model. */
export function isDecisionModelRef(config: SettingsConfigResponse, ref: string): boolean {
  const slash = ref.indexOf("/");
  if (slash <= 0) return false;
  const models = config.models.providers[ref.slice(0, slash)]?.models ?? [];
  return models.some((model) => model.id === ref.slice(slash + 1) && model.kind === "decision");
}

/**
 * Every chat model's `provider/model` ref from the config, in config order (a
 * decision model only answers Decisions). A `current` ref that is not one of
 * them (a renamed or removed provider) is still offered — first — so an
 * existing choice renders and stays saveable.
 */
export function modelRefOptions(
  config: SettingsConfigResponse,
  current?: string
): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  for (const [name, provider] of Object.entries(config.models.providers)) {
    for (const model of provider.models) {
      const ref = `${name}/${model.id}`;
      if (!model.id || model.kind === "decision" || seen.has(ref)) continue;
      seen.add(ref);
      options.push({ value: ref, label: ref });
    }
  }
  if (current && !seen.has(current)) {
    options.unshift({ value: current, label: current });
  }
  return options;
}

/** One step of a route: the model tried, at its effort. */
export type RouteStep = AgentModelSelection;

/** A route as the chain it is tried in: its model, then its fallbacks. */
export function defaultChain(form: DefaultRouteForm): RouteStep[] {
  return [{ model: form.model, reasoningEffort: form.reasoningEffort }, ...form.fallbacks];
}

export function withDefaultChain(form: DefaultRouteForm, steps: RouteStep[]): DefaultRouteForm {
  const [first, ...rest] = steps;
  if (!first) return form;
  return { ...form, model: first.model, reasoningEffort: first.reasoningEffort, fallbacks: rest };
}

/** A route of its own, or Decisions: its first choice and fallbacks. */
type ChainForm = Pick<AgentRouteForm, "selection" | "fallbacks">;

export function agentChain(form: ChainForm): RouteStep[] {
  return [form.selection, ...form.fallbacks];
}

export function withAgentChain<F extends ChainForm>(form: F, steps: RouteStep[]): F {
  const [first, ...rest] = steps;
  if (!first) return form;
  return { ...form, selection: first, fallbacks: rest };
}

/** The chain with the step at `from` moved to `to`; out of range, unchanged. */
export function moveStep(steps: RouteStep[], from: number, to: number): RouteStep[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) return steps;
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export type ModelMenuGroup = {
  provider: string;
  providerType: ProviderType;
  models: Array<{ ref: string; modelId: string; used: boolean }>;
};

/** The models set up in Providers, under their provider, for a step's model
 *  menu: one already on the route (`used`, other than the step's own `own`)
 *  is marked, so it is not picked twice. Decision models only for a route
 *  that makes decisions (`decisions`). Providers with no model are left out. */
export function modelMenuGroups(
  config: SettingsConfigResponse,
  used: ReadonlySet<string>,
  own?: string,
  opts: { decisions?: boolean } = {}
): ModelMenuGroup[] {
  const groups: ModelMenuGroup[] = [];
  for (const [provider, settings] of Object.entries(config.models.providers)) {
    const models = settings.models
      .filter((model) => model.id && (opts.decisions || model.kind !== "decision"))
      .map((model) => {
        const ref = `${provider}/${model.id}`;
        return { ref, modelId: model.id, used: ref !== own && used.has(ref) };
      });
    if (models.length > 0) groups.push({ provider, providerType: settings.type, models });
  }
  return groups;
}
