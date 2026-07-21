import { Suspense, lazy, useId, useLayoutEffect, useRef, useState } from "react";
import type { WorkItemDto } from "@shared/api/work-items";

const WorkItemSummaryMarkdown = lazy(() => import("./WorkItemSummaryMarkdown"));
import { cn } from "@/lib/utils";
import { dedupeSummaryAgainstPhaseDetail } from "@/lib/work-item-summary";

interface WorkItemDetailBodyProps {
  item: WorkItemDto;
  /** When true (default false), renders the standalone view used inside the
   *  WorkItemDetailSheet — includes the needsUser + phase badges header.
   *  When false, assumes the parent page (e.g. WindowPage) already shows
   *  these in its own header, so this body only renders Summary. */
  showHeader?: boolean;
  /** When true (default false), skips the internal "Summary" SectionHeader —
   *  for parents (e.g. FeatureWorkItemDashboard) that render their own
   *  Summary label. Body content is unchanged. */
  hideSummaryHeading?: boolean;
  /** When true (default false), the summary is clamped to three lines with a
   *  toggle. For the feature pane, where the summary is the page's lede and a
   *  long one would push the canvas below the fold. */
  collapsible?: boolean;
}

const NEEDS_USER_COLOR: Record<string, string> = {
  input: "border border-status-input/25 bg-status-input/12 text-status-input",
  review: "border border-status-review/25 bg-status-review/10 text-status-review"
};

const NEEDS_USER_LABEL: Record<string, string> = {
  input: "input",
  review: "review"
};

const PHASE_COLOR: Record<WorkItemDto["phase"], string> = {
  design: "border border-phase-design/25 bg-phase-design/12 text-phase-design",
  working: "border border-phase-working/25 bg-phase-working/12 text-phase-working",
  verifying: "border border-phase-verifying/25 bg-phase-verifying/12 text-phase-verifying",
  done: "border border-phase-done/25 bg-phase-done/12 text-phase-done"
};

const SUMMARY_PROSE =
  "prose prose-sm dark:prose-invert max-w-none leading-relaxed [overflow-wrap:anywhere]";

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="label-micro text-chrome m-0">
      {children}
    </h3>
  );
}

/** The summary body, optionally clamped to three lines.
 *
 *  The toggle appears only when the text is actually clipped, so a one-line
 *  summary is not followed by a control that would do nothing. That has to be
 *  measured — whether three lines is enough depends on the pane's width, which
 *  is why the reading is repeated through a ResizeObserver rather than taken
 *  once at mount. */
function SummaryBody({ text, collapsible }: { text: string; collapsible: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyId = useId();

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !collapsible) return;
    // Only measurable while clamped: expanded, scrollHeight equals clientHeight
    // by definition, so the last collapsed reading stands.
    const measure = () => {
      if (expanded) return;
      setClipped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded, collapsible]);

  const body = (
    <div
      id={bodyId}
      ref={bodyRef}
      // line-clamp caps the height without reserving it, so a short summary
      // still takes exactly the room it needs and nothing shifts when a long
      // one collapses back.
      className={cn(SUMMARY_PROSE, collapsible && !expanded && "line-clamp-3")}
    >
      {/* Raw text as the fallback, not a spinner: markdown reads fine
          unformatted, so the summary is legible before the parser lands. */}
      <Suspense fallback={<div className="whitespace-pre-wrap">{text}</div>}>
        <WorkItemSummaryMarkdown text={text} />
      </Suspense>
    </div>
  );

  if (!collapsible) return body;

  return (
    <>
      {body}
      {(clipped || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((prev) => !prev)}
          className="self-start text-2xs font-medium text-chrome underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

export function WorkItemDetailBody({
  item,
  showHeader = false,
  hideSummaryHeading = false,
  collapsible = false
}: WorkItemDetailBodyProps) {
  // phaseDetail is already on screen — in this component's own header, or in
  // the page header above it. A summary line that repeats it verbatim is the
  // same sentence twice, so drop exactly those lines and keep the rest.
  const summary = dedupeSummaryAgainstPhaseDetail(item.summary, item.phaseDetail);

  return (
    <div className="flex flex-col gap-5 min-w-0">
      {showHeader && (
        <header className="flex items-center gap-2 flex-wrap">
          {item.needsUser !== null && (
            <span className={cn("inline-flex items-center rounded-xs px-1.5 py-0.5 text-xs font-medium", NEEDS_USER_COLOR[item.needsUser])}>
              {NEEDS_USER_LABEL[item.needsUser]}
            </span>
          )}
          <span className={cn("inline-flex items-center rounded-xs px-1.5 py-0.5 text-xs font-medium", PHASE_COLOR[item.phase])}>
            {item.phase}
          </span>
          {item.phaseDetail && (
            <span className="text-xs text-muted-foreground italic truncate max-w-[260px]" title={item.phaseDetail}>
              "{item.phaseDetail}"
            </span>
          )}
        </header>
      )}

      {summary ? (
        <section className="flex flex-col gap-2 min-w-0">
          {!hideSummaryHeading && <SectionHeader>Summary</SectionHeader>}
          <SummaryBody text={summary} collapsible={collapsible} />
        </section>
      ) : null}
    </div>
  );
}
