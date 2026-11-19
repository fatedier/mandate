import type { Terminal } from "@xterm/xterm";
import { TERMINAL_LINE_HEIGHT } from "@/lib/terminal-helpers";
import { createWheelStepper, reportsWheel, scrollRoute, sgrWheelReport } from "./terminal-scroll-routing";

interface TerminalTouchCell {
  col: number;
  row: number;
}

/** A wheel report moves a program about three lines (Codex scrolls three per
 *  report, as terminals conventionally do), so one goes out per three lines
 *  of finger or wheel travel and the content keeps pace with the gesture. */
const LINES_PER_WHEEL_REPORT = 3;

export function attachTerminalScrollHandlers(
  container: HTMLElement,
  terminal: Terminal,
  options: {
    /** Raw input to the program, bypassing any input transform. */
    sendInput: (data: string) => void;
    /** Whether the pane's program reads wheel reports without asking. */
    readsWheel: () => boolean;
  }
) {
  const route = () => scrollRoute({
    alternate: terminal.buffer.active.type === "alternate",
    mouseTracking: terminal.modes.mouseTrackingMode,
    readsWheel: options.readsWheel()
  });
  const wheelSteps = createWheelStepper(LINES_PER_WHEEL_REPORT);
  const sendWheelReports = (steps: number, clientX: number, clientY: number) => {
    const cell = viewportCellAt(clientX, clientY);
    if (!cell) return;
    const report = sgrWheelReport(steps < 0 ? -1 : 1, cell.col + 1, cell.row + 1);
    for (let i = 0; i < Math.abs(steps); i += 1) options.sendInput(report);
  };
  // xterm decides what a wheel means to the program (its mouse protocol, or
  // arrows in the alternate screen, with DECCKM); a drag hands it one line at
  // a time as a wheel would.
  // Set while a drag's own wheel events pass through xterm, so the wheel
  // handler below leaves them to xterm and to the drag's own bookkeeping.
  let forwarding = false;
  const forwardToXterm = (count: number, clientX: number, clientY: number) => {
    const screen = terminal.element?.querySelector(".xterm-screen");
    if (!screen) return;
    forwarding = true;
    try {
      for (let i = 0; i < Math.abs(count); i += 1) {
        screen.dispatchEvent(new WheelEvent("wheel", {
          deltaY: count < 0 ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX, clientY, bubbles: true, cancelable: true
        }));
      }
    } finally {
      forwarding = false;
    }
  };

  // The one case xterm's own wheel handling gets wrong: in the alternate
  // screen it sends arrows, and a program that reads wheel reports without
  // asking (Codex) takes an arrow as its previous prompt.
  terminal.attachCustomWheelEventHandler((event) => {
    if (forwarding) return true;
    const where = route();
    if (where !== "wheel-report") {
      // Noted, so a remainder left for the program never outlives a switch.
      wheelSteps.add(0, where);
      return true;
    }
    // A mostly sideways wheel is a pan, not a scroll: kept from xterm, which
    // would turn its vertical drift into an arrow (a recalled prompt), and
    // left to the page to pan.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
    // Handled here: kept from the container's history scroll below too, which
    // would only redraw a screen that has no history.
    event.preventDefault();
    event.stopPropagation();
    const steps = wheelSteps.add(wheelLines(event), where);
    if (steps !== 0) sendWheelReports(steps, event.clientX, event.clientY);
    return false;
  });

  const wheelLines = (event: WheelEvent) => {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * terminal.rows;
    return event.deltaY / (gridMetrics()?.cellHeight ?? touchLineHeight());
  };

  const onWheel = (event: WheelEvent) => {
    if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    let lines: number;
    if (event.deltaMode === 1) lines = event.deltaY;
    else if (event.deltaMode === 2) lines = event.deltaY * terminal.rows;
    else lines = event.deltaY / 24;
    const rounded = Math.trunc(lines);
    if (rounded === 0) return;
    event.preventDefault();
    terminal.scrollLines(rounded);
  };

  let touchLastX = 0;
  let touchLastY = 0;
  let touchLineRemainder = 0;
  /** Where the drag's last move went: a fraction of a line left on one
   *  screen does not count toward the program of the next. */
  let touchDestination: string | null = null;
  /** The finger carrying the drag: another one taking over starts afresh. */
  let activeTouch: number | null = null;
  // A program switching screens ends whatever travel was pending for the
  // last one, with or without a scroll in between.
  const bufferChange = terminal.buffer.onBufferChange(() => {
    wheelSteps.reset();
    touchLineRemainder = 0;
  });
  const touchTarget = () => {
    const where = route();
    const wheelReports = where === "xterm" && reportsWheel(terminal.modes.mouseTrackingMode);
    return { where, wheelReports, destination: wheelReports ? "xterm-wheel" : where };
  };
  let longPressStartX = 0;
  let longPressStartY = 0;
  let longPressAnchor: TerminalTouchCell | null = null;
  let longPressTimer: number | null = null;
  let selecting = false;
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_TOLERANCE_PX = 10;

  const cancelLongPress = () => {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };
  const touchLineHeight = () => {
    const fontSize = Number(terminal.options.fontSize);
    if (Number.isFinite(fontSize) && fontSize > 0) return fontSize * TERMINAL_LINE_HEIGHT;
    return 24;
  };
  function gridMetrics() {
    const grid = terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? terminal.element;
    const rect = grid?.getBoundingClientRect();
    if (!rect) return null;
    const cellWidth = rect.width / terminal.cols;
    const measuredCellHeight = rect.height / terminal.rows;
    const cellHeight = measuredCellHeight > 0 ? measuredCellHeight : touchLineHeight();
    if (cellWidth <= 0 || cellHeight <= 0) return null;
    return { rect, cellWidth, cellHeight };
  }
  /** The visible cell under a point, clamped to the screen, 0-based. */
  function viewportCellAt(clientX: number, clientY: number): TerminalTouchCell | null {
    const metrics = gridMetrics();
    if (!metrics) return null;
    return {
      col: clamp(Math.floor((clientX - metrics.rect.left) / metrics.cellWidth), 0, Math.max(terminal.cols - 1, 0)),
      row: clamp(Math.floor((clientY - metrics.rect.top) / metrics.cellHeight), 0, Math.max(terminal.rows - 1, 0))
    };
  }
  const clientToBufferCell = (clientX: number, clientY: number, clampToViewport: boolean): TerminalTouchCell | null => {
    const metrics = gridMetrics();
    if (!metrics) return null;
    const { rect, cellWidth, cellHeight } = metrics;
    const xInside = clientX - rect.left;
    const yInside = clientY - rect.top;
    if (!clampToViewport && (xInside < 0 || xInside >= rect.width || yInside < 0 || yInside >= rect.height)) {
      return null;
    }
    const col = clamp(Math.floor(xInside / cellWidth), 0, Math.max(terminal.cols - 1, 0));
    const rowInViewport = clamp(Math.floor(yInside / cellHeight), 0, Math.max(terminal.rows - 1, 0));
    return { col, row: terminal.buffer.active.viewportY + rowInViewport };
  };
  const selectFromAnchor = (anchor: TerminalTouchCell, target: TerminalTouchCell) => {
    const cols = terminal.cols;
    const anchorIndex = anchor.row * cols + anchor.col;
    const targetIndex = target.row * cols + target.col;
    const start = anchorIndex <= targetIndex ? anchor : target;
    const length = Math.abs(targetIndex - anchorIndex) + 1;
    terminal.select(start.col, start.row, length);
  };
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches.item(0);
    if (!touch) return;
    touchLastX = touch.clientX;
    touchLastY = touch.clientY;
    activeTouch = touch.identifier;
    touchLineRemainder = 0;
    // Where the drag starts going: only a change from here drops travel.
    touchDestination = touchTarget().destination;
    wheelSteps.reset();
    selecting = false;
    longPressStartX = touch.clientX;
    longPressStartY = touch.clientY;
    longPressAnchor = clientToBufferCell(touch.clientX, touch.clientY, false);
    cancelLongPress();
    if (!longPressAnchor) return;
    longPressTimer = window.setTimeout(() => {
      longPressTimer = null;
      if (!longPressAnchor) return;
      selecting = true;
      terminal.blur();
      terminal.select(longPressAnchor.col, longPressAnchor.row, 1);
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches.item(0);
    if (!touch) return;
    // A drag scrolls what a wheel would: the history, or the program. Where
    // that is is settled first, before any move is set aside (a long press,
    // a selection, a sideways move), so travel pending for one destination
    // never reaches another whichever way the gesture got there.
    // A second finger landed and the first lifted: travel is counted from
    // where the remaining finger is, not from where the first one was.
    if (touch.identifier !== activeTouch) {
      activeTouch = touch.identifier;
      touchLastX = touch.clientX;
      touchLastY = touch.clientY;
      touchLineRemainder = 0;
      wheelSteps.reset();
      touchDestination = touchTarget().destination;
      return;
    }
    const { where, wheelReports, destination } = touchTarget();
    if (destination !== touchDestination) {
      touchLineRemainder = 0;
      touchDestination = destination;
      wheelSteps.add(0, destination);
      // Travel is counted from here: pixels moved before the switch (inside
      // the long-press tolerance, say) belong to the old destination.
      touchLastX = touch.clientX;
      touchLastY = touch.clientY;
    }
    if (longPressTimer !== null) {
      const dx = touch.clientX - longPressStartX;
      const dy = touch.clientY - longPressStartY;
      if (Math.hypot(dx, dy) <= LONG_PRESS_TOLERANCE_PX) {
        return;
      }
      cancelLongPress();
    }
    if (selecting && longPressAnchor) {
      event.preventDefault();
      const target = clientToBufferCell(touch.clientX, touch.clientY, true);
      if (target) selectFromAnchor(longPressAnchor, target);
      return;
    }
    if (terminal.hasSelection()) return;
    const deltaX = touch.clientX - touchLastX;
    const deltaY = touchLastY - touch.clientY;
    touchLastX = touch.clientX;
    touchLastY = touch.clientY;
    if (Math.abs(deltaY) < Math.abs(deltaX)) return;

    touchLineRemainder += deltaY / touchLineHeight();
    const lines = Math.trunc(touchLineRemainder);
    if (lines === 0) return;
    touchLineRemainder -= lines;
    event.preventDefault();
    const steps = wheelSteps.add(lines, destination);
    if (where === "history") {
      terminal.scrollLines(lines);
    } else if (where === "wheel-report") {
      sendWheelReports(steps, touch.clientX, touch.clientY);
    } else if (wheelReports) {
      forwardToXterm(steps, touch.clientX, touch.clientY);
    } else {
      // Arrows, one per line, as xterm sends them for the wheel.
      forwardToXterm(lines, touch.clientX, touch.clientY);
    }
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (selecting && longPressAnchor) {
      const touch = event.changedTouches.item(0);
      if (touch) {
        const target = clientToBufferCell(touch.clientX, touch.clientY, true);
        if (target) selectFromAnchor(longPressAnchor, target);
      }
    }
    touchLineRemainder = 0;
    // Travel a drag left short of a step ends with it, not in a later wheel.
    wheelSteps.reset();
    selecting = false;
    longPressAnchor = null;
    cancelLongPress();
  };

  container.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: false });
  container.addEventListener("touchend", onTouchEnd);
  container.addEventListener("touchcancel", onTouchEnd);

  return () => {
    bufferChange.dispose();
    cancelLongPress();
    container.removeEventListener("wheel", onWheel);
    container.removeEventListener("touchstart", onTouchStart);
    container.removeEventListener("touchmove", onTouchMove);
    container.removeEventListener("touchend", onTouchEnd);
    container.removeEventListener("touchcancel", onTouchEnd);
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
