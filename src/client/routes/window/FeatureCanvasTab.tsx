import { useCallback, useState } from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import { Link, useLocation } from "react-router";
import { RelativeTime } from "@/components/RelativeTime";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { type CanvasFit } from "@/routes/canvas/canvas-fit";
import { CanvasHtmlView } from "@/routes/canvas/CanvasHtmlView";
import { type FrameReadiness } from "@/routes/canvas/frame-readiness";
import { useCanvasDocument } from "@/routes/canvas/useCanvasDocument";

interface Props {
  canvasId: string;
  active: boolean;
  /** Test hook; production uses CanvasHtmlView's default (FRAME_LOAD_TIMEOUT_MS). */
  loadTimeoutMs?: number;
  /** Test hook; forwarded to CanvasHtmlView, which measures its wrapper in production. */
  containerWidth?: number;
}

/** The feature's bound canvas, inline in the Overview. The frame is a
 *  sandboxed iframe that sizes itself through the bridge; until it reports a
 *  height the card shows a skeleton in its place, and a frame that never
 *  reports gets a one-line failure with Retry instead of an empty box. */
export function FeatureCanvasTab({ canvasId, active, loadTimeoutMs, containerWidth }: Props) {
  const { canvas: currentCanvas, error, refresh } = useCanvasDocument(canvasId);
  const location = useLocation();
  const [readiness, setReadiness] = useState<FrameReadiness | null>(null);
  const [fit, setFit] = useState<CanvasFit | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const onReadinessChange = useCallback((next: FrameReadiness) => setReadiness(next), []);
  const onFitChange = useCallback((next: CanvasFit | null) => setFit(next), []);
  const retry = () => setRetryToken((token) => token + 1);
  const showSkeleton = Boolean(currentCanvas) && readiness !== "ready" && readiness !== "failed";
  const showFailed = Boolean(currentCanvas) && readiness === "failed";

  return (
    <section data-slot="canvas-card" className="overflow-hidden rounded-lg border border-border-soft bg-panel">
      <div className="flex items-center gap-2 border-b border-border-soft px-3.5 py-2.5 text-muted-foreground">
        <FileText className="size-4 shrink-0" aria-hidden />
        <span data-slot="canvas-title" className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {currentCanvas?.title ?? "Canvas"}
        </span>
        {currentCanvas && (
          <span className="num shrink-0 text-2xs text-faint">
            <RelativeTime value={currentCanvas.updatedAt} />
          </span>
        )}
        {fit && fit.scale < 1 && (
          <span data-slot="canvas-fit" className="num shrink-0 text-2xs text-faint" title="Scaled to fit the card; Open shows it at full size">
            fit · {Math.round(fit.scale * 100)}%
          </span>
        )}
        <Link
          data-slot="canvas-open"
          to={`/canvas/${canvasId}`}
          state={{ backgroundLocation: location }}
          className="flex shrink-0 items-center gap-1 text-2xs text-faint transition-colors hover:text-foreground"
        >
          Open
          <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </div>
      {error && (
        <div data-slot="canvas-failed" className="flex items-center gap-3 px-3.5 py-3 text-xs text-faint">
          <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
          <Button variant="ghost" size="xs" aria-label="Retry canvas" onClick={() => refresh()}>Retry</Button>
        </div>
      )}
      {showSkeleton && <CanvasSkeleton />}
      {showFailed && (
        <div data-slot="canvas-failed" className="flex items-center gap-3 px-3.5 py-3 text-xs text-faint">
          <span className="min-w-0 flex-1">Canvas didn't load</span>
          <Button variant="ghost" size="xs" aria-label="Retry canvas" onClick={retry}>Retry</Button>
        </div>
      )}
      {currentCanvas && (
        <div className={showSkeleton || showFailed ? "px-4" : "p-4"}>
          {/* Publishing can change linked assets without changing the HTML. */}
          <CanvasHtmlView
            key={`${currentCanvas.id}:${currentCanvas.contentRevision ?? 0}`}
            canvas={currentCanvas}
            active={active}
            onReadinessChange={onReadinessChange}
            onFitChange={onFitChange}
            loadTimeoutMs={loadTimeoutMs}
            retryToken={retryToken}
            containerWidth={containerWidth}
          />
        </div>
      )}
      {!currentCanvas && !error && <CanvasSkeleton />}
    </section>
  );
}

/** Three bars in `--sel`, sized roughly to the lines of text they stand in
 *  for. Shown both while the document is fetched and while the frame waits
 *  for its first height. */
function CanvasSkeleton() {
  return (
    <div data-slot="canvas-skeleton" aria-busy="true" aria-label="Loading canvas" className="flex flex-col gap-3 px-3.5 py-4">
      <Skeleton className="h-3.5 w-[70%] rounded-xs bg-sel" />
      <Skeleton className="h-3.5 w-[90%] rounded-xs bg-sel" />
      <Skeleton className="h-3.5 w-[55%] rounded-xs bg-sel" />
    </div>
  );
}
