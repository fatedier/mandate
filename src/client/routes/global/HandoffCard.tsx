import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { useGlobalAgentStore } from "@/store/global-agent";
import { markdownToText } from "@/lib/markdown-text";
import { cn } from "@/lib/utils";
import type { GlobalHandoffDto } from "@shared/api/global-agent";
import { foldOpenKey } from "@/routes/window/chat/transcript-rows";
import { useHandoffHref } from "./handoff-tools";

/** A pill only for what is unusual: that it simply
 *  went, or came back, is said by the notice line where it arrived. */
function pillFor(h: GlobalHandoffDto): { label: string; tone: string } | null {
  switch (h.state) {
    case "queued": return { label: h.kind === "feature" ? "Queued · worker busy" : "Queued · manager busy", tone: "amber" };
    case "failed": return { label: "Failed", tone: "red" };
    default: return h.kind === "thread" && h.newThreadTitle !== null ? { label: "New thread", tone: "neutral" } : null;
  }
}

/** Where a card's fold is held when it stands in a transcript: among what
 *  the reader opened there (the list's set), so the list can stop following
 *  while it is open. Absent, the card holds it itself. */
interface FoldProps {
  expandedIds?: ReadonlySet<string>;
  onExpandedChange?: (id: string, expanded: boolean) => void;
}

/** Whether each card's text was last measured longer than two lines, kept
 *  past the card itself. A turn's card is drawn three times as the turn goes
 *  on: on its call's row, under the words being written, under them once
 *  stored. Drawn again without its control and given it back by the
 *  measurement, it grew inside the very commit that had made the transcript
 *  shorter (the working line gone, the reply's words not drawn yet). The
 *  measurement had made the browser lay that shorter transcript out and pull
 *  scrollTop back, so the growth read as the reader scrolling up: the list
 *  stopped following on every turn that sent a long message and then said so.
 *  Drawn again, a card starts as it was last measured. */
const measuredFolds = new Map<string, boolean>();

/** What the agent told the thread, as plain text: two lines until opened.
 *  Whether it is longer is measured, since a line's length depends on the
 *  pane. Open, it is not measured: what was measured before stands. */
function SentText({ foldKey, text, expandedIds, onExpandedChange }: { foldKey: string; text: string } & FoldProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const open = expandedIds ? expandedIds.has(foldKey) : localOpen;
  const toggle = () => {
    if (!expandedIds) setLocalOpen(!open);
    onExpandedChange?.(foldKey, !open);
  };
  const [folds, setFolds] = useState(() => measuredFolds.get(foldKey) ?? false);
  const plain = useMemo(() => markdownToText(text), [text]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => {
      const longer = el.scrollHeight > el.clientHeight + 1;
      measuredFolds.set(foldKey, longer);
      setFolds(longer);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [foldKey, plain, open]);
  return (
    <div className="mt-1 flex flex-col gap-1 border-t border-border-soft pt-1.5">
      <p
        ref={ref}
        data-slot="handoff-sent"
        data-folded={open ? "false" : "true"}
        className={cn("whitespace-pre-wrap text-[13px] leading-[1.55] text-muted-foreground [overflow-wrap:anywhere]", !open && "line-clamp-2")}
      >
        {plain}
      </p>
      {folds && (
        <button
          type="button"
          data-slot="sent-fold"
          aria-expanded={open}
          onClick={toggle}
          className="hit relative self-start rounded-xs text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** One thing the global agent sent: where it went, a
 *  way there, and what it said. Live from the store, the tool's result until
 *  the store has it. What came back is not drawn here: the notice that woke
 *  the agent is a line of its own where it arrived. */
export function HandoffCard({ handoffId, fallback, expandedIds, onExpandedChange }: { handoffId: string; fallback: GlobalHandoffDto | null } & FoldProps) {
  const live = useGlobalAgentStore((s) => s.handoffs.get(handoffId) ?? null);
  const h = live ?? fallback;
  const href = useHandoffHref(h);
  if (!h) return null;
  const target = h.kind === "feature" ? h.featureName ?? "a worker" : h.threadTitle ?? h.newThreadTitle ?? "a new thread";
  const pill = pillFor(h);
  const opens = href !== null;

  return (
    <div data-slot="handoff-card" className="flex max-w-xl flex-col gap-1 rounded-lg border border-border-soft bg-panel px-3 py-1.5 text-sm">
      <div className="flex items-center gap-2">
        <ArrowRight className="size-3.5 shrink-0 text-status-review" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          Sent to <b className="font-semibold">{target}</b>
          {h.kind === "feature" && h.ownerThreadTitle ? <span className="text-faint"> · in {h.ownerThreadTitle}</span> : null}
        </span>
        {pill ? <span data-slot="handoff-state" className={cn("pill shrink-0", `pill-${pill.tone}`)}>{pill.label}</span> : null}
        {opens ? (
          <Link
            to={href}
            data-slot="handoff-open"
            className="hit relative inline-flex shrink-0 items-center gap-0.5 rounded-xs text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {/* In a narrow transcript the words give their room to the name of
                where it went; the arrow stays, and still says what it opens. */}
            <span className="@max-[34rem]:sr-only">{h.kind === "feature" ? "Open worker" : "Open thread"}</span>
            <ChevronRight className="size-3 @max-[34rem]:size-4" aria-hidden />
          </Link>
        ) : null}
      </div>
      {/* A target gone before anything came back has only this card to say why. */}
      {h.state === "failed" && h.reason && h.repliedAt === null ? <p data-slot="handoff-reason" className="text-xs text-muted-foreground">{h.reason}</p> : null}
      {h.text.trim() ? <SentText foldKey={foldOpenKey(h.id)} text={h.text} expandedIds={expandedIds} onExpandedChange={onExpandedChange} /> : null}
    </div>
  );
}
