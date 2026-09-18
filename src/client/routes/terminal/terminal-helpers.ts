import type { Terminal } from "@xterm/xterm";
import type { TypedSnapshot } from "@/lib/snapshot-types";
import { selectSnapshotWindow } from "@/lib/snapshot-selectors";
import { paneTitle } from "@/routes/window/pane-helpers";
import type { TerminalSelectionRange } from "@/hooks/useTerminalSession";

export interface SelectionBoundary {
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
