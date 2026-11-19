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

/** Where a selection's Copy button goes, in the terminal shell's own
 *  coordinates, as a phone's own copy menu sits by what is selected:
 *  centred over the selection's part in sight, above its first line in
 *  sight; below its last, clear of what sits under it (a phone's end
 *  handle), when there is no room above; over it, at the top, when there is
 *  room for neither.
 *  Always inside the room the terminal shows. Null when none of the
 *  selection is in sight, across as well as down. */
export function copyButtonPlace(input: {
  range: TerminalSelectionRange;
  grid: Rect;
  shell: Rect;
  /** What the terminal shows of its grid, a key bar over its foot taken off. */
  room: Rect;
  cols: number;
  rows: number;
  viewportY: number;
  size: { width: number; height: number };
  /** What sits under the selection's last line. */
  clearBelow: number;
  /** A block selection: the same columns on every line. */
  block?: boolean;
}): { left: number; top: number } | null {
  const { range, grid, shell, room, cols, rows, viewportY, size } = input;
  const cellWidth = grid.width / cols;
  const cellHeight = grid.height / rows;
  if (cellWidth <= 0 || cellHeight <= 0) return null;
  const startRow = range.start.y - viewportY;
  const endRow = range.end.y - viewportY;
  const roomTop = room.top - shell.top;
  const roomBottom = room.bottom - shell.top;
  const roomLeft = room.left - shell.left;
  const roomRight = room.right - shell.left;
  const gridLeft = grid.left - shell.left;
  const gridTop = grid.top - shell.top;
  // What is in sight of the selection, line by line: each selected line on
  // the screen and in the room, cut to the room across (a phone's grid may
  // be wider). Its first line selected from the start, its last to the end;
  // a block's every line between its two columns.
  const blockFrom = Math.min(range.start.x, range.end.x);
  const blockTo = Math.max(range.start.x, range.end.x);
  let top = Infinity;
  let bottom = -Infinity;
  let from = Infinity;
  let to = -Infinity;
  for (let row = Math.max(startRow, 0); row <= Math.min(endRow, rows - 1); row += 1) {
    const rowTop = gridTop + row * cellHeight;
    if (rowTop + cellHeight <= roomTop || rowTop >= roomBottom) continue;
    const fromCol = input.block ? blockFrom : row === startRow ? range.start.x : 0;
    const toCol = input.block ? blockTo : row === endRow ? range.end.x : cols;
    const left = Math.max(gridLeft + fromCol * cellWidth, roomLeft);
    const right = Math.min(gridLeft + toCol * cellWidth, roomRight);
    if (left >= right) continue;
    top = Math.min(top, rowTop);
    bottom = Math.max(bottom, rowTop + cellHeight);
    from = Math.min(from, left);
    to = Math.max(to, right);
  }
  if (from >= to) return null;
  const margin = 8;
  const gap = 8;
  const above = top - gap - size.height;
  const below = bottom + input.clearBelow + gap;
  const placedTop = above >= roomTop + margin
    ? above
    : below + size.height <= roomBottom - margin ? below : roomTop + margin;
  const left = clamp((from + to) / 2 - size.width / 2, roomLeft + margin, Math.max(roomLeft + margin, roomRight - margin - size.width));
  return { left, top: placedTop };
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
