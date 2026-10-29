import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { InlineError } from "@/components/ViewState";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ProviderModelCatalogItem } from "@shared/api-contracts";
import { errorText } from "@shared/error-text";
import { DEFAULT_MODEL_INPUTS } from "@shared/settings";
import { markLetter, modelVendor } from "./provider-display";
import { PriceField } from "./PriceField";
import { cacheLifetimeError, modelCacheFamily, serializeModelForm, setModelInput, type ModelCacheFamily, type ModelForm } from "./provider-form";
import { ProviderMark } from "./ProviderMark";
import type { FooterError } from "./settings-config";
import { TextField } from "./settings-fields";
import type { ModelProtocol, ProviderType } from "./types";

const KINDS: ReadonlyArray<{ value: ModelForm["kind"]; label: string }> = [
  { value: "chat", label: "Chat model" },
  { value: "decision", label: "Decision model" }
];

const DECISION_HELP = "Answers typed questions through OpenRouter's Decisions API instead of chatting. Only Decisions can use it.";

const OPTION_CLASS =
  "flex h-auto min-w-0 flex-col items-start gap-0.5 rounded-md border border-border-soft px-3 py-2 text-left hover:bg-sel data-[state=on]:border-status-review/70 data-[state=on]:bg-status-review/10";

const PROTOCOLS: ReadonlyArray<{ value: ModelProtocol; label: string; detail: string }> = [
  { value: "responses", label: "Responses", detail: "OpenAI's current API" },
  { value: "chat", label: "Chat Completions", detail: "OpenAI's classic API" },
  { value: "messages", label: "Messages", detail: "Anthropic's API" }
];

/**
 * One model's settings, edited as a draft: its kind and protocol (a custom
 * provider's only — the other types chat, on one API), image input and
 * reasoning; a decision model has none of the last three. Save saves the
 * draft and the dialog stays until it lands: a save that fails says why and
 * keeps the draft. Save is off until the draft differs; Cancel saves nothing.
 */
export function EditModelDialog({
  open,
  model,
  providerType,
  providerName,
  declared,
  kindBlocked = null,
  locked,
  onCancel,
  onSave
}: {
  open: boolean;
  model: ModelForm | null;
  providerType: ProviderType;
  providerName: string;
  /** What the provider's own model list declares for this model. */
  declared: ProviderModelCatalogItem["declared"];
  /** What uses the model that only a chat model can serve, when something
   *  does: it cannot become a decision model then. */
  kindBlocked?: string | null;
  /** Another write is on its way: Save waits for it. */
  locked: boolean;
  onCancel: () => void;
  /** Saves the model and closes the dialog; rejects when the save fails. */
  onSave: (next: ModelForm) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const save = async (next: ModelForm) => {
    setSaving(true);
    try {
      await onSave(next);
    } finally {
      setSaving(false);
    }
  };
  return (
    // Not closed while its save is on its way: what it is saving stays in view.
    <Dialog open={open && model !== null} onOpenChange={(next) => { if (!next && !saving) onCancel(); }}>
      <DialogContent className="sm:max-w-[520px]" aria-describedby={undefined}>
        {/* Mounted per opening: each one starts from the model as it is. */}
        {model ? (
          <EditModelBody
            key={model.id}
            model={model}
            providerType={providerType}
            providerName={providerName}
            declared={declared}
            kindBlocked={kindBlocked}
            saving={saving}
            locked={locked}
            onCancel={onCancel}
            onSave={save}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EditModelBody({ model, providerType, providerName, declared, kindBlocked, saving, locked, onCancel, onSave }: {
  model: ModelForm;
  providerType: ProviderType;
  providerName: string;
  declared: ProviderModelCatalogItem["declared"];
  kindBlocked: string | null;
  saving: boolean;
  locked: boolean;
  onCancel: () => void;
  onSave: (next: ModelForm) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ModelForm>(model);
  const [error, setError] = useState<FooterError | null>(null);
  // A price half typed (or a Price as with nothing picked) cannot be saved.
  const [priceValid, setPriceValid] = useState(true);
  const changed = serializeModelForm(draft) !== serializeModelForm(model);
  const custom = providerType === "openai-compatible";
  const decision = draft.kind === "decision";
  // A decision model already may always go back to chatting.
  const decisionBlocked = kindBlocked !== null && model.kind !== "decision";
  const cacheFamily = modelCacheFamily(providerType, draft.protocol, draft.modelId);
  const lifetimeError = decision ? "" : cacheLifetimeError(draft.cacheLifetimeMinutes ?? "", cacheFamily);

  const submit = async () => {
    setError(null);
    try {
      await onSave(draft);
    } catch (err) {
      setError({ message: "Couldn't save.", detail: errorText(err) });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex min-w-0 items-center gap-2.5 pr-6">
          <ProviderMark letter={modelVendor(draft.modelId, providerType).letter || markLetter(draft.modelId)} size="sm" />
          <span className="min-w-0 truncate font-mono text-[13px]">{draft.modelId}</span>
        </DialogTitle>
      </DialogHeader>
      {custom ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold text-muted-foreground">Kind</span>
          <ToggleGroup
            type="single"
            spacing={1.5}
            aria-label="Kind"
            disabled={saving}
            className="grid w-full grid-cols-2"
            value={draft.kind}
            onValueChange={(value) => { if (value) setDraft({ ...draft, kind: value as ModelForm["kind"] }); }}
          >
            {KINDS.map((kind) => (
              <ToggleGroupItem
                key={kind.value}
                value={kind.value}
                disabled={kind.value === "decision" && decisionBlocked}
                className={OPTION_CLASS}
              >
                <span className="text-xs font-semibold text-foreground">{kind.label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {decision ? <p className="text-xs leading-relaxed text-chrome">{DECISION_HELP}</p> : null}
          {decisionBlocked ? <p className="text-2xs leading-snug text-chrome">{kindBlocked}</p> : null}
        </div>
      ) : null}
      {custom && !decision ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold text-muted-foreground">Protocol</span>
          {/* Frozen while its save is on its way: a choice made then would
              be closed away unsaved. */}
          <ToggleGroup
            type="single"
            spacing={1.5}
            aria-label="Protocol"
            disabled={saving}
            className="grid w-full grid-cols-3 max-sm:grid-cols-1"
            value={draft.protocol}
            // A pressed option pressed again stays chosen: there is
            // always a protocol.
            onValueChange={(value) => { if (value) setDraft({ ...draft, protocol: value as ModelProtocol }); }}
          >
            {PROTOCOLS.map((protocol) => (
              <ToggleGroupItem key={protocol.value} value={protocol.value} className={OPTION_CLASS}>
                <span className="text-xs font-semibold text-foreground">{protocol.label}</span>
                <span className="text-2xs font-normal leading-snug text-faint">{protocol.detail}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ) : null}
      {decision ? null : (
        <div className="flex flex-col">
          <span className="pb-1 text-xs font-semibold text-muted-foreground">Capabilities</span>
          <CapabilityRow
            label="Image input"
            detail="Reads images you attach and screenshots its tools return."
            disabled={saving}
            checked={draft.input.includes("image")}
            onChange={(on) => setDraft({ ...draft, input: setModelInput(draft.input, "image", on) })}
          />
          <CapabilityRow
            label="Reasoning"
            detail="Thinks before it answers, at the effort Routing sets."
            disabled={saving}
            checked={draft.supportsReasoning}
            onChange={(on) => setDraft({ ...draft, supportsReasoning: on })}
          />
          <ListValues draft={draft} declared={declared} providerName={providerName} disabled={saving} onChange={setDraft} />
        </div>
      )}
      {decision ? null : (
        <CacheLifetimeRow
          family={cacheFamily}
          value={draft.cacheLifetimeMinutes ?? ""}
          error={lifetimeError}
          disabled={saving}
          onChange={(value) => {
            const { cacheLifetimeMinutes: _old, ...rest } = draft;
            // Emptied where none was saved: as it was, not a change.
            setDraft(value === "" && model.cacheLifetimeMinutes === undefined ? rest : { ...rest, cacheLifetimeMinutes: value });
          }}
        />
      )}
      <PriceField
        providerName={providerName}
        modelId={draft.modelId}
        value={draft.price}
        disabled={saving}
        onChange={(price, valid) => {
          const { price: _old, ...rest } = draft;
          setDraft(price ? { ...rest, price } : rest);
          setPriceValid(valid);
        }}
      />
      {/* Save, below it, is the way to try again. */}
      {error ? <InlineError detail={error.detail}>{error.message}</InlineError> : null}
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={!changed || !priceValid || Boolean(lifetimeError) || saving || locked} onClick={() => void submit()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}

function CapabilityRow({ label, detail, disabled, checked, onChange }: {
  label: string;
  detail: string;
  disabled: boolean;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 border-t border-border-soft py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        <p className="text-xs leading-relaxed text-chrome">{detail}</p>
      </div>
      <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  );
}

/** How long the provider keeps this model's cached prompt, in minutes, for
 *  idle compaction; empty is its family's default, 0 is off. */
function CacheLifetimeRow({ family, value, error, disabled, onChange }: {
  family: ModelCacheFamily;
  value: string;
  error: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const fallback = family === "claude" ? "60" : family === "gpt" ? "30" : "Off";
  return (
    <div className="flex flex-col">
      <span className="pb-1 text-xs font-semibold text-muted-foreground">Prompt cache</span>
      <div className="flex items-start gap-3 border-t border-border-soft py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm">Cache lifetime</div>
          <p className="text-xs leading-relaxed text-chrome">
            How long the provider keeps this model&apos;s cached prompt after its last use. Idle threads are compacted shortly before it ends. Empty uses the default; 0 turns it off for this model.
            {family === "claude" ? " At most 60: Mandate asks Claude for a one-hour cache." : ""}
          </p>
          {error ? <p className="mt-1 text-xs text-destructive" role="status">{error}</p> : null}
        </div>
        <div className="w-32 shrink-0">
          <TextField ariaLabel="Cache lifetime" value={value} placeholder={fallback} suffix="min" disabled={disabled} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

/** Where the values came from: the provider's own list says so, and a model
 *  changed by hand gets a way back to the list's values. */
function ListValues({ draft, declared, providerName, disabled, onChange }: {
  draft: ModelForm;
  declared: ProviderModelCatalogItem["declared"];
  providerName: string;
  disabled: boolean;
  onChange: (next: ModelForm) => void;
}) {
  // A capability the list doesn't mention defaults on.
  const listValues = declared && Object.keys(declared).length > 0
    ? { image: declared.image ?? true, reasoning: declared.reasoning ?? true }
    : null;
  if (!listValues) return null;
  const matches = draft.input.includes("image") === listValues.image && draft.supportsReasoning === listValues.reasoning;
  return matches ? (
    <span data-cap-note className="pt-1 text-2xs text-faint">From {providerName}&apos;s model list</span>
  ) : (
    <button
      type="button"
      data-cap-reset
      disabled={disabled}
      className="flex items-center gap-1 self-start rounded px-1.5 py-0.5 text-2xs text-chrome transition-colors hover:bg-sel hover:text-foreground pointer-coarse:min-h-11"
      onClick={() =>
        onChange({
          ...draft,
          input: listValues.image ? [...DEFAULT_MODEL_INPUTS] : ["text"],
          supportsReasoning: listValues.reasoning
        })
      }
    >
      <RotateCcw className="h-3 w-3" />
      <span>Use {providerName}&apos;s values</span>
    </button>
  );
}
