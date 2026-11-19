import { ArrowUpRight, FileText } from "lucide-react";
import { canvasIdOfPath } from "@/lib/canvas-link";
import { useOpenCanvas } from "@/routes/canvas/canvas-opener";

interface CanvasReferenceLinkProps {
  title: string;
  path: string;
}

/** A canvas a step published, as one line under its tool run: its title,
 *  which opens it. Every publish has its own; none is a card. */
export function CanvasReferenceLink({ title, path }: CanvasReferenceLinkProps) {
  const openCanvas = useOpenCanvas();
  const canvasId = canvasIdOfPath(path);
  return (
    <button
      type="button"
      data-slot="published-canvas"
      onClick={() => { if (canvasId) openCanvas(canvasId, path); }}
      className="group -ml-0.5 flex min-h-7 max-w-[min(100%,36rem)] min-w-0 items-center gap-1.5 self-start rounded-sm px-0.5 text-left text-sm text-muted-foreground transition hover:text-foreground pointer-coarse:min-h-9"
      aria-label={`Open canvas: ${title}`}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate underline decoration-border underline-offset-4 group-hover:decoration-current">{title}</span>
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </button>
  );
}
