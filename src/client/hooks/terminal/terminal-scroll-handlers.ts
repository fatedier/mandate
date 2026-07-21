import type { Terminal } from "@xterm/xterm";
import { TERMINAL_LINE_HEIGHT } from "@/lib/terminal-helpers";

interface TerminalTouchCell {
  col: number;
  row: number;
}

export function attachTerminalScrollHandlers(container: HTMLElement, terminal: Terminal) {
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
  const clientToBufferCell = (clientX: number, clientY: number, clampToViewport: boolean): TerminalTouchCell | null => {
    const grid = terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? terminal.element;
    const rect = grid?.getBoundingClientRect();
    if (!rect) return null;
    const cellWidth = rect.width / terminal.cols;
    const measuredCellHeight = rect.height / terminal.rows;
    const cellHeight = measuredCellHeight > 0 ? measuredCellHeight : touchLineHeight();
    if (cellWidth <= 0 || cellHeight <= 0) return null;
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
    touchLineRemainder = 0;
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
    terminal.scrollLines(lines);
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
