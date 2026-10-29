import { useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";
import type { CauseFacts, CauseRun, ChatProvenance } from "./chatProvenance";

/** What the card's heading says: the line's icon, what it is about, and its
 *  label (none for a waiting line, whose subject is the whole title). */
type CauseHeading = Pick<ChatProvenance, "icon" | "subject" | "label">;

// The line is the control: on a touch screen 44px tall; with a mouse it
// darkens and its label is underlined (the line's label carries
// group-hover/cause), as a thread's name on a notice is. Hover variants hold
// only where a pointer hovers, so a tap leaves no underline behind.
/** The card is drawn elsewhere on the page, but React still passes its
 *  events up the transcript's tree: a wheel or a touch in it is the card's,
 *  never the transcript's word that the reader scrolled away. */
const OWN_GESTURES = {
  onWheel: (event: SyntheticEvent) => event.stopPropagation(),
  onTouchStart: (event: SyntheticEvent) => event.stopPropagation(),
  onTouchMove: (event: SyntheticEvent) => event.stopPropagation()
};

const TRIGGER_CLASS = "group/cause flex min-w-0 flex-1 items-center gap-2 rounded-xs text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-11";

/**
 * A cause line that opens what is behind it (ChatProvenance.facts): a box at
 * the line, on a phone the sheet, as a thread's reply opens from a notice's
 * name (ThreadReplyPeek). `children` is the line's own content.
 */
export function CauseDetails({ provenance, facts, children, triggerClassName }: {
  provenance: CauseHeading;
  facts: CauseFacts;
  children: ReactNode;
  /** The line's own layout, where it is not one line of text (a waiting line). */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const phone = useIsMobile();
  // The sheet's own trigger is not the line: focus is handed back to it.
  const lineRef = useRef<HTMLButtonElement>(null);
  const heading = <Heading provenance={provenance} facts={facts} />;
  const body = <Body facts={facts} />;

  if (phone) {
    return (
      <>
        <button ref={lineRef} type="button" data-slot="cause-details-trigger" aria-haspopup="dialog" className={cn(TRIGGER_CLASS, triggerClassName)} onClick={() => setOpen(true)}>{children}</button>
        <BottomSheet
          open={open}
          onOpenChange={setOpen}
          returnFocus={() => lineRef.current}
          slot="cause-details"
          header={(
            <div {...OWN_GESTURES} className="flex items-center gap-3 border-b border-border-soft px-4 pt-1 pb-3">
              <BottomSheetTitle className="sr-only">{titleText(provenance)}</BottomSheetTitle>
              {heading}
            </div>
          )}
          bodyClassName="px-4 pt-3 pb-6"
        >
          <div {...OWN_GESTURES}>{body}</div>
        </BottomSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-slot="cause-details-trigger" className={cn(TRIGGER_CLASS, triggerClassName)}>{children}</button>
      </PopoverTrigger>
      {/* As tall as the window leaves it on the side it opens to, so it flips
          upward from a line low on the page and never leaves the window. */}
      <PopoverContent
        {...OWN_GESTURES}
        data-slot="cause-details"
        aria-label={titleText(provenance)}
        align="start"
        collisionPadding={12}
        className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-[28rem] max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div className="flex items-center gap-3 border-b border-border-soft px-3.5 py-2.5">{heading}</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">{body}</div>
      </PopoverContent>
    </Popover>
  );
}

function titleText(provenance: CauseHeading): string {
  return [provenance.subject?.text, provenance.label].filter(Boolean).join(" · ");
}

function Heading({ provenance, facts }: { provenance: CauseHeading; facts: CauseFacts }) {
  const Icon = provenance.icon;
  const subject = provenance.subject;
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span data-slot="cause-details-title" className="truncate text-sm font-semibold text-foreground">
          {subject && <>{subject.code ? <code className="font-mono font-medium">{subject.text}</code> : subject.text}{provenance.label && " · "}</>}
          {provenance.label}
        </span>
        {facts.meta.length > 0 && <span data-slot="cause-details-meta" className="text-2xs text-faint">{facts.meta.join(" · ")}</span>}
      </div>
    </div>
  );
}

/** Focusable, so a keyboard reaches what a half-raised sheet hides (focus
 *  in its body raises it) and can scroll a long note in the box. */
function Body({ facts }: { facts: CauseFacts }) {
  return (
    <div data-slot="cause-details-body" tabIndex={0} className="flex flex-col gap-3 rounded-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
      {facts.note && <p data-slot="cause-details-note" className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{facts.note}</p>}
      {facts.runs && <Runs rows={facts.runs.rows} earlier={facts.runs.earlier} />}
      {facts.blocks.map((block) => (
        <div key={block.label} data-slot="cause-details-block" className="flex flex-col gap-1">
          <span data-slot="cause-details-block-label" className="label-micro text-faint">{block.label}</span>
          {/* As it came: output never wraps; it scrolls in its box. */}
          <pre tabIndex={0} className="max-h-48 overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-xs leading-relaxed text-muted-foreground">{block.text}</pre>
        </div>
      ))}
    </div>
  );
}

const TONE: Record<CauseRun["tone"], string> = {
  ok: "bg-green/15 text-green",
  same: "bg-sel text-chrome",
  fail: "bg-red/15 text-red"
};

/** A command monitor's recent runs, newest first: when, how it ended, its
 *  output's last line (cut to the row; whole on hover). */
function Runs({ rows, earlier }: { rows: CauseRun[]; earlier: number }) {
  return (
    <div data-slot="cause-details-runs" className="flex flex-col gap-1">
      <span className="label-micro text-faint">Recent runs</span>
      <div className="overflow-hidden rounded-md border border-border-soft">
        {rows.map((run, index) => (
          <div
            key={`${run.at}-${index}`}
            data-slot="cause-details-run"
            className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-2 border-t border-border-soft px-2.5 py-1.5 text-xs tabular-nums first:border-t-0"
          >
            <span className="text-faint">{run.at}</span>
            <span className={cn("rounded-xs px-1.5 text-2xs font-medium whitespace-nowrap", TONE[run.tone])}>{run.outcome}</span>
            <span className="truncate font-mono text-2xs text-muted-foreground" title={run.line}>{run.line}</span>
          </div>
        ))}
        {earlier > 0 && (
          <div data-slot="cause-details-runs-earlier" className="border-t border-border-soft px-2.5 py-1 text-2xs text-faint">
            {earlier} earlier {earlier === 1 ? "run" : "runs"}
          </div>
        )}
      </div>
    </div>
  );
}
