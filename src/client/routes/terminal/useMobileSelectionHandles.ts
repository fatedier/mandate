import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSelectionRange } from "@/hooks/useTerminalSession";
import {
  clientToSelectionBoundary,
  rangeBoundary,
  selectBetweenBoundaries,
  selectionHandleGeometry,
  type SelectionHandleGeometry,
  type SelectionHandleKind
} from "./terminal-helpers";

/** The two handles a phone draws at a terminal selection's ends, kept on
 *  them as the terminal scrolls, resizes or refits, and dragged to move
 *  either end. Desktop has none. */
export function useMobileSelectionHandles(input: {
  isMobile: boolean;
  terminalRef: RefObject<Terminal | null>;
  selectionPosition: TerminalSelectionRange | null;
  hasSelection: boolean;
  terminalShellRef: RefObject<HTMLDivElement | null>;
  terminalViewportRef: RefObject<HTMLDivElement | null>;
  /** Layout that moves the grid: the handles are placed again when any changes. */
  layout: { fitBrowser: boolean; fitWidth: boolean; keyboardOpen: boolean; keysVisible: boolean };
}) {
  const { isMobile, terminalRef, selectionPosition, terminalShellRef, terminalViewportRef } = input;
  const [selectionHandles, setSelectionHandles] = useState<SelectionHandleGeometry | null>(null);
  const selectionDragCleanupRef = useRef<(() => void) | null>(null);

  const terminal = terminalRef.current;
  const updateSelectionHandles = useCallback(() => {
    const shell = terminalShellRef.current;
    const viewport = terminalViewportRef.current;
    const range = terminal?.getSelectionPosition() ?? selectionPosition;
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

    setSelectionHandles(selectionHandleGeometry({
      range,
      grid: gridRect,
      shell: shell.getBoundingClientRect(),
      viewport: viewport.getBoundingClientRect(),
      cols: terminal.cols,
      rows: terminal.rows,
      viewportY: terminal.buffer.active.viewportY
    }));
  }, [isMobile, selectionPosition, terminal, terminalShellRef, terminalViewportRef]);

  const { fitBrowser, fitWidth, keyboardOpen, keysVisible } = input.layout;
  useLayoutEffect(() => {
    updateSelectionHandles();
  }, [updateSelectionHandles, fitBrowser, fitWidth, keyboardOpen, keysVisible, input.hasSelection]);

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
  }, [isMobile, terminalViewportRef, updateSelectionHandles]);

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

  return { selectionHandles, beginSelectionHandleDrag };
}
