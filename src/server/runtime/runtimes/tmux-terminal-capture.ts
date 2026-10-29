import { type TmuxClient, tmuxCommand } from "../../platform/tmux/tmux.js";

interface PaneCapture {
  altOn: boolean;
  cursorX: number;
  cursorY: number;
  /** The dump with CRLF line breaks. */
  body: string;
}

// historyRows arrive clamped (attachViewer's clampNumber) or 0 for the visible screen only.
function capturePane(tmuxClient: TmuxClient, paneId: string, historyRows: number): PaneCapture | null {
  // Probe state first; capture-pane respects alternate_on so the dump's
  // line range only makes sense after we know the mode.
  const state = tmuxCommand(
    tmuxClient,
    [
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{alternate_on} #{cursor_x} #{cursor_y}"
    ],
    { timeout: 1000 }
  );
  let altOn = false;
  let cursorX = 0;
  let cursorY = 0;
  if (state.status === 0) {
    const [altStr, xStr, yStr] = String(state.stdout || "").trim().split(/\s+/);
    altOn = altStr === "1";
    cursorX = Math.max(0, Number(xStr) | 0);
    cursorY = Math.max(0, Number(yStr) | 0);
  }

  const start = altOn || historyRows <= 0 ? "0" : `-${historyRows}`;
  const capture = tmuxCommand(
    tmuxClient,
    ["capture-pane", "-p", "-e", "-J", "-t", paneId, "-S", start, "-E", "-"],
    { timeout: 2000, maxBuffer: 32 * 1024 * 1024 }
  );
  if (capture.error || capture.status !== 0) return null;

  // tmux outputs LF; xterm wants CRLF for proper line breaks. Strip the
  // trailing newline first — capture-pane appends one after the last row.
  const body = String(capture.stdout || "")
    .replace(/\r?\n$/, "")
    .replace(/\r?\n/g, "\r\n");
  return { altOn, cursorX, cursorY, body };
}

export function capturePaneInitial(tmuxClient: TmuxClient, paneId: string, historyRows: number): string | null {
  const pane = capturePane(tmuxClient, paneId, historyRows);
  if (!pane) return null;
  const altPrefix = pane.altOn ? "\x1b[?1049h\x1b[2J\x1b[H" : "";
  return `${altPrefix}${pane.body}\x1b[${pane.cursorY + 1};${pane.cursorX + 1}H`;
}

export function capturePaneRefresh(tmuxClient: TmuxClient, paneId: string, historyRows = 0): string | null {
  const pane = capturePane(tmuxClient, paneId, historyRows);
  if (!pane) return null;
  // \x1b[0m before \x1b[2J so the clear paints with default bg.
  const prefix = pane.altOn
    ? "\x1b[?1049h\x1b[0m\x1b[2J\x1b[H"
    : `\x1b[?1049l\x1b[0m${historyRows > 0 ? "\x1b[3J" : ""}\x1b[2J\x1b[H`;
  return `${prefix}${pane.body}\x1b[0m\x1b[${pane.cursorY + 1};${pane.cursorX + 1}H`;
}
