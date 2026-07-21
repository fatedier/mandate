import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { API_ROUTES } from "@shared/api-contracts";
import type { SnapshotPane } from "@/lib/snapshot-types";
import { apiWebSocketPath } from "@/lib/api-base";

export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const TERMINAL_FIT_MIN_FONT_SIZE = 5;
const TERMINAL_FIT_MAX_FONT_SIZE = 18;
export const TERMINAL_LINE_HEIGHT = 1.16;
export const TERMINAL_DESKTOP_HISTORY_ROWS = 1000;
const TERMINAL_MOBILE_HISTORY_ROWS = 200;
export const MOBILE_WEB_FIT_WIDTH_COLS = 80;

export interface TerminalGeometry {
  cols: number;
  rows: number;
}

export function terminalDimension(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function terminalScaleDimension(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function paneTerminalGeometry(pane: SnapshotPane | null | undefined): TerminalGeometry {
  return {
    cols: terminalDimension(pane?.paneWidth, 100, 20, 300),
    rows: terminalDimension(pane?.paneHeight, 32, 8, 200)
  };
}

let measuredCellWidth = 0;
function measureTerminalCellWidth(): number {
  if (measuredCellWidth > 0) return measuredCellWidth;
  if (typeof document === "undefined" || !document.body) return 0;
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(100);
  probe.style.cssText = [
    "position:absolute",
    "visibility:hidden",
    "pointer-events:none",
    "white-space:pre",
    `font-family:${TERMINAL_FONT_FAMILY}`,
    `font-size:${TERMINAL_FONT_SIZE}px`,
    `line-height:${TERMINAL_LINE_HEIGHT}`
  ].join(";");
  document.body.appendChild(probe);
  measuredCellWidth = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return measuredCellWidth;
}

export function terminalFitWidthFontSize(container: HTMLElement | null, cols: number): number {
  const width = Number(container?.clientWidth);
  const measured = Number.isFinite(width) && width > 0 ? width : (globalThis.innerWidth ?? 0);
  const cellWidth = measureTerminalCellWidth();
  if (!Number.isFinite(measured) || !Number.isFinite(cellWidth) || measured <= 0 || cellWidth <= 0) {
    return TERMINAL_FONT_SIZE;
  }
  const next = (measured / (Math.max(1, cols) * cellWidth)) * TERMINAL_FONT_SIZE;
  return terminalScaleDimension(next, TERMINAL_FONT_SIZE, TERMINAL_FIT_MIN_FONT_SIZE, TERMINAL_FIT_MAX_FONT_SIZE);
}

export function terminalBrowserFitGeometry(
  container: HTMLElement | null,
  pane: SnapshotPane | null | undefined,
  options: { fitWidth?: boolean } = {}
): TerminalGeometry {
  const paneTarget = paneTerminalGeometry(pane);
  const width = Number(container?.clientWidth);
  const height = Number(container?.clientHeight);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return paneTarget;
  }

  const mobile = isMobileTerminalViewport();
  const fontSize = mobile && options.fitWidth
    ? terminalFitWidthFontSize(container, MOBILE_WEB_FIT_WIDTH_COLS)
    : TERMINAL_FONT_SIZE;
  const cellWidth = measureTerminalCellWidth() * (fontSize / TERMINAL_FONT_SIZE);
  const cellHeight = fontSize * TERMINAL_LINE_HEIGHT;
  if (!Number.isFinite(cellWidth) || cellWidth <= 0 || !Number.isFinite(cellHeight) || cellHeight <= 0) {
    return paneTarget;
  }

  const minCols = mobile && options.fitWidth ? MOBILE_WEB_FIT_WIDTH_COLS : 20;
  return {
    cols: terminalDimension(Math.floor(width / cellWidth), paneTarget.cols, minCols, 300),
    rows: terminalDimension(Math.floor(height / cellHeight), paneTarget.rows, 8, 200)
  };
}

export function readTerminalCellSize(terminal: Terminal): { width: number; height: number } | null {
  const core = terminal as Terminal & {
    _core?: {
      _renderService?: {
        dimensions?: {
          css?: {
            cell?: { width?: number; height?: number };
          };
        };
      };
    };
  };
  const cellWidth = Number(core._core?._renderService?.dimensions?.css?.cell?.width);
  const cellHeight = Number(core._core?._renderService?.dimensions?.css?.cell?.height);
  if (!Number.isFinite(cellWidth) || cellWidth <= 0) return null;
  if (!Number.isFinite(cellHeight) || cellHeight <= 0) return null;
  return { width: cellWidth, height: cellHeight };
}

export function terminalMeasuredFitGeometry(
  terminal: Terminal,
  fitAddon: FitAddon | null,
  container: HTMLElement | null,
  pane: SnapshotPane | null | undefined,
  options: { fitWidth?: boolean } = {}
): TerminalGeometry | undefined {
  const paneTarget = paneTerminalGeometry(pane);
  const mobile = isMobileTerminalViewport();
  const proposed = fitAddon?.proposeDimensions();
  let cols = proposed?.cols;
  let rows = proposed?.rows;

  if (!cols || !rows) {
    const cell = readTerminalCellSize(terminal);
    const width = Number(container?.clientWidth);
    const height = Number(container?.clientHeight);
    if (!cell || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      return undefined;
    }
    cols = Math.floor(width / cell.width);
    rows = Math.floor(height / cell.height);
  } else if (mobile && !options.fitWidth) {
    // FitAddon subtracts xterm's scrollbar gutter when scrollback is enabled.
    // On mobile the scrollbar is overlay/gesture-driven, so use the full
    // measured container width to avoid being one column narrower than the
    // visible terminal.
    const cell = readTerminalCellSize(terminal);
    const width = Number(container?.clientWidth);
    if (cell && Number.isFinite(width) && width > 0) {
      cols = Math.max(cols, Math.floor(width / cell.width));
    }
  }

  const minCols = mobile && options.fitWidth ? MOBILE_WEB_FIT_WIDTH_COLS : 20;
  return {
    cols: terminalDimension(cols, paneTarget.cols, minCols, 300),
    rows: terminalDimension(rows, paneTarget.rows, 8, 200)
  };
}

export function isMobileTerminalViewport(): boolean {
  if (typeof globalThis === "undefined" || !globalThis.matchMedia) return false;
  return globalThis.matchMedia("(max-width: 760px)").matches;
}

export function terminalInitialHistoryRows(): number {
  return isMobileTerminalViewport() ? TERMINAL_MOBILE_HISTORY_ROWS : TERMINAL_DESKTOP_HISTORY_ROWS;
}

export function terminalWebSocketUrl(
  paneId: string,
  projectId: string | null,
  cols: number,
  rows: number,
  historyRows = TERMINAL_DESKTOP_HISTORY_ROWS,
  options: { fit?: boolean } = {}
): string {
  // projectId is OPTIONAL — when present, the dispatcher uses it to pick
  // the PaneRuntime. When absent
  // (/sessions/:s/windows/:w/pane/:p for an unmanaged tmux session), the
  // dispatcher falls back to the tmux runtime.
  const params = new URLSearchParams({
    paneId,
    cols: String(cols),
    rows: String(rows),
    historyRows: String(terminalDimension(historyRows, TERMINAL_DESKTOP_HISTORY_ROWS, 20, 5000))
  });
  if (projectId) params.set("projectId", projectId);
  if (options.fit) params.set("fit", "1");
  return apiWebSocketPath(`${API_ROUTES.terminal}?${params.toString()}`);
}
