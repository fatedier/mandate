import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useUIStore } from "@/store/ui";
import { displayHere } from "./terminal-display";
import { useTerminalSession, type TerminalControl } from "@/hooks/useTerminalSession";
import { useTerminalGeometry } from "@/hooks/useTerminalGeometry";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { StateMessage } from "@/components/ViewState";
import { MobileInputBar } from "./MobileInputBar";
import { useMobileTerminalModifiers } from "./useMobileTerminalModifiers";
import { useTerminalMobileKeyboardLayout } from "./useTerminalMobileKeyboardLayout";
import { useSelectionPlacement } from "./useSelectionPlacement";
import { createPortal } from "react-dom";
import { TerminalControls, TerminalHeader, type TerminalControlProps, type TerminalHeaderProps, type TerminalTabMove } from "./TerminalHeader";
import { useTerminalControlsSlot } from "./terminal-controls-slot-context";
import { TerminalShell } from "./TerminalShell";

type TerminalPane = NonNullable<Parameters<typeof useTerminalSession>[0]>;

/** How long the Copy button says Copied in its place, as the app's other copy buttons do. */
const COPIED_MS = 1500;

/** In place of the terminal when its pane is gone, or its id now names
 *  another pane. */
export function TerminalClosedNotice() {
  return (
    <div data-slot="terminal-closed" className="border-b border-border-soft bg-panel px-4 py-3">
      <StateMessage title="This terminal has closed." />
    </div>
  );
}

interface LiveTerminalProps {
  pane: TerminalPane;
  windowZoomed: boolean;
  /** The pid the pane is known by; a socket refused for it shows the notice. */
  expectPid?: number | null;
  header: Pick<TerminalHeaderProps, "titleText" | "path" | "switcher"> & {
    /** Pin or Unpin, in the controls' ⋯ in a tab row. */
    pin?: { pinned: boolean; onToggle: () => void };
    /** Move left / Move right, there too: the Terminals page's tabs only. */
    move?: TerminalTabMove;
  };
  /** Laid over the terminal (the worker route's switcher sheet). */
  children?: ReactNode;
  /** False while it is kept hidden behind another tab: its controls stay
   *  out of the row. */
  shown?: boolean;
}

/** A pane's live terminal with its header: the worker route, the Terminals
 *  page and the personal agent's panel all show this one. Under a tab row
 *  that names it (TerminalControlsSlotProvider) it has no header: its
 *  controls go to the row, `path` first in their ⋯. On a phone it owns
 *  the screen: the input bar, the keyboard lift and the selection handles.
 *  Another pane (or pid) is a new terminal: a closed one took its xterm's
 *  container away, and the session must start in a fresh one. */
export function LiveTerminal(props: LiveTerminalProps) {
  return <PaneTerminal key={`${props.pane.paneId ?? ""}:${props.expectPid ?? ""}`} {...props} />;
}

function PaneTerminal({ pane, windowZoomed, expectPid = null, header, children, shown = true }: LiveTerminalProps) {
  const isMobile = useMediaQuery("(max-width: 760px)");
  const { keyboardOffset, keyboardHeight } = useVisualViewport();
  const keyboardOpen = isMobile && keyboardHeight > 50;
  const keyboardLift = isMobile && keyboardOffset > 50 ? keyboardOffset : 0;
  const terminalShellRef = useRef<HTMLDivElement | null>(null);
  const terminalViewportRef = useRef<HTMLDivElement | null>(null);
  const mobileInputBarRef = useRef<HTMLDivElement | null>(null);
  const copyButtonRef = useRef<HTMLButtonElement | null>(null);
  const {
    ctrlActive: mobileCtrlActive,
    altActive: mobileAltActive,
    clear: clearMobileModifiers,
    toggleCtrl: toggleMobileCtrl,
    toggleAlt: toggleMobileAlt,
    transformInput: transformMobileInput
  } = useMobileTerminalModifiers();

  // Display is the device's, carried across panes (useUIStore). On Auto the
  // terminal is fitted to this screen while it is the one used last: given
  // back to a terminal on its window used since (the server says so on its socket), it
  // shows the pane's own size until it is used again here.
  const storedDisplay = useUIStore((s) => s.terminalDisplay);
  const setDisplay = useUIStore((s) => s.setTerminalDisplay);
  const display = displayHere(storedDisplay, isMobile);
  const auto = display === "auto";
  const [usedLast, setUsedLast] = useState(true);
  const fitBrowser = display === "screen" || (auto && usedLast);
  const fitWidth = display === "small";
  // Used here: on Auto, given back, it is fitted again; fitted, the server
  // hears so each time (its fit asked again, ahead of what is typed: a
  // window another pane's viewer took comes back before the keys reach it).
  const autoRef = useRef(auto);
  const usedLastRef = useRef(usedLast);
  const shownRef = useRef(shown);
  const sendFitLater = useRef<(() => void) | null>(null);
  const noteUseRef = useRef<() => void>(() => {});
  useEffect(() => {
    autoRef.current = auto;
    usedLastRef.current = usedLast;
    shownRef.current = shown;
  }, [auto, usedLast, shown]);
  const used = useCallback(() => {
    if (!autoRef.current || !shownRef.current) return;
    noteUseRef.current();
    if (!usedLastRef.current) {
      usedLastRef.current = true;
      setUsedLast(true);
      return;
    }
    sendFitLater.current?.();
  }, []);
  // Given back to a terminal on its window used since (the server's word on
  // this terminal's own socket, ahead of anything after it): the server let
  // the window go; this one shows the pane's own size, the one the notice
  // brings until a snapshot newer than the size it had says otherwise
  // (painted only once it has taken it: it lets go after resizing, below,
  // and a fit it asked for as the notice came would be its own again).
  const [restored, setRestored] = useState<{ cols: number; rows: number; over: { cols: number; rows: number } } | null>(null);
  const paneRef = useRef(pane);
  useEffect(() => {
    paneRef.current = pane;
  }, [pane]);
  const heardFromServer = useCallback((message: TerminalControl) => {
    if (message.type !== "given-back" || !autoRef.current || !usedLastRef.current) return false;
    const current = paneRef.current;
    if (message.cols && message.rows && current) {
      setRestored({ cols: message.cols, rows: message.rows, over: { cols: current.paneWidth ?? 0, rows: current.paneHeight ?? 0 } });
    }
    usedLastRef.current = false;
    setUsedLast(false);
    return true;
  }, []);
  // Kept hidden behind another tab (kept-terminals.ts), a terminal leaves
  // the pane's size and the phone's keyboard to the one shown: it sends no
  // size, and nothing lifts or scrolls it. Fitted, it lets its window go
  // (with the grace that lets the one shown take the same window at once)
  // and asks for none, even to reconnect.
  const session = useTerminalSession(pane, {
    transformInput: transformMobileInput,
    initialFitBrowser: fitBrowser,
    fitWidth,
    requestWebFit: fitBrowser && shown,
    requestAuto: auto,
    onActivity: used,
    onControl: heardFromServer,
    expectPid
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
    scrollToBottom: scrollTerminalToBottom,
    active: shown
  });
  // The notice's size: gone for good once used again, or once a snapshot brings a newer size.
  useEffect(() => {
    if (usedLast) setRestored(null);
  }, [usedLast]);
  useEffect(() => {
    if (restored && pane && ((pane.paneWidth ?? 0) !== restored.over.cols || (pane.paneHeight ?? 0) !== restored.over.rows)) setRestored(null);
  }, [pane, restored]);
  // Used again, it is fitted: the notice's size is gone in that same render.
  const sizedPane = useMemo(() => {
    if (!pane || !restored || usedLast || (pane.paneWidth ?? 0) !== restored.over.cols || (pane.paneHeight ?? 0) !== restored.over.rows) return pane;
    return { ...pane, paneWidth: restored.cols, paneHeight: restored.rows };
  }, [pane, restored, usedLast]);

  const sendFit = session.sendFit;
  const sendFitHere = useCallback((next: Parameters<typeof sendFit>[0]) => sendFit(next, { auto }), [sendFit, auto]);
  const { geometry } = useTerminalGeometry({
    pane: sizedPane,
    fitWidth,
    fitBrowser,
    mobileKeyboardOpen: keyboardOpen,
    containerRef: session.containerRef,
    terminalRef: session.terminalRef,
    fitAddonRef: session.fitAddonRef,
    onResize: shown ? (fitBrowser ? sendFitHere : session.sendResize) : undefined
  });
  const sendFitRef = useRef(session.sendFit);
  const noteUse = session.noteUse;
  useEffect(() => {
    noteUseRef.current = noteUse;
  }, [noteUse]);
  useEffect(() => {
    sendFitRef.current = sendFit;
    sendFitLater.current = () => sendFit(geometry.current, { auto: true });
  }, [sendFit, geometry]);
  // Shown again (on Auto, being looked at again counts as being used), a
  // fitted terminal asks for its fit: another pane's viewer may have taken
  // its window meanwhile, or the browser changed size (the server answers
  // at once when neither happened).
  const shownBefore = useRef(shown);
  useEffect(() => {
    const showing = shown && !shownBefore.current;
    shownBefore.current = shown;
    if (!showing) return;
    noteUse();
    if (auto && !usedLast) setUsedLast(true);
    else if (fitBrowser) sendFit(geometry.current, { auto });
  }, [shown, fitBrowser, auto, usedLast, sendFit, geometry, noteUse]);
  // On Auto, the page back in view (another app or window left for this
  // one) is this terminal used again.
  useEffect(() => {
    if (!shown || !auto) return undefined;
    const back = () => { if (document.visibilityState === "visible") used(); };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [shown, auto, used]);
  // No longer fitted, it lets its window go: hidden behind another tab with
  // the grace that lets the one shown take the same window; otherwise at
  // once (switched to the pane's size, or given back).
  const wantsFit = fitBrowser && shown;
  const wantedFit = useRef(wantsFit);
  useEffect(() => {
    const before = wantedFit.current;
    wantedFit.current = wantsFit;
    if (before && !wantsFit) sendFit(null, shown ? {} : { grace: true });
  }, [wantsFit, shown, sendFit]);
  // Fitted, switched between Auto and This screen: the server hears which,
  // as only Auto is given back.
  const autoBefore = useRef(auto);
  useEffect(() => {
    const switched = autoBefore.current !== auto;
    autoBefore.current = auto;
    if (switched && wantsFit) sendFit(geometry.current, { auto });
  }, [auto, wantsFit, sendFit, geometry]);

  useEffect(() => {
    clearMobileModifiers();
    setKeysVisible(false);
    // Display is persisted via useUIStore — not reset on pane change; the
    // user's choice carries across terminals.
  }, [clearMobileModifiers, pane?.paneId]);

  useEffect(() => {
    if (!keysVisible) clearMobileModifiers();
  }, [clearMobileModifiers, keysVisible]);

  const { selectionHandles, copyPlace, beginSelectionHandleDrag } = useSelectionPlacement({
    isMobile,
    terminalRef: session.terminalRef,
    selectionPosition: session.selectionPosition,
    hasSelection: session.hasSelection,
    terminalShellRef,
    terminalViewportRef,
    terminalContainerRef,
    copyButtonRef,
    mobileInputBarRef,
    layout: { fitBrowser, fitWidth, keyboardOpen, keysVisible, lift: terminalLift }
  });

  useEffect(() => () => {
    sendFitRef.current(null);
  }, [pane?.paneId]);

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

  const controlsSlot = useTerminalControlsSlot();
  // Copied, the Copy button says so in its place for a moment. Text selected
  // again takes the place back at once.
  const [copiedPlace, setCopiedPlace] = useState<{ left: number; top: number } | null>(null);
  const copiedTimer = useRef<number | null>(null);
  if (copiedPlace && session.hasSelection) setCopiedPlace(null);
  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);
  useEffect(() => {
    setCopiedPlace(null);
  }, [pane?.paneId]);
  const handleCopySelection = async () => {
    const place = copyPlace;
    const text = await session.copySelection({ restoreFocus: !isMobile });
    if (!text) {
      toast.error("Couldn't copy — clipboard permission denied?");
      return;
    }
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    setCopiedPlace(place);
    copiedTimer.current = window.setTimeout(() => {
      copiedTimer.current = null;
      setCopiedPlace(null);
    }, COPIED_MS);
  };

  // On a desktop Show keys or Hide keys leaves the terminal focused, from
  // the header's button or once the ⋯ menu has closed (it gives the focus
  // back to its own button otherwise). A phone keeps its keyboard closed.
  const refocusAfterMenu = useRef(false);
  const toggleKeysVisible = () => {
    setKeysVisible((v) => !v);
    if (isMobile) return;
    refocusAfterMenu.current = true;
    requestAnimationFrame(() => session.focusTerminal());
  };
  const onMenuCloseAutoFocus = (event: Event) => {
    if (!refocusAfterMenu.current) return;
    refocusAfterMenu.current = false;
    event.preventDefault();
    session.focusTerminal();
  };
  const control: TerminalControlProps = {
    isMobile,
    status: session.status,
    windowZoomed,
    display: storedDisplay,
    keysVisible,
    onDisplay: (next) => {
      // Chosen (Auto again, given back, included): it is used here.
      noteUse();
      if (next === "auto") setUsedLast(true);
      setDisplay(next);
    },
    onToggleKeysVisible: toggleKeysVisible,
    onRefresh: session.sendRefresh,
    onMenuCloseAutoFocus
  };
  return (
    <div className="relative flex flex-1 flex-col h-full min-h-0 bg-terminal-bg">
      {controlsSlot === undefined
        ? <TerminalHeader {...control} titleText={header.titleText} path={header.path} switcher={header.switcher} />
        : controlsSlot && shown && createPortal(<TerminalControls {...control} place={header.path} pin={header.pin} move={header.move} />, controlsSlot)}
      {session.status === "closed" ? <TerminalClosedNotice /> : (
        <TerminalShell
          ref={terminalShellRef}
          isMobile={isMobile}
          firstPaintReady={session.firstPaintReady}
          scrolledBack={session.scrolledBack}
          hasSelection={session.hasSelection}
          keysVisible={keysVisible}
          selectionHandles={selectionHandles}
          copyPlace={copyPlace}
          copyButtonRef={copyButtonRef}
          copiedPlace={copiedPlace}
          terminalShellStyle={Object.keys(terminalShellStyle).length > 0 ? terminalShellStyle : undefined}
          terminalViewportRef={terminalViewportRef}
          terminalContainerRef={terminalContainerRef}
          onScrollToBottom={session.scrollToBottom}
          onCopySelection={handleCopySelection}
          onBeginSelectionHandleDrag={beginSelectionHandleDrag}
        />
      )}
      {children}
      {/* The keys: on a phone over the terminal's foot, lifted above the
          keyboard (the terminal lifts out of their way); on a desktop under
          the terminal, which gives them its room. */}
      {keysVisible && session.status !== "closed" && (
        <div ref={mobileInputBarRef} className={isMobile ? "absolute inset-x-0 bottom-0 z-40" : "shrink-0"} style={isMobile && keyboardLift > 0 ? { bottom: keyboardLift } : undefined}>
          <MobileInputBar
            sendInput={session.sendInput}
            focusTerminal={session.focusTerminal}
            keepTerminalFocused={!isMobile}
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
