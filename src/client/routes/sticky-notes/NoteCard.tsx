import { useEffect, useRef, useState } from "react";
import { Check, MessageSquareText, Sparkles, SquareCheckBig } from "lucide-react";
import { MarkdownView } from "@/components/MarkdownView";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useTaskBoardStore } from "@/store/task-board";
import type { StickyNoteDto } from "@shared/api/sticky-notes";
import { NOTE_KIND } from "./note-kinds";
import { noteWhen } from "./note-time";
import { cn } from "@/lib/utils";

const ACTION = "inline-flex size-6 items-center justify-center rounded-full text-[var(--note-ink-faint)] transition-colors hover:bg-[var(--note-hover)] hover:text-[var(--note-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-8";

/** One sticky note: paper of its kind, its title, a few lines (More opens a
 *  longer body, Less closes it), what it is about and when, and Done. */
export function NoteCard({ note, isNew, agentName, now, onDone }: {
  note: StickyNoteDto;
  /** The clock its time words are read against (useNow): they change at midnight. */
  now: number;
  /** New to the user in this view: a strip of tape over the top edge. */
  isNew: boolean;
  agentName: string;
  onDone: () => void;
}) {
  const { word, Icon } = NOTE_KIND[note.kind];
  // What it is about, called as it is now (renamed since); the note's own copy once it is gone.
  const threadTitle = useManagerThreadsStore((s) => (note.about?.kind === "thread" ? s.threads.get(note.about.id)?.title ?? null : null));
  const taskTitle = useTaskBoardStore((s) => (note.about?.kind === "task" ? s.tasks?.get(note.about.id)?.title ?? null : null));
  const source = threadTitle ?? taskTitle ?? note.about?.title ?? agentName;
  // Whether the body runs past its five lines (measured as it is drawn, and
  // again as the card is resized), and whether the user opened it whole.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [cut, setCut] = useState(false);
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || whole) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [note.body, whole]);
  const SourceIcon = note.about?.kind === "thread" ? MessageSquareText : note.about?.kind === "task" ? SquareCheckBig : Sparkles;
  return (
    <article data-slot="sticky-note" data-note-id={note.id} data-kind={note.kind} data-new={isNew ? "" : undefined} data-whole={whole ? "" : undefined} className="sticky-note group">
      <span data-slot="sticky-note-kind" className="absolute top-[9px] left-4 flex items-center gap-1.5 text-[11.5px] leading-none font-semibold tracking-[0.01em] text-[var(--note-label)]">
        <Icon aria-hidden className="size-3 shrink-0" strokeWidth={2.2} />
        {word}
      </span>
      <h3 className="m-0 min-w-0 text-[14.5px] leading-snug font-semibold text-pretty">
        <span data-slot="sticky-note-title" title={note.title} className="line-clamp-2">{note.title}</span>
      </h3>
      {/* Five lines: the clamp cuts text, the height a code block or a table, which the clamp does not reach. */}
      <div ref={bodyRef} data-slot="sticky-note-body" className={cn("min-w-0 text-[13px] leading-relaxed text-[var(--note-ink-muted)]", !whole && "line-clamp-5 max-h-[8.2em] overflow-hidden")}>
        <MarkdownView text={note.body} small dense />
      </div>
      {(cut || whole) && (
        <button
          type="button"
          aria-expanded={whole}
          onClick={() => setWhole((v) => !v)}
          className="hit relative -mt-1 self-start rounded-sm text-[11.5px] font-medium text-[var(--note-ink-faint)] hover:text-[var(--note-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {whole ? "Less" : "More"}
        </button>
      )}
      <div data-slot="sticky-note-meta" className="mt-auto flex min-w-0 items-center gap-1.5 pt-1.5 pr-5 text-[11.5px] leading-tight text-[var(--note-ink-faint)]">
        <SourceIcon aria-hidden className="size-3 shrink-0" />
        <span data-slot="sticky-note-source" className="min-w-0 truncate">{source}</span>
        <span aria-hidden="true">·</span>
        <span data-slot="sticky-note-when" className="shrink-0 tabular-nums">{noteWhen(note, now)}</span>
      </div>
      <div className="absolute top-[5px] right-1.5 z-[2] flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        <button type="button" aria-label="Done" title="Done" onClick={onDone} className={ACTION}>
          <Check aria-hidden className="size-3.5" strokeWidth={2.4} />
        </button>
      </div>
    </article>
  );
}
