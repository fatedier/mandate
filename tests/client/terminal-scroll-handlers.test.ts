import { expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { attachTerminalScrollHandlers } from "../../src/client/hooks/terminal/terminal-scroll-handlers.js";

/**
 * The touch handler's sequencing, against a stand-in terminal: sequences of
 * fingers that a browser cannot produce on demand (CDP cannot lift one finger
 * of two). A drag in the alternate screen is forwarded to xterm as one wheel
 * event per line, which the stand-in's screen counts.
 */

interface Finger { identifier: number; clientX: number; clientY: number }

function standIn(options: { readsWheel?: boolean } = {}) {
  const container = document.createElement("div");
  const element = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  // 80 × 24 cells of 10 × 10px, for the cell a wheel report names.
  screen.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 240, right: 800, bottom: 240, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  element.append(screen);
  container.append(element);
  const forwarded: number[] = [];
  screen.addEventListener("wheel", (event) => forwarded.push(Math.sign((event as WheelEvent).deltaY)));
  const terminal = {
    buffer: { active: { type: "alternate", viewportY: 0 } },
    modes: { mouseTrackingMode: "none" },
    rows: 24,
    cols: 80,
    options: { fontSize: 10 },
    element,
    hasSelection: () => false,
    scrollLines: () => {},
    select: () => {},
    blur: () => {},
    attachCustomWheelEventHandler: (handler: (event: WheelEvent) => boolean) => { wheelHandler = handler; }
  } as unknown as Terminal;
  let wheelHandler: (event: WheelEvent) => boolean = () => true;
  const bufferListeners: Array<() => void> = [];
  (terminal.buffer as unknown as { onBufferChange: unknown }).onBufferChange = (listener: () => void) => {
    bufferListeners.push(listener);
    return { dispose: () => {} };
  };
  const sent: string[] = [];
  attachTerminalScrollHandlers(container, terminal, { sendInput: (data) => sent.push(data), readsWheel: () => options.readsWheel ?? false });
  const setScreen = (type: "normal" | "alternate") => {
    (terminal.buffer.active as { type: string }).type = type;
    for (const listener of bufferListeners) listener();
  };
  const wheel = (lines: number) => {
    const event = new window.WheelEvent("wheel", { deltaY: lines, deltaMode: 1 });
    // happy-dom's WheelEvent takes no pointer position from its init.
    Object.defineProperty(event, "clientX", { value: 50 });
    Object.defineProperty(event, "clientY", { value: 50 });
    return wheelHandler(event as unknown as WheelEvent);
  };
  const touch = (type: string, fingers: Finger[]) => {
    const event = new window.Event(type, { cancelable: true });
    const list = { length: fingers.length, item: (i: number) => fingers[i] ?? null };
    Object.defineProperty(event, "touches", { value: type === "touchend" ? { length: 0, item: () => null } : list });
    Object.defineProperty(event, "changedTouches", { value: list });
    container.dispatchEvent(event);
  };
  return { touch, forwarded, sent, wheel, setScreen };
}

// Lines are the font size × 1.16: 11.6px here.
const at = (identifier: number, clientY: number): Finger => ({ identifier, clientX: 100, clientY });

test("a drag forwards one wheel event per line of travel in the alternate screen", () => {
  const { touch, forwarded } = standIn();
  touch("touchstart", [at(1, 100)]);
  touch("touchmove", [at(1, 100 + 11.6 * 3 + 0.1)]);
  expect(forwarded).toStrictEqual([-1, -1, -1]);
});

test("when the finger carrying the drag changes, travel restarts from the new finger", () => {
  const { touch, forwarded } = standIn();
  touch("touchstart", [at(1, 100)]);
  touch("touchmove", [at(1, 108)]);
  // A second finger lands far below; the first lifts; the second carries on.
  touch("touchmove", [at(2, 500)]);
  expect(forwarded).toStrictEqual([]);
  touch("touchmove", [at(2, 500 + 11.6 + 0.1)]);
  expect(forwarded).toStrictEqual([-1]);
});

test("a codex wheel's pending lines do not survive a trip through another screen", () => {
  const { wheel, setScreen, sent } = standIn({ readsWheel: true });
  wheel(-2);
  setScreen("normal");
  setScreen("alternate");
  wheel(-1);
  expect(sent).toStrictEqual([]);
  wheel(-2);
  expect(sent).toStrictEqual(["\x1b[<64;6;6M"]);
});
