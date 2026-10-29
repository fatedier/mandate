import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useIsMobile } from "@/hooks/useIsMobile";
import { PaneHeaderTitle } from "@/shell/pane-header-slots";
import { useUIStore } from "@/store/ui";
import { useTerminalSession } from "@/hooks/useTerminalSession";
import { useTerminalGeometry } from "@/hooks/useTerminalGeometry";
import { useVisualViewport } from "@/hooks/useKeyboardOffset";
import { MobileInputBar } from "@/routes/terminal/MobileInputBar";
import { useMobileTerminalModifiers } from "@/routes/terminal/useMobileTerminalModifiers";
import { useTerminalMobileKeyboardLayout } from "@/routes/terminal/useTerminalMobileKeyboardLayout";
import { BackLink, LoadingLine, StateAction, StateMessage } from "@/components/ViewState";
import { compactPath } from "@/lib/format";
import { useMobileSelectionHandles } from "./useMobileSelectionHandles";
import { useTerminalPaneTarget } from "./useTerminalPaneTarget";
import { TerminalHeader } from "./TerminalHeader";
import { TerminalShell } from "./TerminalShell";
import { PaneSwitcherSheet } from "./PaneSwitcherSheet";
import { paneHrefFor, terminalPlace } from "./pane-href";

export function TerminalPage() {
  const params = useParams<{
    projectSlug?: string;
    featureSlug?: string;
    sessionName?: string;
    windowName?: string;
    paneId?: string;
  }>();
  const isMobile = useMediaQuery("(max-width: 760px)");
  // The shell's own breakpoint: below it the top bar's breadcrumb names the
  // page, above it the pane header does, and only there is a title claimed.
  const shellMobile = useIsMobile();
  const { keyboardOffset, keyboardHeight } = useVisualViewport();
  const keyboardOpen = isMobile && keyboardHeight > 50;
  const keyboardLift = isMobile && keyboardOffset > 50 ? keyboardOffset : 0;
  const terminalShellRef = useRef<HTMLDivElement | null>(null);
  const terminalViewportRef = useRef<HTMLDivElement | null>(null);
  const mobileInputBarRef = useRef<HTMLDivElement | null>(null);

  const {
    project, feature, paneId, isStandalone, standalone, pane, windowData,
    titleText, sessionProjectId, sessionName, windowName, stillLoading
  } = useTerminalPaneTarget(params);
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
  const terminalContainerRef = session.containerRef;
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

  const { selectionHandles, beginSelectionHandleDrag } = useMobileSelectionHandles({
    isMobile,
    terminalRef: session.terminalRef,
    selectionPosition: session.selectionPosition,
    hasSelection: session.hasSelection,
    terminalShellRef,
    terminalViewportRef,
    layout: { fitBrowser, fitWidth, keyboardOpen, keysVisible }
  });

  useEffect(() => () => {
    sendFitRef.current(null);
  }, [pane?.paneId]);

  // Desktop shows only a breadcrumb's last segment, so the page names whose
  // terminal it is itself, while it loads and after the pane is gone too.
  // Which pane stays in the bar below.
  const place = terminalPlace({
    isStandalone, lookup: standalone.pane,
    projectSlug: params.projectSlug, featureSlug: params.featureSlug, featureName: feature?.name,
    sessionName, windowName
  });
  const desktopTitle = shellMobile ? null : (
    <PaneHeaderTitle>
      <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
        <Link to={place.backHref} className="min-w-0 truncate text-muted-foreground hover:text-foreground">{place.name}</Link>
        <span aria-hidden className="text-faint">/</span>
        <span className="shrink-0 font-semibold text-foreground">Terminal</span>
      </h1>
    </PaneHeaderTitle>
  );

  if (stillLoading || !pane || !windowData) {
    // On the panel's ground, not the terminal's: these read in both themes.
    return (
      <div className="flex flex-col h-full min-h-0 bg-terminal-bg">
        {desktopTitle}
        <div className="border-b border-border-soft bg-panel px-4 py-3">
          {stillLoading ? <LoadingLine /> : isStandalone && standalone.status === "error" ? (
            <StateMessage title="Couldn't load this pane" detail={standalone.error} action={<StateAction onClick={standalone.retry}>Retry</StateAction>} />
          ) : (
            <StateMessage title="Pane not found" action={<BackLink to={place.backHref}>{`Back to ${place.name}`}</BackLink>}>
              It was closed.
            </StateMessage>
          )}
        </div>
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
  const path = pane ? (compactPath(pane.currentPath) || pane.currentPath || "") : "";
  const paneIndex = pane?.paneIndex ?? null;
  // Feature windows keep the feature route when the page was entered through
  // one (breadcrumb stays project / feature / pane); everything else takes the
  // session-rooted route, which works for unmanaged sessions too.
  const hrefFor = (s: string, w: string, p: string) =>
    paneHrefFor({ isStandalone, project, sessionName: s, windowName: w, paneId: p });
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
      {desktopTitle}
      <TerminalHeader
        isMobile={isMobile}
        titleText={titleText}
        path={path}
        status={session.status}
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
        // Just above the keyboard: where it shrinks only the visible area (an
        // iPhone) the page keeps its height, so the page's bottom is behind
        // the keyboard by keyboardLift.
        <div ref={mobileInputBarRef} className="absolute inset-x-0 bottom-0 z-40" style={keyboardLift > 0 ? { bottom: keyboardLift } : undefined}>
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
