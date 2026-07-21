import { FileText } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import { Button } from "@/components/ui/button";
import { CanvasHtmlView } from "@/routes/canvas/CanvasHtmlView";
import { useCanvasDocument } from "@/routes/canvas/useCanvasDocument";

interface Props {
  canvasId: string;
  active: boolean;
}

/** Renders the feature's bound canvas inline inside the Overview tab. The
 *  sandboxed iframe auto-sizes to content so free-form canvas HTML cannot leak
 *  styles or scripts into the app shell. */
export function FeatureCanvasTab({ canvasId, active }: Props) {
  const { canvas: currentCanvas, error, refresh } = useCanvasDocument(canvasId);

  return (
    <section className="rounded-lg border border-border bg-card shadow-card overflow-hidden">
      {/* Document title and update time for the embedded Canvas. */}
      <div className="flex items-center gap-2 border-b border-border-soft px-3 py-1.5 text-chrome">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-medium">
          <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {currentCanvas?.title ?? "Canvas"}
        </span>
        {currentCanvas && (
          <span className="num whitespace-nowrap font-mono text-2xs">
            <RelativeTime value={currentCanvas.updatedAt} />
          </span>
        )}
      </div>
      {error && (
        <div className="m-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <p className="m-0">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            aria-label="Retry canvas"
            onClick={() => refresh()}
          >
            Retry
          </Button>
        </div>
      )}
      {currentCanvas ? (
        <div className="p-4">
          {/* Publishing can change linked assets without changing the HTML. */}
          <CanvasHtmlView key={`${currentCanvas.id}:${currentCanvas.contentRevision ?? 0}`} canvas={currentCanvas} active={active} />
        </div>
      ) : !error ? (
        <div className="m-3 rounded-lg border border-border-soft bg-muted/30 p-3 text-sm text-muted-foreground">
          Loading canvas…
        </div>
      ) : null}
    </section>
  );
}
