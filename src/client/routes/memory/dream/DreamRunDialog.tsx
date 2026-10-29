import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Fold } from "@/components/Fold";
import { ArrowRight } from "lucide-react";
import type { MemoryDreamActionDto, MemoryDreamRunDto } from "@shared/api-contracts";
import { CopyButton } from "@/components/CopyButton";
import { MarkdownView } from "@/components/MarkdownView";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { errorMessageText } from "@shared/error-reason";
import { parseActionSource, runDetailText, splitParts, summarizeRunResult } from "./helpers";
import {
  actionContent,
  actionEffect,
  actionFacets,
  orderActions
} from "./memory-run-model";
import { EffectChip, MemoryCountDelta, StatusPill } from "./shared";

export function DreamRunDialog({
  open,
  onOpenChange,
  run,
  actions,
  brief = null,
  resolveProject
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: MemoryDreamRunDto | null;
  actions: MemoryDreamActionDto[];
  /** The brief the run wrote, and the one before it. */
  brief?: { content: string; previous: string | null } | null;
  /** Project names, for the place each action's memory lives. */
  resolveProject?: (projectId: string) => string | undefined;
}) {
  const changed = useMemo(() => orderActions(actions), [actions]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border-soft px-5 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            <span>{run ? summarizeRunResult(run) : "Dream run"}</span>
            {/* The status pill appears only when the status is worth one; a
                succeeded run is the expected case and says so by not saying
                anything. Trigger moved to the metadata line's title — it is
                "idle", "overdue" when a change waited too long for the user
                to go quiet, or "manual" when someone started the run. */}
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
              {errorMessageText(run.error)}
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {actions.length === 0 && !brief ? (
            <p className="text-sm text-muted-foreground">No actions recorded.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <section className="flex flex-col gap-2">
                <h3 className="label-group">
                  {changed.length === 0 && !brief
                    ? "No memories changed"
                    : `Changed · ${changed.length + (brief ? 1 : 0)}`}
                </h3>
                {changed.map((action) => (
                  <DreamActionCard key={action.id} action={action} resolveProject={resolveProject} />
                ))}
                {brief && <BriefCard brief={brief} />}
              </section>
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
  return run.phase === "project" ? run.projectName || run.projectId || "project" : "You";
}

/** The brief the run wrote, as agents read it, and the one it replaced. */
function BriefCard({ brief }: { brief: { content: string; previous: string | null } }) {
  const [showPrevious, setShowPrevious] = useState(false);
  return (
    <div data-slot="run-brief" className="flex flex-col gap-2 rounded-md border border-border-soft bg-background/40 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <EffectChip effect="brief" />
        <span className="text-chrome">{brief.previous === null ? "the first one" : "rewritten"}</span>
      </div>
      <div className="rounded-sm border border-border-soft bg-panel px-2.5 py-2 text-xs">
        <MarkdownView text={brief.content} small />
      </div>
      {brief.previous !== null && (
        <>
          <button
            type="button"
            aria-expanded={showPrevious}
            className="self-start text-2xs font-medium text-chrome underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
            onClick={() => setShowPrevious((prev) => !prev)}
          >
            {showPrevious ? "Hide previous version" : "Show previous version"}
          </button>
          <Fold open={showPrevious} className="rounded-sm border border-dashed border-border px-2.5 py-2 text-xs text-chrome">
            <MarkdownView text={brief.previous} small />
          </Fold>
        </>
      )}
    </div>
  );
}

function DreamActionCard({
  action,
  resolveProject
}: {
  action: MemoryDreamActionDto;
  resolveProject?: (projectId: string) => string | undefined;
}) {
  const [showPrevious, setShowPrevious] = useState(false);
  const effect = actionEffect(action);
  const { current, previous } = actionContent(action);
  const facets = actionFacets(action, resolveProject);
  // What the box holds: a merged or split memory's own text is not what
  // remains, so its label says what happened to it.
  const label = effect === "merge" && action.targetMemoryId
    ? `merged into ${action.targetMemoryId.slice(0, 8)}`
    : effect === "archive" ? "archived"
      : effect === "split" ? "split up" : "memory";
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
          {/* The arrow means "into another memory": a merge's. Other actions
              recorded a target too in earlier versions (archives themselves,
              "mem_fQ93 → mem_fQ93"; an update whatever the model put there). */}
          {effect === "merge" && action.targetMemoryId && action.targetMemoryId !== action.memoryId && (
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

      {current && <MemoryText text={current} label={label} />}
      {/* What it became: the parts are new memories, left out of Activity's
          Learned feed, so this is where they show. */}
      {effect === "split" && splitParts(action).map((part, index) => (
        <MemoryText key={index} text={part.text} label={`part ${index + 1}${part.id ? ` · ${part.id.slice(0, 8)}` : ""}`} />
      ))}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-chrome">
        {previous && (
          <button
            type="button"
            aria-expanded={showPrevious}
            className="font-medium underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
            onClick={() => setShowPrevious((prev) => !prev)}
          >
            {showPrevious ? "Hide previous version" : "Show previous version"}
          </button>
        )}
        {source?.candidateScore != null && <span>score {source.candidateScore.toFixed(0)}</span>}
        {source && source.signals.length > 0 && <span>{source.signals.join(", ")}</span>}
      </div>

      {previous && <Fold open={showPrevious}><MemoryText text={previous} tone="previous" /></Fold>}

      {action.error != null && (
        <div className="rounded-sm border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {errorMessageText(action.error)}
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
function MemoryText({ text, tone, label = "memory" }: { text: string; tone?: "previous"; label?: string }) {
  return (
    <div
      className={cn(
        "group/mem relative rounded-sm border px-2.5 py-2",
        tone === "previous"
          ? "border-dashed border-border-soft bg-transparent"
          : "border-border-soft bg-panel"
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="label-micro text-chrome">{tone === "previous" ? "previous" : label}</span>
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
      <p ref={ref} data-slot="expandable-text" className={cn("whitespace-pre-wrap break-words", className, !open && clamp)}>
        {text}
      </p>
      {(clipped || open) && (
        <button
          type="button"
          aria-expanded={open}
          className="mt-0.5 text-2xs font-medium text-chrome underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
