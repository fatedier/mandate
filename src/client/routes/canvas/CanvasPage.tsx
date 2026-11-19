import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, MoreHorizontal, RefreshCw, Trash2, X } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { PaneHeaderActions, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { LoadingLine, StateAction, StateMessage } from "@/components/ViewState";
import { CloseRequests } from "@/lib/close-requests";
import { RouteDialog } from "@/components/RouteDialog";
import { getLastNonCanvasPath } from "@/lib/last-non-canvas-path";
import { cn } from "@/lib/utils";
import { CanvasHtmlView } from "./CanvasHtmlView";
import { useCanvasPictures } from "./canvas-pictures";
import { CanvasViewMenuItems } from "./CanvasViewControls";
import { DesignCanvasView } from "./DesignCanvasView";
import { DesignPageMenuItems, DesignViewControls, DesignZoomMenuItems } from "./DesignViewControls";
import { designShowsPages, useDesignViewer, type DesignViewer } from "./use-design-viewer";
import { DEFAULT_CANVAS_VIEW, resolveCanvasView, type CanvasView as CanvasViewChoice, type ResolvedCanvasView } from "./canvas-view";
import { useElementSize } from "./use-element-size";
import { declaredDesktopWidth } from "./canvas-desktop-width";
import type { CanvasDocumentDto } from "@shared/api-contracts";
import { useCanvasDocument } from "./useCanvasDocument";
import { CanvasShownContext } from "./canvas-shown";
import { workerInThreadHref } from "@/lib/worker-href";
import { useProjectsStore } from "@/store/projects";
import { formatClockMinutes } from "@/lib/format";
import { deleteCanvasAfterConfirm } from "./delete-canvas";

interface CanvasPageProps {
  presentation?: "page" | "modal" | "embed";
}

/** The canvas the address names: a page, the modal over a page, or alone in
 *  a frame (embed). */
export function CanvasPage({ presentation = "page" }: CanvasPageProps) {
  const { canvasId = "" } = useParams();
  return <CanvasView canvasId={canvasId} presentation={presentation} />;
}

export interface CanvasViewProps {
  canvasId: string;
  /** "panel": in a right panel's tab, under its tab row (CanvasTabBar). */
  presentation: "page" | "modal" | "embed" | "panel";
  /** In a panel: closes its tab (the menu's Close tab, a delete, a canvas
   *  that is not there). */
  onClose?: () => void;
  /** In a panel on a thread: opens one of the thread's workers as a tab;
   *  false sends Open worker to the worker's own thread, as elsewhere. */
  openWorker?: (workerId: string) => boolean;
}

export function CanvasView({ canvasId, presentation, onClose, openWorker }: CanvasViewProps) {
  const navigate = useNavigate();
  // Behind another panel tab, a change is read when it is shown again.
  const shown = useContext(CanvasShownContext);
  const { canvas, error, missing, loading, refresh } = useCanvasDocument(canvasId, shown);
  // Per open: a new canvas starts from its own defaults.
  const [viewState, setViewState] = useState<{ canvasId: string; view: CanvasViewChoice }>({ canvasId, view: DEFAULT_CANVAS_VIEW });
  // Opening another canvas drops the old choice, so coming back to one also
  // starts from its defaults (adjusting state while rendering, React's
  // pattern for a reset keyed on a prop).
  if (viewState.canvasId !== canvasId) setViewState({ canvasId, view: DEFAULT_CANVAS_VIEW });
  const view = viewState.canvasId === canvasId ? viewState.view : DEFAULT_CANVAS_VIEW;
  const setView = useCallback((next: CanvasViewChoice) => setViewState({ canvasId, view: next }), [canvasId]);
  const [viewer, setViewer] = useState<HTMLDivElement | null>(null);
  // A picture pressed in the report opens over the page; held here, outside
  // the report's frame, so a republish (which remounts the frame) leaves it.
  const pictures = useCanvasPictures(canvasId, () => viewer?.querySelector("iframe") ?? null, canvas?.title);
  const viewerSize = useElementSize(viewer);
  const viewerWidth = viewerSize.width;
  const design = canvas?.kind === "design" ? canvas.design ?? null : null;
  const designViewer = useDesignViewer(canvasId, design, viewerSize);
  const declaredWidth = useMemo(() => declaredDesktopWidth(canvas?.html ?? ""), [canvas?.html]);
  const resolved = resolveCanvasView(view, { declaredWidth, viewerWidth });
  const closeCanvas = useCallback(() => {
    if (presentation === "panel") {
      onClose?.();
      return;
    }
    if (presentation === "modal") {
      navigate(-1);
      return;
    }
    navigate(getLastNonCanvasPath());
  }, [navigate, presentation, onClose]);

  // A worker's canvas opens its worker in the thread that owns it.
  const canvasWorkerId = canvas?.workerId ?? null;
  const ownerThreadId = useProjectsStore((s) => {
    if (!canvasWorkerId) return null;
    for (const project of s.projects) {
      const worker = project.workers.find((w) => w.id === canvasWorkerId);
      if (worker) return worker.ownerThreadId;
    }
    return null;
  });
  const workerPath = canvasWorkerId && ownerThreadId ? workerInThreadHref(ownerThreadId, canvasWorkerId, "canvases") : null;
  const contextLabel = useMemo(() => canvasContextLabel(canvas), [canvas]);

  // A failed read says what happened in the page; the header must not go on
  // saying it is loading, nor say it twice.
  const title = canvas?.title ?? (error && !loading ? "Canvas" : "Loading canvas");
  const titleBlock = (
    <>
      <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</h1>
      {/* The header is the container: a narrow one keeps the title whole.
          Its cap is the header's share, not the title slot's (which sits at
          its own width while the header says it is reconnecting), and it
          gives way faster than the title rather than squeezing it out. */}
      {contextLabel && <span className="hidden min-w-0 max-w-[45cqw] shrink-[3] truncate text-2xs text-faint @[30rem]:inline">{contextLabel}</span>}
    </>
  );
  // Which canvas is open here now, or none once this viewer is gone: a
  // delete that answers after another canvas was opened, or after this
  // viewer closed, must not close anything.
  const openCanvasId = useRef<string | null>(canvasId);
  useEffect(() => {
    openCanvasId.current = canvasId;
    return () => { openCanvasId.current = null; };
  }, [canvasId]);
  const deleteCanvas = useCallback(async () => {
    if (!canvas) return;
    const deleted = await deleteCanvasAfterConfirm({ id: canvas.id, title: canvas.title, workerId: canvas.workerId ?? null });
    // A deleted canvas has nothing left to show: back where it was opened.
    if (deleted && openCanvasId.current === canvas.id) closeCanvas();
  }, [canvas, closeCanvas]);
  // One menu and Close, on a phone and a desktop alike: the view, the
  // worker, refresh and delete are all in the menu. In a panel's tab the
  // tab has the ✕, and the menu Close tab.
  const panel = presentation === "panel";
  const menu = (
    <CanvasMenu
      canvas={canvas}
      view={view}
      resolved={resolved}
      onViewChange={setView}
      designViewer={designViewer}
      workerPath={workerPath}
      openWorker={openWorker}
      refreshing={loading}
      onRefresh={() => refresh(true)}
      onDelete={() => void deleteCanvas()}
      onCloseTab={panel ? closeCanvas : undefined}
    />
  );
  const actions = (
    <>
      {menu}
      {/* Two 32px icons: 12px apart on a touch screen, so their 44px touch
          areas meet without overlapping. */}
      <Button variant="ghost" size="icon-sm" onClick={closeCanvas} aria-label="Close canvas" className="pointer-coarse:ml-1">
        <X className="h-4 w-4" />
      </Button>
    </>
  );

  return (
    <div data-slot="canvas-view" className={cn(
      "flex w-full flex-col bg-background",
      presentation === "modal" ? "h-full min-h-0 overflow-hidden" :
      presentation === "embed" || presentation === "panel" ? "h-full min-h-0 flex-1" :
      "min-h-full"
    )}>
      {/* A page's title and actions live in the app's own header (the
          pane header; a phone's top bar), not in a second row under one that
          could only name the canvas by its id. The modal floats over the app
          with no header of its own to borrow, so it draws one — a container
          too, for the same narrow-width rules. */}
      {presentation === "page" && (
        <>
          <PaneHeaderTitle>{titleBlock}</PaneHeaderTitle>
          <PaneHeaderActions>{actions}</PaneHeaderActions>
        </>
      )}
      {presentation === "modal" && (
        <header className="@container flex min-h-14 items-center justify-between gap-3 border-b border-border-soft px-4 py-3 md:px-6">
          <div className="flex min-w-0 items-center gap-2">{titleBlock}</div>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </header>
      )}

      {panel && (
        <div data-slot="canvas-tab-bar" className="@container flex h-11 shrink-0 items-center gap-2 border-b border-border-soft pl-3 pr-2">
          <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</h2>
          {canvas && (
            <span className="num shrink-0 text-xs text-faint">
              {canvas.kind === "design" ? "Design" : "Report"} · updated {formatClockMinutes(canvas.updatedAt)}
            </span>
          )}
          <div className="min-w-0 flex-1" />
          {menu}
        </div>
      )}
      {design && designViewer.focused && (
        <div data-slot="design-focus-bar" className="flex h-11 shrink-0 items-center gap-2 border-b border-border-soft px-4 md:px-6">
          <DesignViewControls viewer={designViewer} />
        </div>
      )}

      {loading && !canvas ? (
        <LoadingLine className="p-6" />
      ) : error && missing ? (
        // An embedded canvas's frame belongs to the page around it: closing
        // here would load the app inside the frame.
        <StateMessage className="p-6" title="Canvas not found" action={presentation === "embed" ? undefined : <StateAction onClick={closeCanvas}>{panel ? "Close tab" : "Close"}</StateAction>}>
          It was deleted, or the link is wrong.
        </StateMessage>
      ) : error ? (
        <StateMessage className="p-6" title="Couldn't load this canvas" detail={error} action={<StateAction onClick={() => refresh(true)}>Retry</StateAction>} />
      ) : canvas ? (
        <div ref={setViewer} className="relative min-h-0 flex-1 overflow-hidden">
          {canvas.kind === "design"
            ? (design
              ? <DesignCanvasView canvasId={canvas.id} design={design} revision={canvas.contentRevision} viewer={designViewer} />
              : <p className="m-6 text-sm text-muted-foreground">This design has not been published yet.</p>)
            : (
              <CanvasHtmlView
                key={`${canvas.id}:${canvas.contentRevision}`}
                canvas={canvas}
                view={view}
                resolved={resolved}
                onViewChange={setView}
                onPictures={pictures.onPictures}
              />
            )}
          {pictures.viewer}
        </div>
      ) : null}
    </div>
  );
}

/** Whether a press Radix reports as outside the canvas landed on a toast.
 *  Radix dispatches its event on the element pressed and keeps the original
 *  in its detail. Closing the canvas steps back in history, so a notice's
 *  Open pressed over it would open its thread and be undone at once; any
 *  other layer just closes, and is left to. */
/** The canvas over whatever it was opened from (RouteDialog). */
export function CanvasModal() {
  return (
    <RouteDialog label="Canvas">
      <CloseRequests />
      <CanvasPage presentation="modal" />
    </RouteDialog>
  );
}

function canvasContextLabel(canvas: CanvasDocumentDto | null): string | null {
  if (!canvas) return null;
  if (canvas.projectName && canvas.workerName) return `${canvas.projectName} / ${canvas.workerName}`;
  if (canvas.projectName) return canvas.projectName;
  if (canvas.workerName) return canvas.workerName;
  return null;
}

/** The canvas's one menu, on a phone and a desktop: the view (zoom, or a
 *  design's pages and zoom), Open worker, Refresh, and Delete last. Close
 *  stays beside it. */
function CanvasMenu({ canvas, view, resolved, onViewChange, designViewer, workerPath, openWorker, refreshing, onRefresh, onDelete, onCloseTab }: {
  canvas: CanvasDocumentDto | null;
  view: CanvasViewChoice;
  resolved: ResolvedCanvasView;
  onViewChange: (view: CanvasViewChoice) => void;
  designViewer: DesignViewer;
  workerPath: string | null;
  /** Asked first by Open worker (CanvasViewProps.openWorker). */
  openWorker?: (workerId: string) => boolean;
  /** In a panel's tab: the menu closes it. */
  onCloseTab?: () => void;
  /** A read in flight: another would only queue a second fetch after it. */
  refreshing: boolean;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  // A focused design's controls sit in their own bar under the header.
  const viewItems = !canvas ? null : canvas.kind === "design"
    ? designViewer.focused ? null : (
      <>
        {designShowsPages(designViewer) && (
          <>
            <DesignPageMenuItems viewer={designViewer} />
            <DropdownMenuSeparator />
          </>
        )}
        <DesignZoomMenuItems viewer={designViewer} />
      </>
    )
    : <CanvasViewMenuItems view={view} resolved={resolved} onViewChange={onViewChange} />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Canvas menu">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {viewItems && (
          <>
            {viewItems}
            <DropdownMenuSeparator />
          </>
        )}
        {workerPath && (openWorker && canvas?.workerId
          ? (
            <DropdownMenuItem onSelect={() => { if (!openWorker(canvas.workerId!)) navigate(workerPath); }}>
              <ArrowUpRight aria-hidden="true" />
              Open worker
            </DropdownMenuItem>
          )
          : (
            <DropdownMenuItem asChild>
              <Link to={workerPath}>
                <ArrowUpRight aria-hidden="true" />
                Open worker
              </Link>
            </DropdownMenuItem>
          ))}
        <DropdownMenuItem disabled={refreshing} onSelect={onRefresh}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </DropdownMenuItem>
        {onCloseTab && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onCloseTab}>
              <X aria-hidden="true" />
              Close tab
            </DropdownMenuItem>
          </>
        )}
        {canvas && (
          <>
            {!onCloseTab && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 aria-hidden="true" />
              Delete canvas…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
