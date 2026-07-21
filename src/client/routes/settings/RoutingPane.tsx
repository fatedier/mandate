import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  buildDefaultRoutePatch,
  buildWorkerRoutePatch,
  buildManagerRoutePatch,
  deriveDefaultRoute,
  deriveWorkerRoute,
  deriveManagerRoute,
  modelRefOptions,
  type AgentRouteForm
} from "./routing-form";
import { useSaveUnit, useSettingsConfig } from "./settings-config";
import { ModelRefField, SelectField } from "./settings-fields";
import { SettingRow, SettingSubGroup } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import {
  REASONING_EFFORT_OPTIONS,
  type AgentModelSelection,
  type ReasoningEffort,
  type SettingsConfigResponse,
  type SettingsConfigUpdate
} from "./types";

/** Model routing pane: the default route plus per-agent override units. */
export function RoutingPane() {
  return (
    <div className="flex flex-col gap-4">
      <DefaultRouteBlock />
      <AgentRouteBlock
        title="Manager"
        description="The agent watching the whole workspace."
        switchAriaLabel="Override route for manager"
        derive={deriveManagerRoute}
        buildPatch={buildManagerRoutePatch}
      />
      <AgentRouteBlock
        title="Workers"
        description="Every agent working inside a feature."
        switchAriaLabel="Override route for workers"
        derive={deriveWorkerRoute}
        buildPatch={buildWorkerRoutePatch}
      />
    </div>
  );
}

function DefaultRouteBlock() {
  const { config } = useSettingsConfig();
  const unit = useSaveUnit({ derive: deriveDefaultRoute, buildPatch: buildDefaultRoutePatch });
  const form = unit.form;
  if (!form || !config) return null;
  return (
    <SettingsSection
      title="Default route"
      description="Used by every agent that doesn't override it."
      rows
      footer={unit.footer}
    >
      <SettingRow anchor="route-model" label="Model" fit="wide">
        <ModelRefField
          ariaLabel="Default model"
          value={form.model}
          options={modelRefOptions(config, form.model)}
          onChange={(model) => unit.setForm((prev) => ({ ...prev, model }))}
        />
      </SettingRow>
      <SettingRow anchor="route-effort" label="Reasoning effort">
        <SelectField<ReasoningEffort>
          ariaLabel="Default reasoning effort"
          value={form.reasoningEffort}
          options={REASONING_EFFORT_OPTIONS}
          onChange={(reasoningEffort) => unit.setForm((prev) => ({ ...prev, reasoningEffort }))}
        />
      </SettingRow>
      <FallbackList
        anchor="route-fallbacks"
        config={config}
        primaryModel={form.model}
        fallbacks={form.fallbacks}
        onChange={(fallbacks) => unit.setForm((prev) => ({ ...prev, fallbacks }))}
      />
    </SettingsSection>
  );
}

function AgentRouteBlock({
  title,
  description,
  switchAriaLabel,
  derive,
  buildPatch
}: {
  title: string;
  description: string;
  switchAriaLabel: string;
  derive: (config: SettingsConfigResponse) => AgentRouteForm;
  buildPatch: (form: AgentRouteForm) => SettingsConfigUpdate;
}) {
  const { config } = useSettingsConfig();
  const unit = useSaveUnit({ derive, buildPatch });
  const form = unit.form;
  if (!form || !config) return null;
  return (
    <SettingsSection
      title={title}
      // Off, the group is its own explanation — a body row saying "Uses the
      // default route." under a description saying the same thing spent three
      // lines and a divider on one boolean.
      description={form.override ? description : `${description} Currently follows the default route.`}
      rows
      headerSlot={
        <Switch
          checked={form.override}
          aria-label={switchAriaLabel}
          onCheckedChange={(override) => unit.setForm((prev) => ({ ...prev, override }))}
        />
      }
      footer={unit.footer}
    >
      {form.override ? (
        <>
          <SettingRow label="Model" fit="wide">
            <ModelRefField
              ariaLabel={`${title} model`}
              value={form.selection.model}
              options={modelRefOptions(config, form.selection.model)}
              onChange={(model) =>
                unit.setForm((prev) => ({ ...prev, selection: { ...prev.selection, model } }))
              }
            />
          </SettingRow>
          <SettingRow label="Reasoning effort">
            <SelectField<ReasoningEffort>
              ariaLabel={`${title} reasoning effort`}
              value={form.selection.reasoningEffort}
              options={REASONING_EFFORT_OPTIONS}
              onChange={(reasoningEffort) =>
                unit.setForm((prev) => ({
                  ...prev,
                  selection: { ...prev.selection, reasoningEffort }
                }))
              }
            />
          </SettingRow>
          <FallbackList
            config={config}
            primaryModel={form.selection.model}
            fallbacks={form.fallbacks}
            onChange={(fallbacks) => unit.setForm((prev) => ({ ...prev, fallbacks }))}
          />
        </>
      ) : null}
    </SettingsSection>
  );
}

/**
 * Ordered fallback rows for one route unit. Each row's model options exclude
 * refs the unit already routes to (primary + other fallbacks) but always keep
 * the row's own value; "Add fallback" appends the first unused ref.
 *
 * Rows are numbered rather than each re-labelling its two controls "Model" and
 * "Reasoning effort" — those words already appear twice above, and the ordinal
 * carries the one thing a fallback row actually needs to state, which is the
 * order it will be tried in.
 */
function FallbackList({
  anchor,
  config,
  primaryModel,
  fallbacks,
  onChange
}: {
  anchor?: string;
  config: SettingsConfigResponse;
  primaryModel: string;
  fallbacks: AgentModelSelection[];
  onChange: (fallbacks: AgentModelSelection[]) => void;
}) {
  const usedRefs = new Set([primaryModel, ...fallbacks.map((fallback) => fallback.model)]);
  const unusedRefs = modelRefOptions(config).filter((option) => !usedRefs.has(option.value));

  const optionsForRow = (index: number) => {
    const own = fallbacks[index]!.model;
    return modelRefOptions(config, own).filter(
      (option) => option.value === own || !usedRefs.has(option.value)
    );
  };
  const updateRow = (index: number, next: AgentModelSelection) => {
    onChange(fallbacks.map((fallback, i) => (i === index ? next : fallback)));
  };
  const removeRow = (index: number) => {
    onChange(fallbacks.filter((_, i) => i !== index));
  };
  const addFallback = () => {
    const first = unusedRefs[0];
    if (!first) return;
    onChange([...fallbacks, { model: first.value, reasoningEffort: "provider-default" }]);
  };

  return (
    <div id={anchor ? `setting-${anchor}` : undefined} className="scroll-mt-4">
      <SettingSubGroup
        label="Fallbacks"
        action={
          <Button variant="ghost" size="xs" disabled={unusedRefs.length === 0} onClick={addFallback}>
            <Plus className="h-3.5 w-3.5" />
            <span>Add fallback</span>
          </Button>
        }
      >
        {fallbacks.length === 0 ? (
          <span className="text-xs text-chrome">
            None — the route fails outright if its model is unavailable.
          </span>
        ) : (
          <div className="flex flex-col gap-2">
            {fallbacks.map((fallback, index) => (
              <div key={index} className="flex min-w-0 items-center gap-2">
                <span className="w-4 shrink-0 text-2xs tabular-nums text-chrome">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <ModelRefField
                    ariaLabel={`Fallback ${index + 1} model`}
                    value={fallback.model}
                    options={optionsForRow(index)}
                    onChange={(model) => updateRow(index, { ...fallback, model })}
                  />
                </div>
                <div className="w-32 shrink-0">
                  <SelectField<ReasoningEffort>
                    ariaLabel={`Fallback ${index + 1} reasoning effort`}
                    value={fallback.reasoningEffort}
                    options={REASONING_EFFORT_OPTIONS}
                    onChange={(reasoningEffort) => updateRow(index, { ...fallback, reasoningEffort })}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label={`Remove fallback ${index + 1}`}
                  onClick={() => removeRow(index)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </SettingSubGroup>
    </div>
  );
}
