import { expect, test } from "bun:test";
import { act, useRef } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useTerminalGeometry } from "@/hooks/useTerminalGeometry";
import type { TerminalGeometry } from "@/lib/terminal-helpers";
import { mount } from "../helpers/mount.js";
import { onCleanup } from "../helpers/cleanup.js";

/** A phone's screen, for the hook's mobile branches. */
function onAPhone() {
  const real = { window: window.matchMedia, global: globalThis.matchMedia };
  const phone = ((query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  window.matchMedia = phone;
  globalThis.matchMedia = phone;
  onCleanup(() => { window.matchMedia = real.window; globalThis.matchMedia = real.global; });
}

const grid = { options: {}, cols: 80, rows: 24, resize(cols: number, rows: number) { grid.cols = cols; grid.rows = rows; } };
const terminal = grid as unknown as Terminal;
/** The phone's own size, as the fit addon measures it. */
const fitAddon = { proposeDimensions: () => ({ cols: 47, rows: 30 }) } as unknown as FitAddon;

function Probe({ fitBrowser, keyboardOpen, pane, sent }: { fitBrowser: boolean; keyboardOpen: boolean; pane: { paneId: string; paneWidth: number; paneHeight: number }; sent: TerminalGeometry[] }) {
  const containerRef = useRef<HTMLDivElement | null>(document.createElement("div"));
  const terminalRef = useRef<Terminal | null>(terminal);
  const fitAddonRef = useRef<FitAddon | null>(fitAddon);
  useTerminalGeometry({ pane: pane as never, fitWidth: false, fitBrowser, mobileKeyboardOpen: keyboardOpen, containerRef, terminalRef, fitAddonRef, onResize: (g) => { sent.push(g); } });
  return null;
}

test("on a phone with its keyboard open, fitted again after showing the pane's size, it takes the phone's size, not the pane's it showed", () => {
  onAPhone();
  const sent: TerminalGeometry[] = [];
  const view = mount(<Probe fitBrowser keyboardOpen={false} pane={{ paneId: "%3", paneWidth: 80, paneHeight: 24 }} sent={sent} />);
  expect(sent.at(-1)).toEqual({ cols: 47, rows: 30 });
  // Given back: the pane's own size.
  act(() => { view.rerender(<Probe fitBrowser={false} keyboardOpen pane={{ paneId: "%3", paneWidth: 120, paneHeight: 40 }} sent={sent} />); });
  expect(sent.at(-1)).toEqual({ cols: 120, rows: 40 });
  // Used again with the keyboard still open: the phone's size again.
  act(() => { view.rerender(<Probe fitBrowser keyboardOpen pane={{ paneId: "%3", paneWidth: 120, paneHeight: 40 }} sent={sent} />); });
  expect(sent.at(-1)).toEqual({ cols: 47, rows: 30 });
});
