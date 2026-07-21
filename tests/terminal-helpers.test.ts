import { expect, test } from "bun:test";
import {
  terminalDimension,
  terminalScaleDimension,
  paneTerminalGeometry,
  terminalWebSocketUrl,
  TERMINAL_DESKTOP_HISTORY_ROWS,
  TERMINAL_FONT_SIZE
} from "../src/client/lib/terminal-helpers.js";

test("terminalDimension: clamps within range", () => {
  expect(terminalDimension(50, 100, 20, 300)).toBe(50);
  expect(terminalDimension(10, 100, 20, 300)).toBe(20);
  expect(terminalDimension(500, 100, 20, 300)).toBe(300);
  expect(terminalDimension(undefined, 100, 20, 300)).toBe(100);
  expect(terminalDimension(NaN, 100, 20, 300)).toBe(100);
});

test("terminalScaleDimension: same idea, fractional allowed", () => {
  expect(terminalScaleDimension(8.4, 10, 5, 18)).toBe(8.4);
  expect(terminalScaleDimension(2, 10, 5, 18)).toBe(5);
  expect(terminalScaleDimension(99, 10, 5, 18)).toBe(18);
  expect(terminalScaleDimension(undefined, 10, 5, 18)).toBe(10);
});

test("paneTerminalGeometry uses pane dimensions with sane defaults", () => {
  expect(paneTerminalGeometry({ paneWidth: 80, paneHeight: 24 })).toEqual({ cols: 80, rows: 24 });
  expect(paneTerminalGeometry({})).toEqual({ cols: 100, rows: 32 });
  expect(paneTerminalGeometry(null)).toEqual({ cols: 100, rows: 32 });
});

test("terminalWebSocketUrl: builds ws path with paneId/projectId/cols/rows as query", () => {
  const url = terminalWebSocketUrl("%5", "proj_123", 80, 24);
  // URLSearchParams encodes "%" as "%25", giving paneId=%255
  expect(url).toMatch(/\/api\/terminal\?/);
  expect(url).toMatch(/paneId=%255/);
  expect(url).toMatch(/projectId=proj_123/);
  expect(url).toMatch(/cols=80/);
  expect(url).toMatch(/rows=24/);
  expect(url).toMatch(new RegExp(`historyRows=${TERMINAL_DESKTOP_HISTORY_ROWS}`));
});

test("terminalWebSocketUrl: omits projectId when null (unmanaged tmux pane fallback)", () => {
  const url = terminalWebSocketUrl("%5", null, 80, 24);
  expect(url).toMatch(/paneId=%255/);
  expect(url).not.toMatch(/projectId=/);
});

test("terminalWebSocketUrl: marks initial web fit when requested", () => {
  const url = terminalWebSocketUrl("%5", "proj_123", 120, 50, TERMINAL_DESKTOP_HISTORY_ROWS, { fit: true });
  expect(url).toMatch(/fit=1/);
});

test("TERMINAL_FONT_SIZE is the well-known default", () => {
  expect(TERMINAL_FONT_SIZE).toBe(13);
});
