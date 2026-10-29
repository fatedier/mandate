import { useEffect, useState } from "react";
import { Eye, Lightbulb, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { InlineError } from "@/components/ViewState";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { errorText } from "@shared/error-text";
import { AddModelsDialog } from "./AddModelsDialog";
import { EditModelDialog } from "./EditModelDialog";
import { inUseLine, modelAgentUses, modelRoutingUses, modelVendor, routingUseLabel, type RoutingUse } from "./provider-display";
import type { ModelForm } from "./provider-form";
import { ProviderMark } from "./ProviderMark";
import type { FooterError } from "./settings-config";
import { SettingsSection } from "./SettingsSection";
import type { ModelProtocol, ProviderType, SettingsConfigResponse } from "./types";
import type { ProviderModelCatalogItem } from "@shared/api-contracts";
import type { PriceMatchDto, ProviderPricingResponse } from "@shared/api/pricing";

/** `source` is the server's (live, builtin, configured), or the page's own
 *  before any list: loading, unsaved. */
export type ProviderCatalog = { models: ProviderModelCatalogItem[]; source: string };

const PROTOCOL_TAGS: Record<Exclude<ModelProtocol, "responses">, string> = {
  chat: "Chat Completions",
  messages: "Messages"
};

/**
 * A provider's Models section: one row per model (its vendor's mark, its
 * id, what Routing and Memory use it for, then a decision model's tag, or a
 * chat model's protocol when not the default, image and reasoning), opening
 * its edit dialog; a row's menu edits or removes it. Each of these is saved
 * at once (`onSaveModels`): a dialog closes when its save lands and keeps the
 * change when it fails. A model in use cannot be removed: its Remove says
 * what uses it. A model the agents' routes or Memory use cannot become a
 * decision model, said the same way. A model with no price of its own that
 * Automatic finds none for shows the price it looks like, taken in one click
 * (saved at once, like any model edit). `openModel` opens a model's dialog by
 * its id (a link from Activity), once; a model the provider no longer has
 * opens Add models with it picked, and its dialog once it is added.
 */
export function ProviderModels({
  providerKey,
  providerType,
  models,
  config,
  catalog,
  locked,
  pricing = null,
  openModel = null,
  onOpenModelDone,
  onRefreshCatalog,
  onSaveModels
}: {
  /** The provider's name, the prefix of every model reference. */
  providerKey: string;
  providerType: ProviderType;
  models: ModelForm[];
  config: SettingsConfigResponse;
  catalog: ProviderCatalog;
  /** Another write is on its way: nothing here saves until it lands. */
  locked: boolean;
  /** What Automatic finds for each saved model, when read. */
  pricing?: ProviderPricingResponse | null;
  /** A model id whose dialog opens once its row is here. */
  openModel?: string | null;
  /** `openModel` was handled: opened, or named no model here. */
  onOpenModelDone?: () => void;
  onRefreshCatalog: () => void;
  /** Saves the provider's models as given; rejects when the save fails. */
  onSaveModels: (models: ModelForm[]) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<FooterError | null>(null);
  const editing = models.find((model) => model.id === editingId) ?? null;
  const providerName = providerKey || "This provider";
  const refOf = (model: ModelForm) => `${providerKey}/${model.modelId.trim()}`;

  // Opened while rendering, once per link: the link is then forgotten.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // A linked model being added: its dialog opens once its row is here.
  const [openWhenAdded, setOpenWhenAdded] = useState<string | null>(null);
  if (openModel !== openedFor) {
    setOpenedFor(openModel);
    const named = openModel === null ? undefined : models.find((model) => model.modelId.trim() === openModel);
    // A new link replaces whatever the last one opened: one dialog at a time.
    if (named) {
      setAdding(false);
      setOpenWhenAdded(null);
      setEditingId(named.id);
    } else if (openModel !== null) {
      setEditingId(null);
      setOpenWhenAdded(openModel);
      setAdding(true);
    }
  }
  if (openWhenAdded !== null && !adding) {
    const added = models.find((model) => model.modelId.trim() === openWhenAdded);
    setOpenWhenAdded(null);
    if (added) setEditingId(added.id);
  }
  useEffect(() => {
    if (openModel !== null) onOpenModelDone?.();
  }, [openModel, onOpenModelDone]);

  const save = async (next: ModelForm[]) => {
    await onSaveModels(next);
    setRemoveError(null);
  };
  const remove = async (model: ModelForm) => {
    setRemovingId(model.id);
    try {
      await save(models.filter((item) => item.id !== model.id));
    } catch (err) {
      setRemoveError({ message: `Couldn't remove ${model.modelId || "unnamed"}.`, detail: errorText(err) });
    } finally {
      setRemovingId(null);
    }
  };
  const takePrice = async (model: ModelForm, suggestion: PriceMatchDto) => {
    try {
      await save(models.map((item) => (item.id === model.id ? { ...item, price: { as: suggestion.ref } } : item)));
    } catch (err) {
      setRemoveError({ message: "Couldn't save.", detail: errorText(err) });
    }
  };

  return (
    <>
      <SettingsSection
        title="Models"
        titleMeta={<span className="num text-2xs text-faint">{models.length}</span>}
        headerSlot={
          <Button variant="ghost" size="xs" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            <span>Add models</span>
          </Button>
        }
      >
        {removeError ? <InlineError detail={removeError.detail} className="pb-3">{removeError.message}</InlineError> : null}
        {models.length === 0 ? (
          <p className="text-xs text-chrome">No models yet — Add models to use this provider.</p>
        ) : (
          <div className="-mx-3.5 -my-3 divide-y divide-border-soft">
            {models.map((model) => {
              const uses = modelRoutingUses(config, refOf(model));
              const embeddings = config.memory.embedding.model === refOf(model);
              const suggestion = priceSuggestion(pricing, model);
              return (
                <div key={model.id}>
                <ModelRow
                  model={model}
                  providerType={providerType}
                  uses={uses}
                  embeddings={embeddings}
                  removeBlocked={inUseLine(uses, embeddings)}
                  removeOff={locked || removingId !== null}
                  onEdit={() => setEditingId(model.id)}
                  onRemove={() => void remove(model)}
                />
                {/* Lined up with the model's id: 14px in, an 18px mark, a 10px gap. */}
                {suggestion ? (
                  <p data-price-suggestion={model.modelId} className="flex flex-wrap items-center gap-2 pb-2 pl-[42px] pr-3.5 text-2xs text-chrome">
                    <span>Looks like {suggestion.label}.</span>
                    <Button variant="outline" size="xs" disabled={locked} onClick={() => void takePrice(model, suggestion)}>Use its price</Button>
                  </p>
                ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>
      <AddModelsDialog
        open={adding}
        providerName={providerName}
        providerType={providerType}
        catalog={catalog}
        existingIds={new Set(models.map((model) => model.modelId.trim()))}
        locked={locked}
        initialIds={openWhenAdded ? [openWhenAdded] : undefined}
        onRefresh={onRefreshCatalog}
        onCancel={() => setAdding(false)}
        onAdd={async (added) => {
          await save([...models, ...added]);
          setAdding(false);
        }}
      />
      <EditModelDialog
        open={editing !== null}
        model={editing}
        providerType={providerType}
        providerName={providerName}
        declared={catalog.models.find((item) => item.id === editing?.modelId)?.declared}
        kindBlocked={editing ? inUseLine(modelAgentUses(config, refOf(editing)), config.memory.embedding.model === refOf(editing)) : null}
        locked={locked}
        onCancel={() => setEditingId(null)}
        onSave={async (next) => {
          await save(models.map((model) => (model.id === next.id ? next : model)));
          setEditingId(null);
        }}
      />
    </>
  );
}

/** The price a model looks like, when it has no price of its own and
 *  Automatic finds none. */
function priceSuggestion(pricing: ProviderPricingResponse | null, model: ModelForm): PriceMatchDto | null {
  if (!pricing || model.price) return null;
  const id = model.modelId.trim();
  const match = Object.hasOwn(pricing.models, id) ? pricing.models[id] : undefined;
  return match && match.found === null ? match.suggestion : null;
}

function ModelRow({ model, providerType, uses, embeddings, removeBlocked, removeOff, onEdit, onRemove }: {
  model: ModelForm;
  providerType: ProviderType;
  uses: RoutingUse[];
  /** Memory turns memories into vectors with it. */
  embeddings: boolean;
  /** What uses it, when something does: it cannot be removed then. */
  removeBlocked: string | null;
  /** A write is on its way. */
  removeOff: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const id = model.modelId || "unnamed";
  const decision = model.kind === "decision";
  return (
    // 8px between the row and its menu on a touch screen: the menu's 44px
    // touch area reaches 8px past its button.
    <div data-model-row={model.modelId} className="flex min-h-10 items-center gap-1 pr-2 pointer-coarse:min-h-[45px] pointer-coarse:gap-2">
      {/* Named by what it shows, tags included: a label of its own would
          hide them from a screen reader. */}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch py-1.5 pl-3.5 text-left transition-colors hover:bg-sel"
        onClick={onEdit}
      >
        <span className="sr-only">Edit </span>
        <ProviderMark letter={modelVendor(model.modelId, providerType).letter} size="sm" />
        {/* Narrow (a phone), the id keeps its own line and the tags wrap
            under it: on one line four tags left the id no room at all. */}
        <span className="flex min-w-0 flex-1 items-center gap-2.5 @max-[34rem]:flex-col @max-[34rem]:items-start @max-[34rem]:gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-xs @max-[34rem]:w-full">{id}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {uses.map((use) => (
              <Tag key={use} accent={use === "default"}>{routingUseLabel(use, "tag")}</Tag>
            ))}
            {embeddings ? <Tag>Memory</Tag> : null}
            {/* A decision model does not chat: it has no protocol, image
                input or reasoning to show. */}
            {decision ? <Tag>Decision model</Tag> : null}
            {!decision && model.protocol !== "responses" && providerType === "openai-compatible" ? <Tag>{PROTOCOL_TAGS[model.protocol]}</Tag> : null}
            {decision ? null : (
              <span className="flex shrink-0 items-center gap-1.5 pr-1 text-chrome">
                {model.input.includes("image") ? (
                  <span role="img" aria-label="Image input" title="Image input"><Eye className="size-3" aria-hidden /></span>
                ) : null}
                {model.supportsReasoning ? (
                  <span role="img" aria-label="Reasoning" title="Reasoning"><Lightbulb className="size-3" aria-hidden /></span>
                ) : null}
              </span>
            )}
          </span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-chrome hover:text-foreground"
            aria-label={`Actions for ${id}`}
            title="Model actions"
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="h-4 w-4" />
            Edit…
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={removeBlocked !== null || removeOff} onSelect={onRemove}>
            <Trash2 className="h-4 w-4" />
            Remove
          </DropdownMenuItem>
          {removeBlocked ? <RemoveBlocked>{removeBlocked}</RemoveBlocked> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Under a Remove that is off: what uses the thing, in full contrast (the
 *  item itself is dimmed), lined up with the item's words. Shared by the
 *  provider page's menu. */
export function RemoveBlocked({ children }: { children: string }) {
  return <p data-slot="remove-blocked" className="max-w-64 px-2 pb-1.5 pl-8 text-2xs leading-snug text-chrome">{children}</p>;
}

function Tag({ accent, children }: { accent?: boolean; children: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-px text-2xs",
        accent ? "bg-status-review/15 text-status-review" : "bg-sel text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}
