import { expect, test } from "bun:test";
import { act, useRef } from "react";
import { useTerminalMobileKeyboardLayout } from "@/routes/terminal/useTerminalMobileKeyboardLayout";
import { mount } from "../helpers/mount.js";

// A terminal kept hidden behind another tab (kept-terminals.ts) is not
// measured by the phone's keyboard layout: nothing scrolls it while hidden,
// and coming back measures its lift again without taking it to the bottom.

let scrolls = 0;
let measures = 0;
const scrollToBottom = () => { scrolls += 1; };
/** Where the terminal's screen sits on the page (its font may grow while it
 *  is hidden). */
let screen = { top: 0, bottom: 100 };

function Layout({ active, keysVisible }: { active: boolean; keysVisible: boolean }) {
  const shell = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const terminal = useRef(null);
  const { terminalLift } = useTerminalMobileKeyboardLayout({
    isMobile: true, keysVisible, keyboardOpen: false, keyboardHeight: 0, keyboardLift: 0, fitBrowser: false,
    terminalShellRef: shell, terminalViewportRef: viewport, mobileInputBarRef: bar, terminalContainerRef: container,
    terminalRef: terminal, scrolledBack: false, hasSelection: false, scrollToBottom, active
  });
  const placed = (el: HTMLDivElement | null) => {
    container.current = el;
    // Lifted, the screen sits higher by the lift, as the page moves it.
    if (el) el.getBoundingClientRect = () => {
      measures += 1;
      const up = Number(el.closest("[data-lift]")?.getAttribute("data-lift") ?? 0);
      const top = screen.top - up;
      const bottom = screen.bottom - up;
      return { x: 0, y: top, left: 0, right: 100, width: 100, top, bottom, height: bottom - top, toJSON: () => ({}) };
    };
  };
  return <div ref={shell} data-lift={terminalLift}><div ref={viewport}><div ref={placed} /></div><div ref={bar} /></div>;
}

// In short steps, so the lift each measurement sets is on the page before
// the next one reads where the screen is.
async function wait(ms: number) {
  for (let left = ms; left > 0; left -= 20) {
    await act(async () => { await new Promise((r) => setTimeout(r, Math.min(20, left))); });
  }
}
const lift = (host: HTMLElement) => Number(host.querySelector("[data-lift]")?.getAttribute("data-lift"));

function reset() {
  scrolls = 0;
  measures = 0;
  screen = { top: 0, bottom: 100 };
}

test("hidden within the measuring after the key bar opened, a terminal is neither measured nor scrolled any more", async () => {
  reset();
  const view = mount(<Layout active keysVisible />);
  await wait(100);
  const before = { scrolls, measures };
  view.rerender(<Layout active={false} keysVisible />);
  await wait(400);
  expect({ scrolls, measures }).toEqual(before);
});

test("shown again with its key bar open, a terminal's lift is measured for where it is now, without taking it to the bottom", async () => {
  reset();
  const view = mount(<Layout active keysVisible />);
  await wait(400);
  expect(lift(view.host)).toBe(0);
  view.rerender(<Layout active={false} keysVisible />);
  const before = scrolls;
  screen = { top: 900, bottom: window.innerHeight + 100 };
  view.rerender(<Layout active keysVisible />);
  await wait(400);
  expect(lift(view.host)).toBe(108);
  expect(scrolls).toBe(before);
});

test("the key bar opened in sight scrolls to the bottom as before", async () => {
  reset();
  const view = mount(<Layout active keysVisible={false} />);
  await wait(50);
  view.rerender(<Layout active keysVisible />);
  await wait(400);
  expect(scrolls).toBeGreaterThan(0);
});

// On a desktop the key bar sits under the terminal, which it shortens: a
// terminal not fitted to the browser keeps its rows, and its viewport (which
// cuts what does not fit) is scrolled just far enough to keep the cursor's
// row in it, wherever the cursor goes. Rows 20 px tall, from 8 px into a
// viewport 300 px tall.
type Listener = () => void;
function fakeTerminal() {
  const listeners = { cursor: [] as Listener[], resize: [] as Listener[], scroll: [] as Listener[] };
  const on = (list: Listener[]) => (fn: Listener) => { list.push(fn); return { dispose: () => list.splice(list.indexOf(fn), 1) }; };
  return {
    buffer: { active: { cursorY: 0, viewportY: 0, baseY: 0 } },
    options: { fontSize: 13 },
    _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 20 } } } } },
    onCursorMove: on(listeners.cursor), onResize: on(listeners.resize), onScroll: on(listeners.scroll),
    listeners
  };
}
let desktopTerminal = fakeTerminal();

function DesktopLayout({ keysVisible }: { keysVisible: boolean }) {
  const shell = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef(desktopTerminal as never);
  useTerminalMobileKeyboardLayout({
    isMobile: false, keysVisible, keyboardOpen: false, keyboardHeight: 0, keyboardLift: 0, fitBrowser: false,
    terminalShellRef: shell, terminalViewportRef: viewport, mobileInputBarRef: bar, terminalContainerRef: container,
    terminalRef: terminal, scrolledBack: false, hasSelection: false, scrollToBottom, active: true
  });
  const placedViewport = (el: HTMLDivElement | null) => {
    viewport.current = el;
    if (!el) return;
    let scrollTop = 0;
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = Math.max(0, v); } });
    el.getBoundingClientRect = () => ({ x: 0, y: 100, left: 0, right: 100, width: 100, top: 100, bottom: 400, height: 300, toJSON: () => ({}) });
  };
  const placedScreen = (el: HTMLDivElement | null) => {
    if (!el) return;
    el.getBoundingClientRect = () => {
      const top = 100 + 8 - viewport.current!.scrollTop;
      return { x: 0, y: top, left: 0, right: 100, width: 100, top, bottom: top + 880, height: 880, toJSON: () => ({}) };
    };
  };
  return (
    <div ref={shell}>
      <div ref={placedViewport} data-testid="viewport"><div ref={container}><div ref={placedScreen} className="xterm-screen" /></div></div>
      <div ref={bar} />
    </div>
  );
}
const scrolled = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-testid="viewport"]')!.scrollTop;
const moveCursor = (row: number, list: "cursor" | "resize" | "scroll" = "cursor") => {
  desktopTerminal.buffer.active.cursorY = row;
  desktopTerminal.listeners[list].forEach((fn) => fn());
};

test("on a desktop with the keys shown the terminal's viewport follows its cursor's row; hidden, it is back at the top", async () => {
  desktopTerminal = fakeTerminal();
  desktopTerminal.buffer.active.cursorY = 20;
  const view = mount(<DesktopLayout keysVisible />);
  await wait(40);
  // Row 20 ends 428 px down the viewport: scrolled until 8 px under it show.
  expect(scrolled(view.host)).toBe(136);
  // A prompt on the first row (the screen cleared) shows from the top.
  moveCursor(0);
  await wait(40);
  expect(scrolled(view.host)).toBe(0);
  // Still in the room: nothing moves.
  moveCursor(10);
  await wait(40);
  expect(scrolled(view.host)).toBe(0);
  // The pane grew to 44 rows, its cursor on the last: it ends 888 px down.
  moveCursor(43, "resize");
  await wait(40);
  expect(scrolled(view.host)).toBe(596);
  // Read back in its history, the cursor's row is not on the screen: left.
  desktopTerminal.buffer.active.viewportY = 5;
  desktopTerminal.buffer.active.baseY = 30;
  moveCursor(0, "scroll");
  await wait(40);
  expect(scrolled(view.host)).toBe(596);
  view.rerender(<DesktopLayout keysVisible={false} />);
  await wait(40);
  expect(scrolled(view.host)).toBe(0);
  expect(desktopTerminal.listeners).toEqual({ cursor: [], resize: [], scroll: [] });
});
