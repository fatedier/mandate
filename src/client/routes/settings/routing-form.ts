import type {
  AgentModelSelection,
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

/** Legacy configs carry "" for "let the provider decide"; the form vocabulary
 *  only knows "provider-default" (same normalization as the old pane). */
function normalizeSelection(selection: AgentModelSelection): AgentModelSelection {
  return {
    model: selection.model,
    reasoningEffort: selection.reasoningEffort || "provider-default"
  };
}

export function deriveDefaultRoute(config: SettingsConfigResponse): DefaultRouteForm {
  return {
    model: config.models.default.model,
    reasoningEffort: config.models.default.reasoningEffort || "provider-default",
    fallbacks: config.models.default.modelFallbacks.map(normalizeSelection)
  };
}

export function deriveManagerRoute(config: SettingsConfigResponse): AgentRouteForm {
  return {
    override: Boolean(config.agent.modelOverrides?.manager),
    selection: normalizeSelection(config.agent.managerModel),
    fallbacks: config.agent.managerModelFallbacks.map(normalizeSelection)
  };
}

export function deriveWorkerRoute(config: SettingsConfigResponse): AgentRouteForm {
  return {
    override: Boolean(config.agent.modelOverrides?.worker),
    selection: normalizeSelection(config.agent.workerModel),
    fallbacks: config.agent.workerModelFallbacks.map(normalizeSelection)
  };
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
 *  and the agent falls back to the default route. */
export function buildManagerRoutePatch(form: AgentRouteForm): SettingsConfigUpdate {
  return {
    agent: {
      managerModel: form.override ? normalizeSelection(form.selection) : null,
      managerModelFallbacks: form.override ? form.fallbacks.map(normalizeSelection) : null
    }
  };
}

export function buildWorkerRoutePatch(form: AgentRouteForm): SettingsConfigUpdate {
  return {
    agent: {
      workerModel: form.override ? normalizeSelection(form.selection) : null,
      workerModelFallbacks: form.override ? form.fallbacks.map(normalizeSelection) : null
    }
  };
}

/**
 * Every routable `provider/model` ref from the config, in config order.
 * A `current` ref that no provider serves anymore (renamed/removed provider)
 * is still offered — first — so an existing route renders and stays saveable.
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
      if (!model.id || seen.has(ref)) continue;
      seen.add(ref);
      options.push({ value: ref, label: ref });
    }
  }
  if (current && !seen.has(current)) {
    options.unshift({ value: current, label: current });
  }
  return options;
}
