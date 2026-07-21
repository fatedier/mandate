import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS
} from "./tmux-runtime-constants.js";

export interface TerminalGeometry {
  cols: number;
  rows: number;
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// MessageEvent.data shape from Hono's Bun helper: string for text frames,
// ArrayBuffer for binary frames, with view types handled defensively.
export function messageToString(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  if (ArrayBuffer.isView(message)) return new TextDecoder().decode(message as ArrayBufferView);
  return String(message);
}

export function terminalSizeFromPayload(payload: unknown) {
  const record = isRecord(payload) ? payload : {};
  return {
    cols: clampNumber(record.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS),
    rows: clampNumber(record.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function clampNumber(value: unknown, min: number, max: number, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}
