import { useMemo, useState, type ReactNode } from "react";
import { RefreshCw, Search } from "lucide-react";
import { InlineError } from "@/components/ViewState";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { randomId } from "@/lib/random-id";
import type { ProviderModelCatalogItem } from "@shared/api-contracts";
import { errorText } from "@shared/error-text";
import { DEFAULT_MODEL_INPUTS } from "@shared/settings";
import { groupCatalog } from "./provider-display";
import type { ModelForm } from "./provider-form";
import type { ProviderCatalog } from "./ProviderModels";
import type { FooterError } from "./settings-config";
import type { ProviderType } from "./types";

/**
 * Adding models: the provider's own list (searchable, grouped by vendor
 * when it serves several), the models already added ticked and locked, and
 * any id it doesn't list added by hand. Add saves the ticked ones as model
 * rows and the dialog stays until that lands: a save that fails says why
 * and keeps the picks. Cancel adds nothing.
 */
type AddModelsProps = {
  providerName: string;
  providerType: ProviderType;
  catalog: ProviderCatalog;
  existingIds: ReadonlySet<string>;
  /** Another write is on its way: Add waits for it. */
  locked: boolean;
  onRefresh: () => void;
  onCancel: () => void;
  /** Saves the models and closes the dialog; rejects when the save fails. */
  onAdd: (models: ModelForm[]) => Promise<void>;
  /** Ids it opens with picked (and searched for): a link to a model the
   *  provider no longer has. */
  initialIds?: readonly string[];
};

export function AddModelsDialog({ open, onAdd, ...props }: AddModelsProps & { open: boolean }) {
  const [adding, setAdding] = useState(false);
  const add = async (models: ModelForm[]) => {
    setAdding(true);
    try {
      await onAdd(models);
    } finally {
      setAdding(false);
    }
  };
  return (
    // Not closed while its save is on its way.
    <Dialog open={open} onOpenChange={(next) => { if (!next && !adding) props.onCancel(); }}>
      <DialogContent className="flex max-h-[min(640px,calc(100dvh-2rem))] flex-col gap-3 sm:max-w-[560px]" aria-describedby={undefined}>
        {/* Mounted per opening, and again for another linked model: each
            starts with only what it was opened with. */}
        <AddModelsBody key={(props.initialIds ?? []).join("\n")} {...props} adding={adding} onAdd={add} />
      </DialogContent>
    </Dialog>
  );
}

function AddModelsBody({ providerName, providerType, catalog, existingIds, locked, adding, onRefresh, onCancel, onAdd, initialIds = [] }: AddModelsProps & { adding: boolean }) {
  const [error, setError] = useState<FooterError | null>(null);
  const [query, setQuery] = useState(initialIds[0] ?? "");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // Picked as if added by hand: the list's own row when it shows the id.
  const [typed, setTyped] = useState<string[]>(() => initialIds.filter((id) => id !== "" && !existingIds.has(id)));
  const [byId, setById] = useState("");

  const listed = useMemo(() => new Set(catalog.models.map((item) => item.id)), [catalog.models]);
  const needle = query.trim().toLowerCase();
  const matches = (id: string) => !needle || id.toLowerCase().includes(needle);
  const groups = groupCatalog(catalog.models.filter((item) => matches(item.id)), providerType);
  // An id added by hand that the list shows (after a Refresh) is that row.
  const chosenInList = (id: string) => picked.has(id) || typed.includes(id);
  const typedShown = typed.filter((id) => !listed.has(id) && matches(id));
  const candidate = byId.trim();
  const canAddById = candidate !== "" && !existingIds.has(candidate) && !listed.has(candidate) && !typed.includes(candidate);
  // What Add hands over, as the list stands now: a pick the refreshed list
  // no longer has is not counted, and nothing is added twice.
  const chosen: ModelForm[] = [
    ...catalog.models.filter((item) => !existingIds.has(item.id) && chosenInList(item.id)).map(modelFromCatalog),
    ...typed.filter((id) => !listed.has(id)).map(modelFromId)
  ];
  const count = chosen.length;

  const toggle = (id: string) => {
    if (typed.includes(id)) {
      setTyped((prev) => prev.filter((item) => item !== id));
      return;
    }
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // The picks are frozen while Add's save is on its way: one made then
  // would be closed away unsaved.
  const addById = () => {
    if (!canAddById || adding) return;
    setTyped((prev) => [...prev, candidate]);
    setById("");
  };

  const finish = async () => {
    if (count === 0) return;
    setError(null);
    try {
      await onAdd(chosen);
    } catch (err) {
      setError({ message: "Couldn't save.", detail: errorText(err) });
    }
  };

  return (
    <>
        <DialogHeader>
          <DialogTitle>Add models</DialogTitle>
        </DialogHeader>
        <div className="flex shrink-0 items-center gap-2">
          <div className="relative flex min-w-0 flex-1 items-center">
            <Search className="pointer-events-none absolute left-2.5 size-3.5 text-chrome" aria-hidden />
            <input
              type="search"
              value={query}
              aria-label="Search models"
              placeholder={`Search ${catalog.models.length} models`}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-chrome focus:border-ring focus:ring-[3px] focus:ring-ring/20 [&::-webkit-search-cancel-button]:hidden"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Button variant="ghost" size="xs" onClick={onRefresh}>
            <RefreshCw className="size-3.5" />
            <span>Refresh</span>
          </Button>
        </div>
        <p className="shrink-0 text-2xs text-faint">{catalogLine(catalog.source, providerName)}</p>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
          {typedShown.length > 0 ? (
            <Group label="Added by id" count={typedShown.length}>
              {typedShown.map((id) => (
                <CatalogRow key={id} id={id} checked frozen={adding} onToggle={() => setTyped((prev) => prev.filter((item) => item !== id))} />
              ))}
            </Group>
          ) : null}
          {groups.map((group) => (
            <Group key={group.label || "all"} label={group.label} count={group.items.length}>
              {group.items.map((item) => (
                <CatalogRow
                  key={item.id}
                  id={item.id}
                  added={existingIds.has(item.id)}
                  checked={existingIds.has(item.id) || chosenInList(item.id)}
                  frozen={adding}
                  onToggle={() => toggle(item.id)}
                />
              ))}
            </Group>
          ))}
          {groups.length === 0 || (groups.length === 1 && groups[0]!.items.length === 0) ? (
            typedShown.length === 0 ? <p className="px-1.5 py-2 text-xs text-chrome">No models match.</p> : null
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-border-soft pt-3">
          <input
            data-custom-model
            value={byId}
            disabled={adding}
            aria-label="Model id"
            placeholder="Not listed? Add by id"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-xs outline-none placeholder:font-sans placeholder:text-chrome focus:border-ring focus:ring-[3px] focus:ring-ring/20"
            onChange={(event) => setById(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addById();
              }
            }}
          />
          <Button variant="outline" size="xs" disabled={!canAddById || adding} onClick={addById}>Add</Button>
        </div>
        {/* Add, below it, is the way to try again. */}
        {error ? <InlineError detail={error.detail} className="shrink-0">{error.message}</InlineError> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={adding} onClick={onCancel}>Cancel</Button>
          <Button size="sm" disabled={count === 0 || adding || locked} onClick={() => void finish()}>
            {adding ? "Adding…" : count === 0 ? "Add models" : `Add ${count} ${count === 1 ? "model" : "models"}`}
          </Button>
        </DialogFooter>
    </>
  );
}

function Group({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      {label ? (
        <div data-catalog-group className="flex items-center gap-1.5 px-1.5 pb-1 pt-2.5 text-2xs font-semibold text-muted-foreground">
          {label}
          <span className="num font-normal text-faint">{count}</span>
        </div>
      ) : null}
      {children}
    </div>
  );
}

function CatalogRow({ id, checked, added, frozen, onToggle }: {
  id: string;
  checked: boolean;
  added?: boolean;
  /** Add's save is on its way. */
  frozen: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      data-catalog-item={id}
      // A 44px row on a touch screen.
      className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded px-1.5 py-1 transition-colors hover:bg-sel has-[:disabled]:cursor-default has-[:disabled]:hover:bg-transparent pointer-coarse:min-h-11"
    >
      <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={checked} disabled={added || frozen} onChange={onToggle} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{id}</span>
      {added ? <span className="shrink-0 text-2xs text-faint">added</span> : null}
    </label>
  );
}

/** An id the provider doesn't list: image input and reasoning on. */
function modelFromId(modelId: string): ModelForm {
  return { id: randomId(), modelId, input: [...DEFAULT_MODEL_INPUTS], supportsReasoning: true, protocol: "responses", kind: "chat" };
}

/** A listed model as a row: on unless its list declares otherwise. */
function modelFromCatalog(item: ProviderModelCatalogItem): ModelForm {
  return {
    id: randomId(),
    modelId: item.id,
    input: item.input.includes("image") ? [...DEFAULT_MODEL_INPUTS] : ["text"],
    supportsReasoning: item.supportsReasoning !== false,
    protocol: "responses",
    kind: "chat"
  };
}

/** Where the list came from. Codex's own list is not a listing, and a list
 *  still on its way, or one a new provider cannot ask for yet, is not a
 *  provider that listed nothing. */
function catalogLine(source: string, providerName: string): string {
  switch (source) {
    case "live": return `Listed by ${providerName}.`;
    case "builtin": return "The models Codex offers.";
    case "loading": return `Asking ${providerName} for its models…`;
    case "unsaved": return "Save this provider to see the models it lists — or add one by id.";
    default: return `${providerName} didn't list its models — add one by id.`;
  }
}
