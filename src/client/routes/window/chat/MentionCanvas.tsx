import { FileText, LayoutGrid } from "lucide-react";
import { formatRelativeTime } from "@/lib/format";
import type { CanvasKind, CanvasMentionDto } from "@shared/api-contracts";

const KIND_ICONS: Record<CanvasKind, typeof FileText> = { report: FileText, design: LayoutGrid };

export function CanvasIcon({ kind, className }: { kind: CanvasKind; className: string }) {
  const Icon = KIND_ICONS[kind] ?? FileText;
  return <Icon data-slot="mention-icon" data-kind={kind} aria-hidden className={className} />;
}

/** A canvas in the @ list: its kind's icon, its title, and where it came
 *  from (its worker, its thread, or the agent by name) with when it last
 *  changed. */
export function CanvasOption({ canvas, marks, agentName }: { canvas: CanvasMentionDto; marks: readonly number[]; agentName: string }) {
  const origin = canvas.origin === null ? null : canvas.origin.kind === "agent" ? agentName : canvas.origin.name;
  return (
    <>
      <CanvasIcon kind={canvas.kind} className="size-3.5 shrink-0 text-chrome" />
      <MentionTitle title={canvas.title} marks={marks} />
      <span data-slot="mention-meta" className="max-w-[45%] shrink-0 truncate text-2xs text-faint tabular-nums">
        {origin ? `${origin} · ${formatRelativeTime(canvas.updatedAt)}` : formatRelativeTime(canvas.updatedAt)}
      </span>
    </>
  );
}

/** An option's title, the characters that answered what was typed marked
 *  (by holding it, or as its pinyin). */
export function MentionTitle({ title, marks }: { title: string; marks: readonly number[] }) {
  const marked = new Set(marks);
  // Runs of characters marked or not, so a pair of UTF-16 halves stays whole.
  const runs: Array<{ text: string; marked: boolean }> = [];
  for (let i = 0; i < title.length; i++) {
    const on = marked.has(i);
    const last = runs[runs.length - 1];
    if (last && last.marked === on) last.text += title[i];
    else runs.push({ text: title[i]!, marked: on });
  }
  return (
    <span data-slot="mention-title" className="min-w-0 flex-1 truncate text-xs text-foreground">
      {runs.map((run, i) => run.marked
        ? <mark key={i} data-slot="mention-mark" className="bg-transparent font-semibold text-primary-soft">{run.text}</mark>
        : run.text)}
    </span>
  );
}
