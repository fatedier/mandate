import { Link } from "react-router";
import { useOpenCanvas } from "@/routes/canvas/canvas-opener";
import { cn } from "@/lib/utils";
import { noteTokens, type NoteLinkContext } from "./note-links";

const LINK = "text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground";

/** A step's note as text with its panes, reports, commits, issues and URLs
 *  linked. Clamped to four lines when asked (the step being worked on, until
 *  it is opened). */
export function PlanNote({ note, ctx, clamp }: { note: string; ctx: NoteLinkContext; clamp: boolean }) {
  const openCanvas = useOpenCanvas();
  return (
    <p data-slot="plan-note" className={cn("m-0 whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]", clamp && "line-clamp-4")}>
      {noteTokens(note, ctx).map((t, i) => {
        switch (t.kind) {
          case "text": return <span key={i}>{t.text}</span>;
          case "pane": return <Link key={i} to={t.href} className={LINK}>{t.label}</Link>;
          case "canvas": return (
            <a key={i} href={`/canvas/${t.canvasId}`} className={LINK}
              onClick={(e) => {
                // A modified click opens the report page in a new tab, as a link does.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                openCanvas(t.canvasId);
              }}>
              {t.label}
            </a>
          );
          case "web": return <a key={i} href={t.href} target="_blank" rel="noreferrer" className={LINK}>{t.label}</a>;
        }
      })}
    </p>
  );
}
