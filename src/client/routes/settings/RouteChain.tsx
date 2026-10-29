import { Fragment, useMemo, useRef, useState, type DragEvent, type Ref } from "react";
import { ArrowDown, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { modelVendor } from "./provider-display";
import { ProviderMark } from "./ProviderMark";
import { isDecisionModelRef, modelMenuGroups, moveStep, type ModelMenuGroup, type RouteStep } from "./routing-form";
import { REASONING_EFFORT_OPTIONS, type ProviderType, type ReasoningEffort, type SettingsConfigResponse } from "./types";

/** From this many fallbacks on, the chain says what a long one costs. */
const LONG_CHAIN_FALLBACKS = 4;

/** The editor's anchor before its card has mounted. */
const EMPTY_RECT = { getBoundingClientRect: () => new DOMRect() };

/**
 * A route drawn as the chain it is tried in: a card per step, left to right
 * (top to bottom when narrow), joined by "fails" arrows, then "+". A card
 * opens its editor; cards drag onto each other's place to reorder; a card's
 * × (on pointer or focus, always on a touch screen) removes its step, asking
 * first, as the editor's Remove does. Every change goes to `onChange`: the
 * route decides whether it is saved at once. A decision model's step has no
 * effort: it does not reason as a chat model does.
 */
export function RouteChain({
  steps,
  config,
  routeLabel,
  decisions = false,
  onChange,
  searchAnchors
}: {
  steps: RouteStep[];
  config: SettingsConfigResponse;
  /** The route as a removal names it: "the default route", "Your agent's route". */
  routeLabel: string;
  /** A route that makes decisions: its menus list decision models too. */
  decisions?: boolean;
  onChange: (steps: RouteStep[]) => void;
  /** Where settings search lands: the first choice's card, its effort, the chain. */
  searchAnchors?: { model: string; effort: string; fallbacks: string };
}) {
  // The step being edited, by its model: a route never holds a model twice,
  // so the editor stays with its step wherever it moves, and closes when a
  // save's answer replaces the chain without it.
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  // The step whose removal is being asked, by its model, as the editor's.
  const [confirmingModel, setConfirmingModel] = useState<string | null>(null);
  // Where focus goes back when the dialog closes. Kept: to the control that
  // asked (the ×), else to the step's card (the editor's Remove is gone with
  // the editor). Removed: to the card now in its place, or the last one.
  // A card is found by its place: a × at that place may be another step's.
  const chainRef = useRef<HTMLDivElement>(null);
  const askedFrom = useRef<{ control: HTMLElement | null; index: number; removed: boolean } | null>(null);
  // `control`: the × pressed (a press need not focus it, as in Safari), or
  // none for the editor's Remove, which closes with the editor.
  const askRemoval = (model: string, index: number, control: HTMLElement | null) => {
    askedFrom.current = { control, index, removed: false };
    setConfirmingModel(model);
  };
  const giveFocusBack = () => {
    const from = askedFrom.current;
    askedFrom.current = null;
    if (!from) return;
    if (!from.removed && from.control?.isConnected) {
      from.control.focus();
      return;
    }
    const cards = Array.from(chainRef.current?.querySelectorAll<HTMLElement>("[data-step]") ?? []);
    cards[Math.min(from.index, cards.length - 1)]?.focus();
  };
  // One editor for the chain, anchored to the card it edits: moving a step
  // moves the anchor and keeps the editor open, focus and all.
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const anchorRef = useMemo(() => ({ current: anchor ?? EMPTY_RECT }), [anchor]);
  const interactedOutside = useRef(false);
  const used = new Set(steps.map((step) => step.model));
  const groups = modelMenuGroups(config, used, undefined, { decisions });
  const canAdd = groups.some((group) => group.models.some((model) => !model.used));
  const found = editingModel === null ? -1 : steps.findIndex((step) => step.model === editingModel);
  if (editingModel !== null && found < 0) setEditingModel(null);
  const editing = found < 0 ? null : found;
  const editingStep = editing === null ? undefined : steps[editing];
  const confirming = confirmingModel === null ? -1 : steps.findIndex((step) => step.model === confirmingModel);
  if (confirmingModel !== null && confirming < 0) setConfirmingModel(null);

  const update = (index: number, next: RouteStep) => {
    onChange(steps.map((step, i) => (i === index ? next : step)));
    setEditingModel(next.model);
  };
  const move = (from: number, to: number) => onChange(moveStep(steps, from, to));
  // Its editor closes with it: the model is no longer on the route.
  const remove = (index: number) => onChange(steps.filter((_, i) => i !== index));

  return (
    <div className="flex flex-col gap-2">
      <Popover open={editingStep !== undefined} onOpenChange={(open) => { if (!open) setEditingModel(null); }}>
        <PopoverAnchor virtualRef={anchorRef} />
        {editing !== null && editingStep ? (
          <PopoverContent
            className="w-80 p-3.5"
            align="start"
            onInteractOutside={(event) => {
              // A press on the card being edited is its toggle, not a dismissal.
              if (anchor?.contains(event.target as Node)) event.preventDefault();
              else interactedOutside.current = true;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!interactedOutside.current) anchor?.focus();
              interactedOutside.current = false;
            }}
          >
            <StepEditor
              step={editingStep}
              index={editing}
              count={steps.length}
              groups={modelMenuGroups(config, used, editingStep.model, { decisions })}
              decision={isDecisionModelRef(config, editingStep.model)}
              onChange={(next) => update(editing, next)}
              onMove={(to) => move(editing, to)}
              onRemove={() => askRemoval(editingStep.model, editing, null)}
              onDone={() => setEditingModel(null)}
            />
          </PopoverContent>
        ) : null}
      </Popover>
      <div
        ref={chainRef}
        id={searchAnchors ? `setting-${searchAnchors.fallbacks}` : undefined}
        className="flex flex-wrap items-stretch gap-1.5 rounded-lg @max-[34rem]:flex-col @max-[34rem]:flex-nowrap"
      >
        {steps.map((step, index) => (
          <Fragment key={index}>
            {index > 0 ? <StepArrow /> : null}
            <StepCard
              ref={editing === index ? setAnchor : null}
              step={step}
              index={index}
              config={config}
              open={editing === index}
              dragging={dragFrom === index}
              anchors={index === 0 ? searchAnchors : undefined}
              removable={steps.length > 1}
              onRemove={(control) => askRemoval(step.model, index, control)}
              onClick={() => setEditingModel((prev) => (prev === step.model ? null : step.model))}
              onDragStart={(event) => {
                setDragFrom(index);
                event.dataTransfer?.setData("text/plain", String(index));
              }}
              onDragOver={(event) => {
                if (dragFrom !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragFrom !== null) move(dragFrom, index);
                setDragFrom(null);
              }}
              onDragEnd={() => setDragFrom(null)}
            />
          </Fragment>
        ))}
        <AddStep groups={groups} disabled={!canAdd} onPick={(model) => onChange([...steps, { model, reasoningEffort: "provider-default" }])} />
      </div>
      <Dialog open={confirming >= 0} onOpenChange={(open) => { if (!open) setConfirmingModel(null); }}>
        <DialogContent
          className="sm:max-w-md"
          // Opened from a card, not a trigger: Radix has nothing to return to.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            giveFocusBack();
          }}
        >
          <DialogHeader>
            <DialogTitle>Remove step</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Remove <span className="font-mono text-foreground">{steps[confirming]?.model}</span> from {routeLabel}?
            {confirming === 0 ? " The next step becomes the first choice." : ""}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmingModel(null)}>Cancel</Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirming >= 0) remove(confirming);
                if (askedFrom.current) askedFrom.current.removed = true;
                setConfirmingModel(null);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {steps.length - 1 >= LONG_CHAIN_FALLBACKS ? (
        <p data-slot="route-long" className="text-xs text-chrome">
          Each step is tried in turn, so a long chain waits longer before a call gives up.
        </p>
      ) : null}
      {/* Disabled says nothing on its own: every model set up is already
          on this route, so the way to another step is another model. */}
      {!canAdd ? (
        <span data-slot="fallback-hint" className="block text-xs text-chrome">
          No other model to fall back to. Add one in{" "}
          <Link to="/settings?tab=providers" className="underline underline-offset-2 hover:text-foreground">Providers</Link>.
        </span>
      ) : null}
    </div>
  );
}

/** A route that follows the default: the chain it follows, in a line. */
export function FollowsDefault({ steps }: { steps: RouteStep[] }) {
  const named = steps.filter((step) => step.model);
  return (
    <p data-slot="route-follows" className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span>{named.length > 0 ? "Follows the default:" : "Follows the default."}</span>
      {named.map((step, index) => (
        <Fragment key={index}>
          {index > 0 ? <ArrowRight className="size-3 text-faint" aria-hidden /> : null}
          <span title={step.model} className="rounded-sm bg-sel px-1.5 py-0.5 font-mono text-2xs text-foreground">
            {shortName(step.model)}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

function StepCard({
  ref,
  step,
  index,
  config,
  open,
  dragging,
  anchors,
  removable,
  onRemove,
  ...props
}: {
  ref: Ref<HTMLButtonElement>;
  step: RouteStep;
  index: number;
  config: SettingsConfigResponse;
  open: boolean;
  dragging: boolean;
  anchors?: { model: string; effort: string };
  /** The route has another step: this one can go. */
  removable: boolean;
  /** With the × that was pressed. */
  onRemove: (control: HTMLElement) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onClick: () => void;
}) {
  const { provider, modelId, providerType } = splitRef(config, step.model);
  const role = index === 0 ? "First choice" : "Then";
  // A decision model has no effort: its card says what it is instead.
  const decision = isDecisionModelRef(config, step.model);
  const effort = decision ? "decision model" : effortText(step.reasoningEffort);
  // A fresh install's route has no model yet: the card asks for one.
  const named = Boolean(step.model);
  return (
    // The card is its frame: the step's button and, beside it (never over
    // it, so their touch areas stay apart), its ×.
    <div
      data-slot="step-card"
      data-state={open ? "open" : "closed"}
      className={cn(
        "group/step flex min-w-36 max-w-60 flex-1 basis-0 items-start rounded-lg border border-border-soft bg-background transition-[border-color,box-shadow] hover:border-border has-[[data-step]:focus-visible]:ring-[3px] has-[[data-step]:focus-visible]:ring-ring/30 data-[state=open]:border-status-review/80 data-[state=open]:ring-[3px] data-[state=open]:ring-status-review/20 @max-[34rem]:min-w-0 @max-[34rem]:max-w-none @max-[34rem]:basis-auto",
        index === 0 && "border-border",
        dragging && "opacity-50"
      )}
    >
    <button
      ref={ref}
      id={anchors ? `setting-${anchors.model}` : undefined}
      type="button"
      data-step={index}
      data-state={open ? "open" : "closed"}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={step.model}
      aria-label={`${role}: ${step.model || "no model"}, ${effort}`}
      draggable
      className="flex min-w-0 flex-1 flex-col items-stretch gap-1 self-stretch rounded-lg px-2.5 py-2 text-left outline-none"
      {...props}
    >
      <span className="text-2xs text-faint">{role}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        {named ? <ProviderMark letter={modelVendor(modelId, providerType).letter} size="sm" /> : null}
        {named ? (
          <span className="min-w-0 truncate font-mono text-xs text-foreground">{shortName(step.model)}</span>
        ) : (
          <span className="min-w-0 truncate text-xs text-chrome">Choose a model</span>
        )}
      </span>
      <span id={anchors ? `setting-${anchors.effort}` : undefined} className="truncate rounded-sm text-2xs text-muted-foreground">
        {named ? `${provider} · ${decision ? "Decision model" : effort}` : effort}
      </span>
    </button>
    {removable ? (
      <button
        type="button"
        aria-label={`Remove ${step.model || "this step"}`}
        title="Remove"
        onClick={(event) => onRemove(event.currentTarget)}
        className="m-1 flex size-5 shrink-0 items-center justify-center rounded text-chrome opacity-0 outline-none transition-opacity hover:bg-sel hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/30 group-hover/step:opacity-100 group-focus-within/step:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    ) : null}
    </div>
  );
}

function StepArrow() {
  return (
    <span data-slot="step-arrow" aria-hidden className="flex shrink-0 items-center self-center text-faint">
      <span className="flex flex-col items-center gap-px text-[10px] @max-[34rem]:hidden">
        <ArrowRight className="size-3" />
        fails
      </span>
      <span className="hidden items-center gap-1 py-0.5 pl-4 text-[10px] @max-[34rem]:flex">
        <ArrowDown className="size-3" />
        if it fails
      </span>
    </span>
  );
}

function AddStep({ groups, disabled, onPick }: { groups: ModelMenuGroup[]; disabled: boolean; onPick: (model: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add a step"
          title="Add a step"
          disabled={disabled}
          className="flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-chrome outline-none transition-colors hover:bg-sel hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-40 @min-[34rem]:w-9 @min-[34rem]:pointer-coarse:w-11"
        >
          <Plus className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <ModelMenu groups={groups} onPick={onPick} />
    </DropdownMenu>
  );
}

/** The models set up in Providers, under their provider; one already on the
 *  route is shown but can't be picked. */
function ModelMenu({ groups, current, onPick }: { groups: ModelMenuGroup[]; current?: string; onPick: (model: string) => void }) {
  return (
    <DropdownMenuContent align="start" className="max-w-80">
      {groups.map((group) => (
        <DropdownMenuGroup key={group.provider}>
          <DropdownMenuLabel data-slot="model-menu-group">{group.provider}</DropdownMenuLabel>
          {group.models.map((model) => (
            <DropdownMenuItem key={model.ref} data-ref={model.ref} disabled={model.used} onSelect={() => onPick(model.ref)}>
              <ProviderMark letter={modelVendor(model.modelId, group.providerType).letter} size="sm" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{model.modelId}</span>
              {model.used ? <span className="text-2xs text-faint">in this route</span> : null}
              {model.ref === current ? <Check className="size-3.5" aria-hidden /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      ))}
    </DropdownMenuContent>
  );
}

function StepEditor({
  step,
  index,
  count,
  groups,
  decision,
  onChange,
  onMove,
  onRemove,
  onDone
}: {
  step: RouteStep;
  index: number;
  count: number;
  groups: ModelMenuGroup[];
  /** The step's model is a decision model: it has no effort. */
  decision: boolean;
  onChange: (next: RouteStep) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const providerType = groups.find((group) => step.model.startsWith(`${group.provider}/`))?.providerType ?? "openai-compatible";
  const modelId = step.model.slice(step.model.indexOf("/") + 1);
  return (
    <div data-slot="step-editor" className="flex flex-col gap-3">
      <span className="text-sm font-semibold">{index === 0 ? "First choice" : `Fallback ${index}`}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Model"
            className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-left outline-none pointer-coarse:h-11 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
          >
            {step.model ? <ProviderMark letter={modelVendor(modelId, providerType).letter} size="sm" /> : null}
            {step.model ? (
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{step.model}</span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs text-chrome">Choose a model</span>
            )}
            <ChevronDown className="size-3.5 text-chrome" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <ModelMenu groups={groups} current={step.model} onPick={(model) => onChange({ ...step, model })} />
      </DropdownMenu>
      {decision ? null : (
      <div className="flex flex-col gap-1.5">
        <span className="text-2xs text-faint">Reasoning effort</span>
        <ToggleGroup
          type="single"
          spacing={1}
          aria-label="Reasoning effort"
          className="grid w-full grid-cols-4"
          value={step.reasoningEffort}
          onValueChange={(value) => { if (value) onChange({ ...step, reasoningEffort: value as ReasoningEffort }); }}
        >
          {REASONING_EFFORT_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="h-7 min-w-0 rounded-sm border border-border-soft px-1 text-2xs pointer-coarse:h-11 data-[state=on]:border-status-review/70 data-[state=on]:bg-status-review/10"
            >
              {option.value === "provider-default" ? "Default" : option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pointer-coarse:gap-y-4">
        <Button variant="outline" size="xs" disabled={index === 0} onClick={() => onMove(index - 1)}>
          <ChevronLeft className="size-3.5" />
          Earlier
        </Button>
        <Button variant="outline" size="xs" disabled={index === count - 1} onClick={() => onMove(index + 1)}>
          <ChevronRight className="size-3.5" />
          Later
        </Button>
        <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" disabled={count === 1} onClick={onRemove}>
          Remove
        </Button>
        <span className="flex-1" />
        <Button size="xs" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/** The model's own name, after its last "/": "x-ai/grok-4.7" reads "grok-4.7". */
function shortName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1) || ref;
}

function splitRef(config: SettingsConfigResponse, ref: string): { provider: string; modelId: string; providerType: ProviderType } {
  const slash = ref.indexOf("/");
  const provider = slash > 0 ? ref.slice(0, slash) : "";
  return {
    provider,
    modelId: ref.slice(slash + 1),
    providerType: config.models.providers[provider]?.type ?? "openai-compatible"
  };
}

function effortText(effort: ReasoningEffort): string {
  if (effort === "provider-default") return "default effort";
  return REASONING_EFFORT_OPTIONS.find((option) => option.value === effort)?.label ?? effort;
}
