import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useParams } from "react-router";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useSnapshotStore } from "@/store/snapshot";
import { useProjectsStore, findFeatureBySlug } from "@/store/projects";
import { useUIStore } from "@/store/ui";
import { useTerminalSession } from "@/hooks/useTerminalSession";
import { useTerminalGeometry } from "@/hooks/useTerminalGeometry";
import { useVisualViewport } from "@/hooks/useKeyboardOffset";
import { MobileInputBar } from "@/routes/terminal/MobileInputBar";
import { useMobileTerminalModifiers } from "@/routes/terminal/useMobileTerminalModifiers";
import { useTerminalMobileKeyboardLayout } from "@/routes/terminal/useTerminalMobileKeyboardLayout";
import { useStandalonePaneLookup } from "@/routes/terminal/useStandalonePaneLookup";
import { useUiPageSummary } from "@/lib/ui-context";
import { paneTitle } from "@/routes/window/pane-helpers";
import { compactPath } from "@/lib/format";
import {
  clientToSelectionBoundary,
  selectTerminalPane,
  rangeBoundary,
  selectBetweenBoundaries,
  type SelectionHandleGeometry,
  type SelectionHandleKind,
  type SelectionHandlePoint
} from "./terminal-helpers";
import { TerminalHeader } from "./TerminalHeader";
import { TerminalShell } from "./TerminalShell";
import { PaneSwitcherSheet } from "./PaneSwitcherSheet";
import { paneHrefFor } from "./pane-href";

export function TerminalPage() {
  const params = useParams<{
    projectSlug?: string;
    featureSlug?: string;
    sessionName?: string;
    windowName?: string;
    paneId?: string;
  }>();
  const isMobile = useMediaQuery("(max-width: 760px)");
  const { keyboardOffset, keyboardHeight } = useVisualViewport();
  const keyboardOpen = isMobile && keyboardHeight > 50;
  const keyboardLift = isMobile && keyboardOffset > 50 ? keyboardOffset : 0;
  const terminalShellRef = useRef<HTMLDivElement | null>(null);
  const terminalViewportRef = useRef<HTMLDivElement | null>(null);
  const mobileInputBarRef = useRef<HTMLDivElement | null>(null);

  const project = useProjectsStore((s) => params.projectSlug ? s.bySlug[params.projectSlug] : undefined);
  const feature = useMemo(
    () => findFeatureBySlug(project, params.featureSlug) ?? null,
    [project, params.featureSlug]
  );
  // React Router v7 already decodes path params, so don't re-decode here —
  // tmux pane ids start with a literal "%" (e.g. "%27") which would be
  // mangled into "'" by a second decode.
  const paneId = params.paneId ?? "";
  // Session-rooted mode: route is
  // `/sessions/:sessionName/windows/:windowName/pane/:paneId` — no
  // project/feature in URL. Session/window names come from the path, but
  // projectId + paneWidth/paneHeight still need a /api/panes/:paneId lookup
  // (the snapshot is filtered to managed feature windows).
  const isStandalone = !params.projectSlug;

  const standalone = useStandalonePaneLookup({ enabled: isStandalone, paneId });

  const found = useSnapshotStore(useShallow((s) => (
    isStandalone ? null : selectTerminalPane(s.snapshot, project?.tmuxSessionName, feature?.tmuxWindowName, paneId)
  )));

  const pane = isStandalone ? standalone.pane : found;
  const windowData = isStandalone ? standalone.windowData : found;
  const titleText = isStandalone
    ? (standalone.pane ? paneTitle(standalone.pane) : "Pane no longer exists")
    : (found?.title ?? "Pane no longer exists");
  // Session-rooted paths look up projectId from the pane DTO (it's null for
  // unmanaged tmux sessions). Managed routes have it directly from URL params.
  const sessionProjectId = isStandalone ? standalone.projectId : (project?.id ?? null);
  // Session-rooted routes name the session/window in the URL; feature routes
  // know them through the project and feature.
  const sessionName = isStandalone ? (params.sessionName ?? "") : (project?.tmuxSessionName ?? "");
  const windowName = isStandalone ? (params.windowName ?? "") : (feature?.tmuxWindowName ?? "");
  const rememberPane = useUIStore((s) => s.rememberPane);
  useEffect(() => {
    if (!paneId || !sessionName || !windowName) return;
    rememberPane({ sessionName, windowName, paneId });
  }, [rememberPane, sessionName, windowName, paneId]);
  // Phone-only pane switcher (the header title opens it). Closed on every
  // route change so a pick that navigates never leaves a stale open sheet.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  useEffect(() => { setSwitcherOpen(false); }, [paneId]);
  const {
    ctrlActive: mobileCtrlActive,
    altActive: mobileAltActive,
    clear: clearMobileModifiers,
    toggleCtrl: toggleMobileCtrl,
    toggleAlt: toggleMobileAlt,
    transformInput: transformMobileInput
  } = useMobileTerminalModifiers();

  // Fit toggles persist across panes via useUIStore — they're workflow
  // preferences, not per-pane state. Web fit resizes tmux's window for all
  // viewers, so it stays opt-in.
  const fitWidth = useUIStore((s) => s.terminalFitWidth);
  const setFitWidth = useUIStore((s) => s.setTerminalFitWidth);
  const fitBrowserUser = useUIStore((s) => s.terminalFitBrowser);
  const setFitBrowserUser = useUIStore((s) => s.setTerminalFitBrowser);
  const fitBrowser = fitBrowserUser;
  const session = useTerminalSession(pane, sessionProjectId, {
    transformInput: transformMobileInput,
    initialFitBrowser: fitBrowser,
    fitWidth,
    requestWebFit: fitBrowser
  });
  const [keysVisible, setKeysVisible] = useState(false);
  const [selectionHandles, setSelectionHandles] = useState<SelectionHandleGeometry | null>(null);
  const terminalContainerRef = session.containerRef;
  const selectionDragCleanupRef = useRef<(() => void) | null>(null);
  const scrollTerminalToBottom = session.scrollToBottom;
  const {
    terminalLift,
    stableTerminalHeight,
    lockTerminalHeightForKeyboard
  } = useTerminalMobileKeyboardLayout({
    isMobile,
    keysVisible,
    keyboardOpen,
    keyboardHeight,
    keyboardLift,
    fitBrowser,
    terminalShellRef,
    terminalViewportRef,
    mobileInputBarRef,
    terminalContainerRef,
    terminalRef: session.terminalRef,
    scrolledBack: session.scrolledBack,
    hasSelection: session.hasSelection,
    scrollToBottom: scrollTerminalToBottom
  });
  useTerminalGeometry({
    pane,
    fitWidth,
    fitBrowser,
    mobileKeyboardOpen: keyboardOpen,
    containerRef: session.containerRef,
    terminalRef: session.terminalRef,
    fitAddonRef: session.fitAddonRef,
    onResize: fitBrowser ? session.sendFit : session.sendResize
  });
  const sendFitRef = useRef(session.sendFit);
  useEffect(() => {
    sendFitRef.current = session.sendFit;
  }, [session.sendFit]);

  useEffect(() => {
    clearMobileModifiers();
    setKeysVisible(false);
    // fitWidth / fitBrowserUser are persisted via useUIStore — don't reset
    // them on pane change; carry the user's preference across terminals.
  }, [clearMobileModifiers, pane?.paneId]);

  useEffect(() => {
    if (!keysVisible) clearMobileModifiers();
  }, [clearMobileModifiers, keysVisible]);

  const terminal = session.terminalRef.current;
  const updateSelectionHandles = useCallback(() => {
    const shell = terminalShellRef.current;
    const viewport = terminalViewportRef.current;
    const range = terminal?.getSelectionPosition() ?? session.selectionPosition;
    if (!isMobile || !terminal?.hasSelection() || !range || !shell || !viewport) {
      setSelectionHandles(null);
      return;
    }

    const grid = terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? terminal.element;
    const gridRect = grid?.getBoundingClientRect();
    if (!gridRect) {
      setSelectionHandles(null);
      return;
    }

    const shellRect = shell.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const cellWidth = gridRect.width / terminal.cols;
    const cellHeight = gridRect.height / terminal.rows;
    if (cellWidth <= 0 || cellHeight <= 0) {
      setSelectionHandles(null);
      return;
    }

    const viewportY = terminal.buffer.active.viewportY;
    const viewportLeft = viewportRect.left - shellRect.left;
    const viewportRight = viewportRect.right - shellRect.left;
    const viewportTop = viewportRect.top - shellRect.top;
    const viewportBottom = viewportRect.bottom - shellRect.top;
    const toHandlePoint = (point: { x: number; y: number }): SelectionHandlePoint => {
      const rowInViewport = point.y - viewportY;
      const left = gridRect.left - shellRect.left + point.x * cellWidth;
      const top = gridRect.top - shellRect.top + (rowInViewport + 1) * cellHeight;
      return {
        left,
        top,
        visible:
          rowInViewport >= 0 &&
          rowInViewport < terminal.rows &&
          left >= viewportLeft &&
          left <= viewportRight &&
          top >= viewportTop &&
          top <= viewportBottom + 32
      };
    };

    setSelectionHandles({
      start: toHandlePoint(range.start),
      end: toHandlePoint(range.end)
    });
  }, [isMobile, session.selectionPosition, terminal]);

  useLayoutEffect(() => {
    updateSelectionHandles();
  }, [updateSelectionHandles, fitBrowser, fitWidth, keyboardOpen, keysVisible, session.hasSelection]);

  useEffect(() => {
    if (!isMobile) return;
    const viewport = terminalViewportRef.current;
    if (!viewport) return;
    const update = () => updateSelectionHandles();
    viewport.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [isMobile, updateSelectionHandles]);

  useEffect(() => () => {
    selectionDragCleanupRef.current?.();
    selectionDragCleanupRef.current = null;
  }, []);

  useEffect(() => () => {
    sendFitRef.current(null);
  }, [pane?.paneId]);

  // Snapshot streams in over SSE; on a fresh page load (e.g. browser refresh
  // straight to this URL) it's null for the first beat. Render a quiet
  // placeholder rather than flashing "Pane no longer exists" — that label is
  // reserved for the case where we have a snapshot but the pane really is
  // gone. Session-rooted mode uses its own loading/found/missing flag because
  // it doesn't depend on the snapshot stream.
  const stillLoading = isStandalone
    ? (standalone.status === "idle" || standalone.status === "loading")
    : found === undefined;
  useUiPageSummary("terminal", () => ({
    page: "terminal",
    standalone: isStandalone,
    project: project
      ? {
          id: project.id,
          name: project.name,
          slug: project.tmuxSessionName,
          workingDir: project.workingDir
        }
      : null,
    feature: feature
      ? {
          id: feature.id,
          name: feature.name,
          slug: feature.tmuxWindowName,
          mode: feature.mode,
          branch: feature.branch,
          worktreePath: feature.worktreePath
        }
      : null,
    pane: pane
      ? {
          paneId: pane.paneId,
          title: titleText,
          currentCommand: pane.currentCommand,
          currentPath: pane.currentPath,
          width: pane.paneWidth,
          height: pane.paneHeight
        }
      : null,
    terminal: {
      status: session.status,
      fitWidth,
      fitBrowser,
      scrolledBack: session.scrolledBack,
      hasSelection: session.hasSelection,
      firstPaintReady: session.firstPaintReady
    }
  }));
  if (stillLoading || !pane || !windowData) {
    const message = stillLoading ? "Loading…" : "Pane no longer exists";
    return (
      <div className="flex flex-col h-full min-h-0 bg-terminal-bg">
        <header className="flex items-center gap-1 px-3 py-2 border-b border-border-soft bg-panel">
          <span className="text-sm text-muted-foreground">{message}</span>
        </header>
      </div>
    );
  }

  const toggleBrowserFit = () => {
    if (fitBrowserUser) {
      session.sendFit(null);
      setFitBrowserUser(false);
      return;
    }
    setFitBrowserUser(true);
  };
  const beginSelectionHandleDrag = (
    kind: SelectionHandleKind,
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    const terminal = session.terminalRef.current;
    const range = terminal?.getSelectionPosition() ?? session.selectionPosition;
    if (!terminal || !range) return;
    event.preventDefault();
    event.stopPropagation();
    terminal.blur();

    selectionDragCleanupRef.current?.();
    const fixed = rangeBoundary(range, kind === "start" ? "end" : "start");
    const onPointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const moving = clientToSelectionBoundary(terminal, moveEvent.clientX, moveEvent.clientY);
      if (!moving) return;
      selectBetweenBoundaries(terminal, fixed, moving);
      updateSelectionHandles();
    };
    const stopDrag = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", stopDrag);
      document.removeEventListener("pointercancel", stopDrag);
      selectionDragCleanupRef.current = null;
      updateSelectionHandles();
    };
    selectionDragCleanupRef.current = stopDrag;
    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("pointerup", stopDrag);
    document.addEventListener("pointercancel", stopDrag);
  };

  const path = pane ? (compactPath(pane.currentPath) || pane.currentPath || "") : "";
  const paneIndex = pane?.paneIndex ?? null;
  // Feature windows keep the feature route when the page was entered through
  // one (breadcrumb stays project / feature / pane); everything else takes the
  // session-rooted route, which works for unmanaged sessions too.
  const hrefFor = (s: string, w: string, p: string) =>
    paneHrefFor({ isStandalone, project, sessionName: s, windowName: w, paneId: p });
  const statusOk = session.status === "connected";
  const statusDotClass =
    session.status === "connected" ? "bg-green" :
    session.status === "connecting" ? "bg-muted-foreground animate-pulse" :
    "bg-red";
  const terminalShellStyle = {
    ...(lockTerminalHeightForKeyboard
      ? {
          flex: `0 0 ${stableTerminalHeight}px`,
          height: `${stableTerminalHeight}px`,
          minHeight: `${stableTerminalHeight}px`
        }
      : {}),
    ...(terminalLift > 0 ? { transform: `translateY(-${terminalLift}px)` } : {})
  };

  const handleCopySelection = async () => {
    const text = await session.copySelection({ restoreFocus: !isMobile });
    if (text) toast.success(`Copied ${text.length} character${text.length === 1 ? "" : "s"}`);
    else toast.error("Couldn't copy — clipboard permission denied?");
  };

  return (
    <div className="relative flex flex-col h-full min-h-0 bg-terminal-bg">
      <TerminalHeader
        isMobile={isMobile}
        titleText={titleText}
        path={path}
        statusOk={statusOk}
        status={session.status}
        statusDotClass={statusDotClass}
        windowZoomed={Boolean(windowData?.windowZoomed)}
        fitWidth={fitWidth}
        fitBrowserUser={fitBrowserUser}
        keysVisible={keysVisible}
        onToggleFitWidth={() => setFitWidth(!fitWidth)}
        onToggleBrowserFit={toggleBrowserFit}
        onToggleKeysVisible={() => setKeysVisible((v) => !v)}
        onRefresh={session.sendRefresh}
        switcher={isMobile && sessionName && windowName
          ? { windowName, paneIndex, open: switcherOpen, onToggle: () => setSwitcherOpen((v) => !v) }
          : undefined}
      />
      <TerminalShell
        ref={terminalShellRef}
        isMobile={isMobile}
        firstPaintReady={session.firstPaintReady}
        scrolledBack={session.scrolledBack}
        hasSelection={session.hasSelection}
        keysVisible={keysVisible}
        selectionHandles={selectionHandles}
        terminalShellStyle={Object.keys(terminalShellStyle).length > 0 ? terminalShellStyle : undefined}
        terminalViewportRef={terminalViewportRef}
        terminalContainerRef={terminalContainerRef}
        onScrollToBottom={session.scrollToBottom}
        onCopySelection={handleCopySelection}
        onBeginSelectionHandleDrag={beginSelectionHandleDrag}
      />
      {isMobile && sessionName && (
        <PaneSwitcherSheet
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          sessionName={sessionName}
          currentPaneId={paneId}
          hrefFor={hrefFor}
        />
      )}
      {isMobile && keysVisible && (
        <div ref={mobileInputBarRef} className="absolute inset-x-0 bottom-0 z-40">
          <MobileInputBar
            sendInput={session.sendInput}
            focusTerminal={session.focusTerminal}
            ctrlActive={mobileCtrlActive}
            altActive={mobileAltActive}
            onToggleCtrl={toggleMobileCtrl}
            onToggleAlt={toggleMobileAlt}
            onClearModifiers={clearMobileModifiers}
          />
        </div>
      )}
    </div>
  );
}
