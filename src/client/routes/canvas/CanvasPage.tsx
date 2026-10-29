import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, MoreHorizontal, RefreshCw, Trash2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Link, useLocation, useNavigate, useParams } from "react-router";
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
import { getLastNonCanvasPath } from "@/lib/last-non-canvas-path";
import { cn } from "@/lib/utils";
import { CanvasHtmlView } from "./CanvasHtmlView";
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
import { featureHref } from "@/lib/feature-href";
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
   *  false sends Open worker to the worker's page, as elsewhere. */
  openWorker?: (featureId: string) => boolean;
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

  const featurePath = canvas?.projectSlug && canvas.featureSlug
    ? featureHref(canvas.projectSlug, canvas.featureSlug)
    : null;
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
    const deleted = await deleteCanvasAfterConfirm({ id: canvas.id, title: canvas.title, featureId: canvas.featureId ?? null });
    // A deleted canvas has nothing left to show: back where it was opened.
    if (deleted && openCanvasId.current === canvas.id) closeCanvas();
  }, [canvas, closeCanvas]);
  // One menu and Close, on a phone and a desktop alike: the view, the
  // feature, refresh and delete are all in the menu. In a panel's tab the
  // tab has the ✕, and the menu Close tab.
  const panel = presentation === "panel";
  const menu = (
    <CanvasMenu
      canvas={canvas}
      view={view}
      resolved={resolved}
      onViewChange={setView}
      designViewer={designViewer}
      featurePath={featurePath}
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
              />
            )}
        </div>
      ) : null}
    </div>
  );
}

/** The canvas over whatever it was opened from. A Radix dialog, so it joins
 *  the layers already open: drawn in the page itself it sat UNDER a phone's
 *  worker sheet (a portal at the same depth, later in the document), which
 *  also kept every tap and the focus for itself. As a layer of the same kind
 *  it is in front, takes the taps, and hands focus back when it closes. */
export function CanvasModal() {
  const navigate = useNavigate();
  const content = useRef<HTMLDivElement>(null);
  // What had focus when the canvas was opened: the row or the card pressed.
  // Radix hands focus back to a dialog's Trigger, and this dialog has none
  // (a route opens it), so it would be left on the page's body.
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  // One step back per entry, however many ways the close is asked for. Per
  // entry: one modal serves every canvas, so a canvas opened over another
  // closes onto the first without a remount, and the first must still close.
  const closing = useRef(false);
  const { key } = useLocation();
  useEffect(() => {
    closing.current = false;
  }, [key]);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    navigate(-1);
  }, [navigate]);

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPrimitive.Portal>
        {/* The backdrop holds the dialog, so a press beside it is a press outside it. */}
        {/* It fades in as a dialog does; it closes by going back, so it leaves
            with the page. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/55 p-0 animate-in fade-in-0 duration-200 sm:items-center sm:p-4">
          <DialogPrimitive.Content
            ref={content}
            aria-label="Canvas"
            aria-describedby={undefined}
            // A menu or a question open over the canvas is a layer above and
            // takes Esc first; the design's focused view takes it before any
            // layer hears it (DesignCanvasView). What is left is the modal's,
            // except a held key's repeats after one of those.
            onEscapeKeyDown={(event) => { if (event.repeat) event.preventDefault(); }}
            // On the dialog itself, which names it; not on its first button.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              content.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const from = opener.current;
              if (from instanceof HTMLElement && from.isConnected) from.focus();
            }}
            className="flex h-full w-full min-w-0 overflow-hidden bg-background shadow-2xl outline-none animate-in fade-in-0 zoom-in-[0.98] duration-200 sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-[1600px] sm:rounded-lg sm:border sm:border-border-soft"
          >
            <DialogPrimitive.Title className="sr-only">Canvas</DialogPrimitive.Title>
            <CloseRequests />
            <CanvasPage presentation="modal" />
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function canvasContextLabel(canvas: CanvasDocumentDto | null): string | null {
  if (!canvas) return null;
  if (canvas.projectName && canvas.featureName) return `${canvas.projectName} / ${canvas.featureName}`;
  if (canvas.projectName) return canvas.projectName;
  if (canvas.featureName) return canvas.featureName;
  return null;
}

/** The canvas's one menu, on a phone and a desktop: the view (zoom, or a
 *  design's pages and zoom), Open worker, Refresh, and Delete last. Close
 *  stays beside it. */
function CanvasMenu({ canvas, view, resolved, onViewChange, designViewer, featurePath, openWorker, refreshing, onRefresh, onDelete, onCloseTab }: {
  canvas: CanvasDocumentDto | null;
  view: CanvasViewChoice;
  resolved: ResolvedCanvasView;
  onViewChange: (view: CanvasViewChoice) => void;
  designViewer: DesignViewer;
  featurePath: string | null;
  /** Asked first by Open worker (CanvasViewProps.openWorker). */
  openWorker?: (featureId: string) => boolean;
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
        {featurePath && (openWorker && canvas?.featureId
          ? (
            <DropdownMenuItem onSelect={() => { if (!openWorker(canvas.featureId!)) navigate(featurePath); }}>
              <ArrowUpRight aria-hidden="true" />
              Open worker
            </DropdownMenuItem>
          )
          : (
            <DropdownMenuItem asChild>
              <Link to={featurePath}>
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
