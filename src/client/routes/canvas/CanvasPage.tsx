import { useCallback, useEffect, useMemo } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getLastNonCanvasPath, useUiPageSummary } from "@/lib/ui-context";
import { cn } from "@/lib/utils";
import { CanvasHtmlView } from "./CanvasHtmlView";
import type { CanvasDocumentDto } from "@shared/api-contracts";
import { RefreshButton } from "@/components/RefreshButton";
import { useCanvasDocument } from "./useCanvasDocument";

interface CanvasPageProps {
  presentation?: "page" | "modal" | "embed";
}

export function CanvasPage({ presentation = "page" }: CanvasPageProps) {
  const { canvasId = "" } = useParams();
  const navigate = useNavigate();
  const { canvas, error, loading, refresh } = useCanvasDocument(canvasId);
  const closeCanvas = useCallback(() => {
    if (presentation === "modal") {
      navigate(-1);
      return;
    }
    navigate(getLastNonCanvasPath());
  }, [navigate, presentation]);

  const featurePath = useMemo(() => {
    if (!canvas?.projectSlug || !canvas.featureSlug) return null;
    return `/projects/${encodeURIComponent(canvas.projectSlug)}/features/${encodeURIComponent(canvas.featureSlug)}`;
  }, [canvas?.projectSlug, canvas?.featureSlug]);
  const contextLabel = useMemo(() => canvasContextLabel(canvas), [canvas]);
  useUiPageSummary("canvas", () => ({
    page: "canvas",
    canvasId,
    title: canvas?.title ?? null,
    scope: canvas?.scope ?? null,
    scopeId: canvas?.scopeId ?? null,
    projectName: canvas?.projectName ?? null,
    featureName: canvas?.featureName ?? null
  }));

  return (
    <div className={cn(
      "flex w-full flex-col bg-background",
      presentation === "modal" ? "h-full min-h-0 overflow-hidden" :
      presentation === "embed" ? "h-full min-h-0" :
      "min-h-full"
    )}>
      {presentation !== "embed" && (
        <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border-soft px-4 py-3 md:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold md:text-xl">
              {canvas?.title ?? "Loading canvas"}
            </h1>
            {contextLabel && (
              <div className="mt-0.5 truncate text-xs font-medium text-muted-foreground">
                {contextLabel}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {featurePath && canvas && (
              <Button variant="outline" size="sm" asChild>
                <Link
                  to={featurePath}
                  aria-label={`Open feature: ${canvas.featureName ?? canvas.featureSlug}`}
                >
                  <ArrowUpRight className="h-4 w-4" />
                  <span className="hidden sm:inline">Feature</span>
                </Link>
              </Button>
            )}
            <RefreshButton
              what="canvas"
              refreshing={loading}
              onRefresh={() => refresh(true)}
            />
            <Button
              variant="outline"
              size="icon-sm"
              onClick={closeCanvas}
              aria-label="Close canvas"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>
      )}

      {loading && !canvas ? (
        <div className="flex flex-1 flex-col gap-3 p-6">
          <Skeleton className="h-10 w-80 max-w-full" />
          <Skeleton className="h-[60vh] w-full rounded-lg" />
        </div>
      ) : error ? (
        <div className="m-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : canvas ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <CanvasHtmlView key={`${canvas.id}:${canvas.contentRevision ?? 0}`} canvas={canvas} fillParent />
        </div>
      ) : null}
    </div>
  );
}

export function CanvasModal() {
  const navigate = useNavigate();
  const close = useCallback(() => navigate(-1), [navigate]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/55 p-0 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Canvas"
        className="flex h-full w-full min-w-0 overflow-hidden bg-background shadow-2xl sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-[1600px] sm:rounded-lg sm:border sm:border-border-soft"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CanvasPage presentation="modal" />
      </div>
    </div>
  );
}

function canvasContextLabel(canvas: CanvasDocumentDto | null): string | null {
  if (!canvas) return null;
  if (canvas.projectName && canvas.featureName) return `${canvas.projectName} / ${canvas.featureName}`;
  if (canvas.projectName) return canvas.projectName;
  if (canvas.featureName) return canvas.featureName;
  return null;
}
