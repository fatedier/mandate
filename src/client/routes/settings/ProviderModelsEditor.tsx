import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { randomId } from "@/lib/random-id";
import { cn } from "@/lib/utils";
import type { ProviderModelCatalogItem } from "@shared/api-contracts";
import type { ModelInputType } from "@shared/settings";
import {
  MODEL_REASONING_SUPPORT_OPTIONS,
  reasoningSupportForForm,
  setModelInput,
  type ModelForm,
  type ModelReasoningSupport
} from "./provider-form";
import { SelectField, TextField } from "./settings-fields";
import { SettingSubGroup } from "./SettingRow";

export type ProviderCatalog = { models: ProviderModelCatalogItem[]; source: string };

export function ProviderModelsEditor({
  models,
  catalog,
  onRefresh,
  onChange
}: {
  models: ModelForm[];
  catalog: ProviderCatalog;
  onRefresh: () => void;
  onChange: (models: ModelForm[]) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedFormId, setSelectedFormId] = useState<string | null>(null);
  const [customId, setCustomId] = useState("");

  const enabledIds = useMemo(() => new Set(models.map((m) => m.modelId)), [models]);
  const selected = models.find((m) => m.id === selectedFormId) ?? null;
  const filtered = catalog.models.filter(
    (item) => !query.trim() || item.id.toLowerCase().includes(query.trim().toLowerCase())
  );

  const updateModel = (id: string, next: ModelForm) => {
    onChange(models.map((model) => (model.id === id ? next : model)));
  };
  const addFromCatalog = (item: ProviderModelCatalogItem) => {
    onChange([
      ...models,
      {
        id: randomId(),
        modelId: item.id,
        input: Array.from(new Set<ModelInputType>(["text", ...item.input])),
        supportsReasoning: reasoningSupportForForm(item.supportsReasoning)
      }
    ]);
  };
  const removeByModelId = (modelId: string) => {
    onChange(models.filter((model) => model.modelId !== modelId));
    setSelectedFormId(null);
  };
  const addCustom = () => {
    const modelId = customId.trim();
    if (!modelId || enabledIds.has(modelId)) return;
    onChange([
      ...models,
      { id: randomId(), modelId, input: ["text"], supportsReasoning: "auto" }
    ]);
    setCustomId("");
  };

  return (
    <SettingSubGroup
      label="Enabled models"
      action={
        <Button variant="ghost" size="xs" onClick={() => setPickerOpen((open) => !open)}>
          <Plus className="h-3.5 w-3.5" />
          <span>Add model</span>
        </Button>
      }
    >
      {models.length === 0 ? (
        <span className="text-xs text-chrome">
          None — routes pointing at this provider will not resolve.
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {models.map((model) => (
            <span
              key={model.id}
              data-model-chip={model.modelId}
              onClick={() =>
                setSelectedFormId((prev) => (prev === model.id ? null : model.id))
              }
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-md border border-border-soft bg-sel px-2 py-0.5 font-mono text-2xs",
                selectedFormId === model.id && "border-status-review/50"
              )}
            >
              {model.modelId || "unnamed"}
              <button
                type="button"
                aria-label={`Remove ${model.modelId || "model"}`}
                className="text-faint hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  removeByModelId(model.modelId);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Per-model capabilities: only what the listing APIs cannot answer. */}
      {selected ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-border-soft bg-background px-3 py-2">
          <span className="font-mono text-2xs text-chrome">{selected.modelId}</span>
          <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-chrome hover:text-muted-foreground">
            <input
              type="checkbox"
              data-cap-image
              className="h-3 w-3"
              checked={selected.input.includes("image")}
              onChange={(event) =>
                updateModel(selected.id, {
                  ...selected,
                  input: setModelInput(selected.input, "image", event.target.checked)
                })
              }
            />
            <span>Image input</span>
          </label>
          <div className="flex items-center gap-1.5">
            <span className="text-2xs text-chrome">Reasoning</span>
            <SelectField<ModelReasoningSupport>
              ariaLabel="Reasoning support"
              value={selected.supportsReasoning}
              options={MODEL_REASONING_SUPPORT_OPTIONS}
              onChange={(supportsReasoning) =>
                updateModel(selected.id, { ...selected, supportsReasoning })
              }
            />
          </div>
        </div>
      ) : null}

      {pickerOpen ? (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-border-soft bg-background p-3">
          <div className="flex items-center gap-2">
            <TextField
              ariaLabel="Filter models"
              value={query}
              placeholder="Filter models…"
              onChange={setQuery}
            />
            <span className="ml-auto shrink-0 text-2xs text-chrome">
              {catalog.source === "live"
                ? "Live list from the provider"
                : "Live list unavailable — add by id"}
            </span>
            <Button variant="ghost" size="xs" onClick={onRefresh}>
              Refresh
            </Button>
          </div>
          {filtered.length > 0 ? (
            <div className="flex max-h-56 flex-col gap-px overflow-y-auto scrollbar-thin">
              {filtered.map((item) => {
                const enabled = enabledIds.has(item.id);
                return (
                  <label
                    key={item.id}
                    data-catalog-item={item.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-sel"
                  >
                    <input
                      type="checkbox"
                      className="h-3 w-3"
                      checked={enabled}
                      onChange={() => (enabled ? removeByModelId(item.id) : addFromCatalog(item))}
                    />
                    <span className="font-mono text-xs">{item.id}</span>
                  </label>
                );
              })}
            </div>
          ) : (
            <span className="px-1.5 text-2xs text-chrome">No models match.</span>
          )}
          <div className="flex items-center gap-2 border-t border-border-soft pt-2">
            <input
              data-custom-model
              value={customId}
              placeholder="custom-model-id"
              onChange={(event) => setCustomId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addCustom();
                }
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-border-soft bg-background px-2 font-mono text-2xs"
            />
            <Button
              variant="ghost"
              size="xs"
              aria-label="Add custom model"
              disabled={!customId.trim() || enabledIds.has(customId.trim())}
              onClick={addCustom}
            >
              Add
            </Button>
          </div>
        </div>
      ) : null}
    </SettingSubGroup>
  );
}
