import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import type { MemoryDreamActionDto, MemoryDreamRunDto } from "@shared/api-contracts";
import { CopyButton } from "@/components/CopyButton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { errorText, parseActionSource, runDetailText, summarizeRunResult } from "./helpers";
import {
  actionContent,
  actionEffect,
  actionFacets,
  partitionActions
} from "./memory-run-model";
import { EffectChip, MemoryCountDelta, StatusPill } from "./shared";

export function DreamRunDialog({
  open,
  onOpenChange,
  run,
  actions
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: MemoryDreamRunDto | null;
  actions: MemoryDreamActionDto[];
}) {
  const { changed, unchanged } = useMemo(() => partitionActions(actions), [actions]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border-soft px-5 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            <span>{run ? summarizeRunResult(run) : "Dream run"}</span>
            {/* The status pill appears only when the status is worth one; a
                succeeded run is the expected case and says so by not saying
                anything. Trigger moved to the metadata line's title — it is
                "idle" on effectively every run. */}
            {run && run.status !== "succeeded" && <StatusPill status={run.status} />}
          </DialogTitle>
          {run && (
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-chrome"
              title={`${run.trigger} · ${run.model || run.provider || "unknown model"}`}
            >
              <span className="text-muted-foreground">{partitionLabel(run)}</span>
              <Dot />
              <span>{formatRelativeTime(run.startedAt)}</span>
              <Dot />
              <span>
                {actions.length} action{actions.length === 1 ? "" : "s"}
              </span>
              <MemoryCountDelta run={run} onlyWhenChanged />
            </div>
          )}
          {run && runDetailText(run) ? (
            <Expandable
              className="text-xs leading-relaxed text-muted-foreground"
              clamp="line-clamp-2"
              text={runDetailText(run)}
            />
          ) : null}
          {run?.error != null && (
            <div className="rounded-sm border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
              {errorText(run.error)}
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4">
          {actions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No actions recorded.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <section className="flex flex-col gap-2">
                <h3 className="label-micro text-chrome">
                  {changed.length === 0
                    ? "No memories changed"
                    : `Changed · ${changed.length}`}
                </h3>
                {changed.map((action) => (
                  <DreamActionCard key={action.id} action={action} />
                ))}
              </section>
              {unchanged.length > 0 && <UnchangedSection actions={unchanged} />}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Dot() {
  return <span aria-hidden>·</span>;
}

function partitionLabel(run: MemoryDreamRunDto): string {
  if (run.phase === "legacy") return "legacy";
  return run.phase === "project" ? run.projectName || run.projectId || "project" : "global";
}

/**
 * Kept memories, collapsed.
 *
 * They outnumber changes roughly ten to one, and a keep is by definition a
 * memory the run decided not to touch. Reading why nothing happened is
 * occasionally useful and never urgent, which is exactly what a disclosure is
 * for.
 */
function UnchangedSection({ actions }: { actions: MemoryDreamActionDto[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start text-chrome hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-90")}
          aria-hidden
        />
        <span className="label-micro">
          {actions.length} kept unchanged
        </span>
      </button>
      {open && (
        <div className="divide-y divide-border-soft rounded-md border border-border-soft">
          {actions.map((action) => (
            <KeptRow key={action.id} action={action} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A kept memory, compactly.
 *
 * Rendering keeps as full action cards meant expanding ten of them produced
 * five screens of scrolling — the disclosure had only deferred the wall, not
 * removed it. A keep is "this memory was reviewed and left alone", so it needs
 * to say which memory and why; the candidate scoring and the copyable full
 * text belong to actions that actually changed something.
 */
function KeptRow({ action }: { action: MemoryDreamActionDto }) {
  const { current } = actionContent(action);
  return (
    <div className="px-3 py-2">
      <p className="truncate text-xs text-foreground/80" title={current}>
        {current || "(no content recorded)"}
      </p>
      {action.reason && (
        <Expandable className="text-xs leading-relaxed text-chrome" clamp="line-clamp-2" text={action.reason} />
      )}
    </div>
  );
}

function DreamActionCard({ action }: { action: MemoryDreamActionDto }) {
  const [showPrevious, setShowPrevious] = useState(false);
  const effect = actionEffect(action);
  const { current, previous } = actionContent(action);
  const facets = actionFacets(action);
  const source = parseActionSource(action.source);

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border-soft bg-background/40 p-3"
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <EffectChip effect={effect} />
        {facets && <span className="text-chrome">{facets}</span>}
        {/* `applied` is the status of essentially every recorded action; it
            only earns a pill when something went wrong. */}
        {action.status !== "applied" && <StatusPill status={action.status} />}
        <span className="ml-auto flex items-center gap-1 font-mono text-2xs text-chrome">
          <span title={action.memoryId}>{action.memoryId.slice(0, 8)}</span>
          {/* The arrow means "into another memory", so it has to be suppressed
              when the target is the action's own memory — archives carry
              themselves as the target and rendered as "mem_fQ93 → mem_fQ93". */}
          {action.targetMemoryId && action.targetMemoryId !== action.memoryId && (
            <>
              <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
              <span title={action.targetMemoryId}>{action.targetMemoryId.slice(0, 8)}</span>
            </>
          )}
        </span>
      </div>

      {action.reason && (
        <Expandable
          className="text-sm leading-relaxed text-foreground/90"
          clamp="line-clamp-3"
          text={action.reason}
        />
      )}

      {current && <MemoryText text={current} />}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-chrome">
        {previous && (
          <button
            type="button"
            aria-expanded={showPrevious}
            className="font-medium underline underline-offset-2 hover:text-foreground"
            onClick={() => setShowPrevious((prev) => !prev)}
          >
            {showPrevious ? "Hide previous version" : "Show previous version"}
          </button>
        )}
        {action.confidence != null && <span>confidence {action.confidence.toFixed(2)}</span>}
        {source?.candidateScore != null && <span>score {source.candidateScore.toFixed(0)}</span>}
        {source && source.signals.length > 0 && <span>{source.signals.join(", ")}</span>}
      </div>

      {previous && showPrevious && <MemoryText text={previous} tone="previous" />}

      {action.error != null && (
        <div className="rounded-sm border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {errorText(action.error)}
        </div>
      )}
    </div>
  );
}

/**
 * A memory's text.
 *
 * Set in the body face, not a monospace `pre`. These are paragraphs of English
 * and Chinese prose; mono is this app's signal for machine identifiers, and
 * applying it here made every memory read like a config dump — while the
 * narrower character set pushed the paragraphs even longer.
 */
function MemoryText({ text, tone }: { text: string; tone?: "previous" }) {
  return (
    <div
      className={cn(
        "group/mem relative rounded-sm border px-2.5 py-2",
        tone === "previous"
          ? "border-dashed border-border-soft bg-transparent"
          : "border-border-soft bg-card/40"
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="label-micro text-chrome">{tone === "previous" ? "previous" : "memory"}</span>
        {/* A memory is the one thing here you would want somewhere else. */}
        <CopyButton text={text} label="Copy memory" className="-my-1 -mr-1" />
      </div>
      <Expandable
        className={cn(
          "text-xs leading-relaxed",
          tone === "previous" ? "text-chrome" : "text-foreground/90"
        )}
        clamp="line-clamp-4"
        text={text}
      />
    </div>
  );
}

/**
 * Text that clamps until asked.
 *
 * The paragraph is a paragraph. An earlier version made the whole block a
 * button so any click would expand it, which meant dragging across a memory
 * to copy it selected nothing and toggled the clamp instead — and left screen
 * readers announcing three hundred characters of prose as a button label. The
 * only control is the toggle underneath.
 *
 * The toggle appears only when the text is genuinely cut off, measured rather
 * than guessed: a one-line reason offering to "show more" is worse than no
 * affordance at all. Re-measured on resize, since the dialog is responsive and
 * a narrower viewport clamps text that fitted before.
 */
function Expandable({
  text,
  clamp,
  className
}: {
  text: string;
  clamp: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only measurable while clamped; expanded, scrollHeight equals clientHeight
    // by definition, so the last collapsed reading stands.
    const measure = () => {
      if (open) return;
      setClipped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <div>
      <p ref={ref} className={cn("whitespace-pre-wrap", className, !open && clamp)}>
        {text}
      </p>
      {(clipped || open) && (
        <button
          type="button"
          aria-expanded={open}
          className="mt-0.5 text-2xs font-medium text-chrome underline underline-offset-2 hover:text-foreground"
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
