import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { TERMINAL_LINE_HEIGHT, readTerminalCellSize } from "@/lib/terminal-helpers";

export function useTerminalMobileKeyboardLayout({
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
  terminalRef,
  scrolledBack,
  hasSelection,
  scrollToBottom,
  active = true
}: {
  isMobile: boolean;
  keysVisible: boolean;
  keyboardOpen: boolean;
  keyboardHeight: number;
  keyboardLift: number;
  fitBrowser: boolean;
  terminalShellRef: RefObject<HTMLDivElement | null>;
  terminalViewportRef: RefObject<HTMLDivElement | null>;
  mobileInputBarRef: RefObject<HTMLDivElement | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  scrolledBack: boolean;
  hasSelection: boolean;
  scrollToBottom: () => void;
  /** False while kept hidden behind another tab: nothing measures or
   *  scrolls it then. Shown again, its lift is measured for the screen as it
   *  is now (another tab may have changed its font), and it stays where the
   *  reader left it. */
  active?: boolean;
}) {
  const terminalLiftRef = useRef(0);
  const seenRef = useRef({ shown: false, hiddenSince: false });
  const [terminalLift, setTerminalLift] = useState(0);
  const [stableTerminalHeight, setStableTerminalHeight] = useState<number | null>(null);

  useEffect(() => {
    const shell = terminalShellRef.current;
    if (!shell) return;
    const update = () => {
      if (keyboardOpen) return;
      const height = shell.getBoundingClientRect().height;
      if (!Number.isFinite(height) || height <= 0) return;
      setStableTerminalHeight((prev) => Math.abs((prev ?? 0) - height) < 1 ? prev : height);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [keyboardOpen, terminalShellRef]);

  useEffect(() => {
    if (!active) {
      if (seenRef.current.shown) seenRef.current.hiddenSince = true;
      return;
    }
    const resumed = seenRef.current.hiddenSince;
    seenRef.current = { shown: true, hiddenSince: false };
    let cancelled = false;
    const shouldLift = keyboardOpen || (isMobile && keysVisible);
    if (!shouldLift) {
      terminalLiftRef.current = 0;
      queueMicrotask(() => {
        if (!cancelled) setTerminalLift(0);
      });
      return () => {
        cancelled = true;
      };
    }

    const measure = () => {
      const viewport = terminalViewportRef.current;
      if (!resumed) {
        viewport?.scrollTo({ top: viewport.scrollHeight, left: viewport.scrollLeft });
        scrollToBottom();
      }

      const screen = terminalContainerRef.current?.querySelector(".xterm-screen") as HTMLElement | null;
      const target = screen ?? terminalContainerRef.current ?? viewport;
      if (!target) return;

      const terminal = terminalRef.current;
      const targetRect = target.getBoundingClientRect();
      const anchor = (() => {
        if (!screen || !terminal) return { top: targetRect.top, bottom: targetRect.bottom };
        const cellHeight = readTerminalCellSize(terminal)?.height
          ?? Number(terminal.options.fontSize) * TERMINAL_LINE_HEIGHT;
        if (!Number.isFinite(cellHeight) || cellHeight <= 0) return { top: targetRect.top, bottom: targetRect.bottom };
        const cursorY = terminal.buffer.active.cursorY;
        if (!Number.isFinite(cursorY) || cursorY < 0) return { top: targetRect.top, bottom: targetRect.bottom };
        const screenRect = screen.getBoundingClientRect();
        const top = screenRect.top + cursorY * cellHeight;
        return {
          top: Math.max(targetRect.top, top),
          bottom: Math.min(targetRect.bottom, top + cellHeight)
        };
      })();

      const vv = window.visualViewport;
      const barHeight = isMobile && keysVisible
        ? (mobileInputBarRef.current?.getBoundingClientRect().height ?? 0)
        : 0;
      const visualTop = vv ? vv.offsetTop : 0;
      const visualBottom = vv ? vv.offsetTop + vv.height : window.innerHeight - keyboardLift;
      const visibleBottom = visualBottom - barHeight;
      const currentLift = terminalLiftRef.current;
      const unliftedTop = anchor.top + currentLift;
      const unliftedBottom = anchor.bottom + currentLift;
      const desiredLift = Math.max(0, Math.ceil(unliftedBottom - visibleBottom + 8));
      const maxLiftBeforeAnchorLeavesTop = Math.max(0, Math.floor(unliftedTop - visualTop - 8));
      const nextLift = Math.min(desiredLift, maxLiftBeforeAnchorLeavesTop);
      terminalLiftRef.current = nextLift;
      setTerminalLift((prev) => prev === nextLift ? prev : nextLift);
    };

    const frame = requestAnimationFrame(measure);
    const timers = [80, 180, 320].map((delay) => window.setTimeout(measure, delay));
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    isMobile,
    keysVisible,
    keyboardOpen,
    keyboardHeight,
    keyboardLift,
    mobileInputBarRef,
    terminalContainerRef,
    terminalRef,
    terminalViewportRef,
    scrollToBottom,
    active
  ]);

  // On a desktop the keys sit under the terminal and shorten its room, which
  // a terminal not fitted to the browser keeps its rows through. Its viewport
  // cuts what does not fit; it is scrolled just far enough to keep the
  // cursor's row in it, as the cursor moves and the terminal or its room
  // changes size. Hidden, the keys give the room back, and the top with it.
  useEffect(() => {
    if (isMobile || !active) return;
    const viewport = terminalViewportRef.current;
    const terminal = terminalRef.current;
    if (!viewport) return;
    if (!keysVisible || !terminal) {
      viewport.scrollTop = 0;
      return;
    }
    let frame = 0;
    const keepCursorInView = () => {
      frame = 0;
      const buffer = terminal.buffer.active;
      // Read back in its history, the cursor's row is not on the screen.
      if (buffer.viewportY !== buffer.baseY) return;
      const screen = terminalContainerRef.current?.querySelector(".xterm-screen");
      const cellHeight = readTerminalCellSize(terminal)?.height ?? Number(terminal.options.fontSize) * TERMINAL_LINE_HEIGHT;
      if (!screen || !Number.isFinite(cellHeight) || cellHeight <= 0) return;
      const margin = 8;
      const top = screen.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop + buffer.cursorY * cellHeight;
      const bottom = top + cellHeight;
      if (bottom + margin > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom + margin - viewport.clientHeight;
      else if (top - margin < viewport.scrollTop) viewport.scrollTop = Math.max(0, top - margin);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(keepCursorInView);
    };
    schedule();
    const subscriptions = [terminal.onCursorMove(schedule), terminal.onResize(schedule), terminal.onScroll(schedule)];
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      subscriptions.forEach((subscription) => subscription.dispose());
      observer.disconnect();
    };
  }, [isMobile, active, keysVisible, terminalRef, terminalViewportRef, terminalContainerRef]);

  useEffect(() => {
    if (!isMobile) return;
    const container = terminalContainerRef.current;
    if (!container) return;
    const shouldKeepKeyboardClosed = () => scrolledBack || hasSelection;
    const blurTerminalInput = () => {
      if (!shouldKeepKeyboardClosed()) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLTextAreaElement)) return;
      if (!active.classList.contains("xterm-helper-textarea")) return;
      if (!container.contains(active)) return;
      active.blur();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!shouldKeepKeyboardClosed()) return;
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (!target.classList.contains("xterm-helper-textarea")) return;
      target.blur();
    };
    const onPointerIntent = () => {
      if (!shouldKeepKeyboardClosed()) return;
      window.setTimeout(blurTerminalInput, 0);
      requestAnimationFrame(blurTerminalInput);
    };
    container.addEventListener("focusin", onFocusIn, true);
    container.addEventListener("mousedown", onPointerIntent, true);
    container.addEventListener("touchstart", onPointerIntent, { capture: true, passive: true });
    return () => {
      container.removeEventListener("focusin", onFocusIn, true);
      container.removeEventListener("mousedown", onPointerIntent, true);
      container.removeEventListener("touchstart", onPointerIntent, true);
    };
  }, [isMobile, terminalContainerRef, scrolledBack, hasSelection]);

  return {
    terminalLift,
    stableTerminalHeight,
    lockTerminalHeightForKeyboard: isMobile && fitBrowser && keyboardOpen && stableTerminalHeight !== null
  };
}
