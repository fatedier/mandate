import type { Terminal } from "@xterm/xterm";
import type { TypedSnapshot } from "@/lib/snapshot-types";
import { getPaneDisplayCommand } from "@/lib/render";
import { selectSnapshotWindow } from "@/lib/snapshot-selectors";
import { paneTitle } from "@/routes/window/pane-helpers";
import type { TerminalSelectionRange } from "@/hooks/useTerminalSession";

interface SelectionBoundary {
  col: number;
  row: number;
}

export interface SelectionHandlePoint {
  left: number;
  top: number;
  visible: boolean;
}

export interface SelectionHandleGeometry {
  start: SelectionHandlePoint;
  end: SelectionHandlePoint;
}

export type SelectionHandleKind = "start" | "end";

/** Terminal text comes from its WebSocket. Select only the metadata used by
 *  the page so another pane's output does not reset geometry effects. */
export function selectTerminalPane(
  snapshot: TypedSnapshot | null,
  sessionName: string | undefined,
  windowName: string | undefined,
  paneId: string
) {
  if (!snapshot) return undefined;
  if (!sessionName || !windowName || !paneId) return null;
  const window = selectSnapshotWindow(snapshot, sessionName, windowName);
  const pane = window?.panes?.find((pane) => pane.paneId === paneId);
  if (!pane) return null;
  return {
    paneId: pane.paneId,
    paneIndex: pane.paneIndex,
    paneWidth: pane.paneWidth,
    paneHeight: pane.paneHeight,
    currentCommand: pane.currentCommand,
    currentPath: pane.currentPath,
    // The program itself, through a `node …/codex` wrapper: where a scroll
    // goes depends on it. A string, so this selection stays shallow-equal.
    program: getPaneDisplayCommand(pane),
    title: paneTitle(pane),
    windowZoomed: Boolean(window?.windowZoomed)
  };
}

export function clientToSelectionBoundary(
  terminal: Terminal,
  clientX: number,
  clientY: number
): SelectionBoundary | null {
  const grid = terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? terminal.element;
  const rect = grid?.getBoundingClientRect();
  if (!rect) return null;
  const cellWidth = rect.width / terminal.cols;
  const cellHeight = rect.height / terminal.rows;
  if (cellWidth <= 0 || cellHeight <= 0) return null;
  const xInside = clientX - rect.left;
  const yInside = clientY - rect.top;
  const col = clamp(Math.round(xInside / cellWidth), 0, terminal.cols);
  const rowInViewport = clamp(Math.floor(yInside / cellHeight), 0, Math.max(terminal.rows - 1, 0));
  return { col, row: terminal.buffer.active.viewportY + rowInViewport };
}

export function selectBetweenBoundaries(
  terminal: Terminal,
  first: SelectionBoundary,
  second: SelectionBoundary
): void {
  const cols = terminal.cols;
  const firstIndex = first.row * cols + first.col;
  const secondIndex = second.row * cols + second.col;
  const startIndex = Math.min(firstIndex, secondIndex);
  const endIndex = Math.max(firstIndex, secondIndex);
  const length = endIndex - startIndex;
  if (length <= 0) return;
  terminal.select(startIndex % cols, Math.floor(startIndex / cols), length);
}

type Rect = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;

/** Where a selection's two handles sit, in the terminal shell's own
 *  coordinates: under the cell each end of the range is at. A handle whose
 *  row is scrolled out, or that falls outside the viewport, is not shown.
 *  Null when the grid has no size yet. */
export function selectionHandleGeometry(input: {
  range: TerminalSelectionRange;
  grid: Rect;
  shell: Rect;
  viewport: Rect;
  cols: number;
  rows: number;
  viewportY: number;
}): SelectionHandleGeometry | null {
  const { range, grid: gridRect, shell: shellRect, viewport: viewportRect, rows, viewportY } = input;
  const cellWidth = gridRect.width / input.cols;
  const cellHeight = gridRect.height / rows;
  if (cellWidth <= 0 || cellHeight <= 0) return null;

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
        rowInViewport < rows &&
        left >= viewportLeft &&
        left <= viewportRight &&
        top >= viewportTop &&
        top <= viewportBottom + 32
    };
  };
  return { start: toHandlePoint(range.start), end: toHandlePoint(range.end) };
}

export function rangeBoundary(
  range: TerminalSelectionRange,
  kind: SelectionHandleKind
): SelectionBoundary {
  const point = kind === "start" ? range.start : range.end;
  return { col: point.x, row: point.y };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
