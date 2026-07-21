import { useCallback, useEffect, useRef } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import type { SnapshotPane } from "@/lib/snapshot-types";
import {
  TERMINAL_FONT_SIZE,
  MOBILE_WEB_FIT_WIDTH_COLS,
  paneTerminalGeometry,
  terminalDimension,
  terminalBrowserFitGeometry,
  terminalMeasuredFitGeometry,
  terminalFitWidthFontSize,
  isMobileTerminalViewport,
  type TerminalGeometry
} from "@/lib/terminal-helpers";

const MOBILE_WEB_FIT_RESIZE_SETTLE_MS = 180;

interface UseTerminalGeometryOptions {
  pane: SnapshotPane | null | undefined;
  fitWidth: boolean;
  fitBrowser: boolean;
  mobileKeyboardOpen?: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.RefObject<Terminal | null>;
  fitAddonRef: React.RefObject<FitAddon | null>;
  onResize?: (geometry: TerminalGeometry) => void;
}

export function useTerminalGeometry({
  pane,
  fitWidth,
  fitBrowser,
  mobileKeyboardOpen = false,
  containerRef,
  terminalRef,
  fitAddonRef,
  onResize
}: UseTerminalGeometryOptions) {
  const geometryRef = useRef<TerminalGeometry>(paneTerminalGeometry(pane));
  const fitBrowserRef = useRef(fitBrowser);
  const mobileKeyboardOpenRef = useRef(mobileKeyboardOpen);

  useEffect(() => {
    mobileKeyboardOpenRef.current = mobileKeyboardOpen;
  }, [mobileKeyboardOpen]);

  // xterm's grid (cols × rows) MUST match the tmux pane's actual size.
  // Programs running inside the pane (Claude Code, vim, htop, etc.) emit
  // bytes positioned for tmux's pane geometry — if xterm is bigger, the
  // status bar / input box land in the middle of the screen with empty
  // rows below; if smaller, content gets cropped. In fitBrowser mode the
  // browser becomes the source of truth and the server resizes tmux to
  // this computed grid; otherwise the pane's existing tmux geometry wins.
  // On mobile Web fit uses the real browser width by default. The user can
  // additionally enable fitWidth to keep an 80-column layout squeezed into
  // the device width.
  const apply = useCallback((): TerminalGeometry => {
    const terminal = terminalRef.current;
    const paneTarget = paneTerminalGeometry(pane);
    if (!terminal) return paneTarget;

    const mobile = isMobileTerminalViewport();
    if (fitBrowser) {
      terminal.options.fontSize = mobile && fitWidth
        ? terminalFitWidthFontSize(containerRef.current, MOBILE_WEB_FIT_WIDTH_COLS)
        : TERMINAL_FONT_SIZE;
    } else if (mobile && fitWidth) {
      terminal.options.fontSize = terminalFitWidthFontSize(containerRef.current, paneTarget.cols);
    } else {
      terminal.options.fontSize = TERMINAL_FONT_SIZE;
    }

    const proposed = fitBrowser
      ? (terminalMeasuredFitGeometry(terminal, fitAddonRef.current, containerRef.current, pane, { fitWidth })
        ?? terminalBrowserFitGeometry(containerRef.current, pane, { fitWidth }))
      : undefined;
    const minCols = fitBrowser && mobile && fitWidth ? MOBILE_WEB_FIT_WIDTH_COLS : 20;
    const target = proposed
      ? {
          cols: terminalDimension(proposed.cols, paneTarget.cols, minCols, 300),
          rows: terminalDimension(proposed.rows, paneTarget.rows, 8, 200)
        }
      : paneTarget;
    const stableTarget = fitBrowser && mobile && mobileKeyboardOpenRef.current
      ? geometryRef.current
      : target;

    if (!fitBrowser && mobile && fitWidth) {
      terminal.options.fontSize = terminalFitWidthFontSize(containerRef.current, stableTarget.cols);
    }
    if (terminal.cols !== stableTarget.cols || terminal.rows !== stableTarget.rows) {
      terminal.resize(stableTarget.cols, stableTarget.rows);
    }
    return stableTarget;
  }, [pane, fitWidth, fitBrowser, containerRef, terminalRef, fitAddonRef]);

  // Schedule resize on container changes via ResizeObserver — only the
  // font may need rescaling for fitWidth unless fitBrowser is active.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let frame: number | null = null;
    let timer: number | null = null;

    const clearFrame = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const run = () => {
      frame = null;
      timer = null;
      const next = apply();
      const prev = geometryRef.current;
      if (next.cols !== prev.cols || next.rows !== prev.rows) {
        geometryRef.current = next;
        onResize?.(next);
      }
    };
    const scheduleFrame = () => {
      clearFrame();
      frame = requestAnimationFrame(() => {
        run();
      });
    };
    const schedule = () => {
      // Mobile soft-keyboard open/close emits a burst of visualViewport and
      // ResizeObserver updates while the browser animates the content area.
      // In Web fit, every intermediate grid would resize tmux and force TUIs
      // to redraw. Wait for the viewport to settle and send one final size.
      if (fitBrowser && isMobileTerminalViewport()) {
        clearFrame();
        clearTimer();
        timer = window.setTimeout(scheduleFrame, MOBILE_WEB_FIT_RESIZE_SETTLE_MS);
        return;
      }
      clearTimer();
      scheduleFrame();
    };
    const observer = new ResizeObserver(() => {
      schedule();
    });
    observer.observe(container);
    const viewport = fitBrowser ? window.visualViewport : null;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      observer.disconnect();
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      clearFrame();
      clearTimer();
    };
  }, [apply, containerRef, fitBrowser, onResize]);

  // Re-apply when fitWidth or pane changes
  useEffect(() => {
    const next = apply();
    const prev = geometryRef.current;
    const modeChanged = fitBrowserRef.current !== fitBrowser;
    fitBrowserRef.current = fitBrowser;
    if (modeChanged || next.cols !== prev.cols || next.rows !== prev.rows) {
      geometryRef.current = next;
      onResize?.(next);
    }
  }, [apply, fitBrowser, onResize]);

  return {
    geometry: geometryRef,
    apply
  };
}
