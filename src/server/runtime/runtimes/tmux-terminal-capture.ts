import { type TmuxClient, tmuxCommand } from "../../platform/tmux/tmux.js";
import {
  DEFAULT_INITIAL_HISTORY_ROWS,
  MAX_INITIAL_HISTORY_ROWS,
  MIN_INITIAL_HISTORY_ROWS
} from "./tmux-runtime-constants.js";
import { clampNumber } from "./tmux-runtime-utils.js";

export function capturePaneInitial(tmuxClient: TmuxClient, paneId: string, historyRows: number): string | null {
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

  const captureArgs = ["capture-pane", "-p", "-e", "-J", "-t", paneId];
  if (altOn || historyRows <= 0) {
    captureArgs.push("-S", "0", "-E", "-");
  } else {
    captureArgs.push("-S", `-${historyRows}`, "-E", "-");
  }
  const capture = tmuxCommand(tmuxClient, captureArgs, { timeout: 2000, maxBuffer: 32 * 1024 * 1024 });
  if (capture.error || capture.status !== 0) return null;

  const altPrefix = altOn ? "\x1b[?1049h\x1b[2J\x1b[H" : "";
  const cursorSeq = `\x1b[${cursorY + 1};${cursorX + 1}H`;
  // tmux outputs LF; xterm wants CRLF for proper line breaks. Strip the
  // trailing newline first — capture-pane appends one after the last row.
  const body = String(capture.stdout || "")
    .replace(/\r?\n$/, "")
    .replace(/\r?\n/g, "\r\n");
  return altPrefix + body + cursorSeq;
}

export function capturePaneRefresh(tmuxClient: TmuxClient, paneId: string, historyRows = 0): string | null {
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

  const captureArgs = ["capture-pane", "-p", "-e", "-J", "-t", paneId];
  if (!altOn && historyRows > 0) {
    const clampedHistoryRows = clampNumber(
      historyRows,
      MIN_INITIAL_HISTORY_ROWS,
      MAX_INITIAL_HISTORY_ROWS,
      DEFAULT_INITIAL_HISTORY_ROWS
    );
    captureArgs.push("-S", `-${clampedHistoryRows}`);
  } else {
    captureArgs.push("-S", "0");
  }
  captureArgs.push("-E", "-");

  const capture = tmuxCommand(tmuxClient, captureArgs, { timeout: 2000, maxBuffer: 32 * 1024 * 1024 });
  if (capture.error || capture.status !== 0) return null;

  // \x1b[0m before \x1b[2J so the clear paints with default bg.
  const prefix = altOn
    ? "\x1b[?1049h\x1b[0m\x1b[2J\x1b[H"
    : `\x1b[?1049l\x1b[0m${historyRows > 0 ? "\x1b[3J" : ""}\x1b[2J\x1b[H`;
  const body = String(capture.stdout || "")
    .replace(/\r?\n$/, "")
    .replace(/\r?\n/g, "\r\n");
  const cursorSeq = `\x1b[0m\x1b[${cursorY + 1};${cursorX + 1}H`;
  return prefix + body + cursorSeq;
}
