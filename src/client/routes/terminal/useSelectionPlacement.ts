import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSelectionRange } from "@/hooks/useTerminalSession";
import { readTerminalBlockSelection } from "@/lib/terminal-helpers";
import {
  clientToSelectionBoundary,
  copyButtonPlace,
  rangeBoundary,
  selectBetweenBoundaries,
  selectionHandleGeometry,
  type SelectionHandleGeometry,
  type SelectionHandleKind
} from "./terminal-helpers";

/** A phone's end handle reaches this far under the selection's last line. */
const END_HANDLE_REACH = 44;

/** What goes with a terminal selection, kept on it as the terminal scrolls,
 *  resizes or refits: a phone's two handles at its ends, dragged to move
 *  either end (a desktop has none), and at every width its Copy button,
 *  beside it as a phone's own copy menu is, out of sight while a pointer
 *  makes or moves the selection. */
export function useSelectionPlacement(input: {
  isMobile: boolean;
  terminalRef: RefObject<Terminal | null>;
  selectionPosition: TerminalSelectionRange | null;
  hasSelection: boolean;
  terminalShellRef: RefObject<HTMLDivElement | null>;
  terminalViewportRef: RefObject<HTMLDivElement | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  /** The Copy button, measured to place it. */
  copyButtonRef: RefObject<HTMLButtonElement | null>;
  /** A phone's key bar, over the terminal's foot while shown. */
  mobileInputBarRef: RefObject<HTMLDivElement | null>;
  /** Layout that moves the grid: what goes with it is placed again when any
   *  changes. `lift`: how far a phone's terminal is lifted out of the way of
   *  its keys or keyboard, applied after they show. */
  layout: { fitBrowser: boolean; fitWidth: boolean; keyboardOpen: boolean; keysVisible: boolean; lift: number };
}) {
  const { isMobile, terminalRef, selectionPosition, terminalShellRef, terminalViewportRef, terminalContainerRef, copyButtonRef, mobileInputBarRef } = input;
  const [selectionHandles, setSelectionHandles] = useState<SelectionHandleGeometry | null>(null);
  const [copyPlace, setCopyPlace] = useState<{ left: number; top: number } | null>(null);
  // Read by the placing, which a handle's drag calls as it was when the
  // drag began; the state places again when it lifts.
  const pointerDownRef = useRef(false);
  const [pointerDown, setPointerDownState] = useState(false);
  const setPointerDown = useCallback((down: boolean) => {
    pointerDownRef.current = down;
    setPointerDownState(down);
  }, []);
  const selectionDragCleanupRef = useRef<(() => void) | null>(null);

  const { fitBrowser, fitWidth, keyboardOpen, keysVisible, lift } = input.layout;
  const updateSelectionHandles = useCallback(() => {
    const terminal = terminalRef.current;
    const shell = terminalShellRef.current;
    const viewport = terminalViewportRef.current;
    const range = terminal?.getSelectionPosition() ?? selectionPosition;
    const grid = terminal?.element?.querySelector<HTMLElement>(".xterm-screen") ?? terminal?.element;
    const gridRect = grid?.getBoundingClientRect();
    if (!terminal?.hasSelection() || !range || !shell || !viewport || !gridRect) {
      setSelectionHandles(null);
      setCopyPlace(null);
      return;
    }

    const shellRect = shell.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const placed = { range, grid: gridRect, shell: shellRect, cols: terminal.cols, rows: terminal.rows, viewportY: terminal.buffer.active.viewportY };
    setSelectionHandles(isMobile ? selectionHandleGeometry({ ...placed, viewport: viewportRect }) : null);

    const button = copyButtonRef.current;
    if (!button || pointerDownRef.current) {
      setCopyPlace(null);
      return;
    }
    // A phone's key bar lies over the terminal's foot: the room ends above it.
    const bar = isMobile && keysVisible ? mobileInputBarRef.current?.getBoundingClientRect() : null;
    const bottom = bar ? Math.min(viewportRect.bottom, bar.top) : viewportRect.bottom;
    const room = { left: viewportRect.left, right: viewportRect.right, width: viewportRect.width, top: viewportRect.top, bottom, height: bottom - viewportRect.top };
    const next = copyButtonPlace({
      ...placed,
      room,
      size: { width: button.offsetWidth, height: button.offsetHeight },
      clearBelow: isMobile ? END_HANDLE_REACH : 0,
      block: readTerminalBlockSelection(terminal)
    });
    setCopyPlace((prev) => prev && next && prev.left === next.left && prev.top === next.top ? prev : next);
  }, [isMobile, keysVisible, selectionPosition, terminalRef, terminalShellRef, terminalViewportRef, copyButtonRef, mobileInputBarRef]);

  useLayoutEffect(() => {
    updateSelectionHandles();
  }, [updateSelectionHandles, fitBrowser, fitWidth, keyboardOpen, keysVisible, lift, input.hasSelection, pointerDown]);

  useEffect(() => {
    const viewport = terminalViewportRef.current;
    // The same terminal while this is mounted: a new one comes with a new
    // mount (LiveTerminal keys it by pane and process).
    const terminal = terminalRef.current;
    if (!viewport) return;
    const update = () => updateSelectionHandles();
    viewport.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    // The terminal's own scroll: its history, or output moving the screen up.
    const scrolled = terminal?.onScroll(update);
    // The grid's own size, a refit (a new font, rows or columns) applied
    // after this places; and the room it shows in, which a panel or the
    // sidebar resizes with no window resize.
    const screen = terminal?.element?.querySelector(".xterm-screen");
    const resized = new ResizeObserver(update);
    if (screen) resized.observe(screen);
    resized.observe(viewport);
    return () => {
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      scrolled?.dispose();
      resized.disconnect();
    };
  }, [terminalRef, terminalViewportRef, updateSelectionHandles]);

  // A pointer down on the terminal makes a selection (a mouse's drag, a
  // phone's long press) or scrolls it: the Copy button waits for it to lift.
  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) return;
    const down = (event: PointerEvent) => {
      if (event.button === 0) setPointerDown(true);
    };
    const up = () => setPointerDown(false);
    container.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    return () => {
      container.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
    };
  }, [terminalContainerRef, setPointerDown]);

  useEffect(() => () => {
    selectionDragCleanupRef.current?.();
    selectionDragCleanupRef.current = null;
  }, []);

  const beginSelectionHandleDrag = (
    kind: SelectionHandleKind,
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    const terminal = terminalRef.current;
    const range = terminal?.getSelectionPosition() ?? selectionPosition;
    if (!terminal || !range) return;
    event.preventDefault();
    event.stopPropagation();
    terminal.blur();

    selectionDragCleanupRef.current?.();
    setPointerDown(true);
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
      setPointerDown(false);
    };
    selectionDragCleanupRef.current = stopDrag;
    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("pointerup", stopDrag);
    document.addEventListener("pointercancel", stopDrag);
  };

  return { selectionHandles, copyPlace, beginSelectionHandleDrag };
}
