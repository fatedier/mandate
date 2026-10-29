import { afterEach, expect, test } from "bun:test";
import { act, useLayoutEffect, useState } from "react";
import { SplitRow } from "@/components/SplitRow";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mountAsync } from "../helpers/mount.js";
import { recordAnimations, reducedMotion, untilMotionEnds, type StartedAnimation } from "../helpers/motion.js";

afterEach(() => { runCleanups(); });

// happy-dom lays nothing out: the row is told its width, and told again when
// it "resizes" (as worker-panel.test.tsx does).
let rowWidth = 0;
let resizeRow: (width: number) => Promise<void> = async () => {};
function measuredAs(width: number) {
  rowWidth = width;
  const proto = window.HTMLElement.prototype;
  const rect = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  const observer = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  const callbacks = new Set<() => void>();
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true, writable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, width: rowWidth, height: 600, right: rowWidth, bottom: 600, toJSON: () => ({}) }) as DOMRect
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true, writable: true,
    value: class {
      #callback: () => void;
      constructor(callback: () => void) { this.#callback = callback; }
      observe() { callbacks.add(this.#callback); }
      unobserve() { callbacks.delete(this.#callback); }
      disconnect() { callbacks.delete(this.#callback); }
    }
  });
  onCleanup(() => {
    if (rect) Object.defineProperty(proto, "getBoundingClientRect", rect); else delete (proto as unknown as Record<string, unknown>).getBoundingClientRect;
    if (observer) Object.defineProperty(globalThis, "ResizeObserver", observer); else delete (globalThis as Record<string, unknown>).ResizeObserver;
  });
  resizeRow = async (next) => {
    rowWidth = next;
    await act(async () => { for (const callback of callbacks) callback(); });
  };
}

interface Seen { narrow: boolean[]; ratios: number[] }

/** A row whose owner keeps its state as a store would. */
function Owner({ seen, initialOpen = true }: { seen: Seen; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [maximized, setMaximized] = useState(false);
  const [narrowView, setNarrowView] = useState<"chat" | "side">("chat");
  const [ratio, setRatio] = useState(0.5);
  return (
    <SplitRow
      open={open} maximized={maximized} narrowView={narrowView}
      onNarrow={(narrow) => { seen.narrow.push(narrow); }}
      onNarrowView={setNarrowView}
      onMaximized={setMaximized}
      onOpen={() => setOpen(true)}
      ratio={ratio}
      onRatio={(next) => { seen.ratios.push(next); setRatio(next); }}
      slots={{ chat: "page-chat", side: "page-pane" }}
      labels={{ side: "Page", resize: "Resize page", valueSuffix: "page" }}
      chat={<p>chat</p>}
      side={<p>page</p>}
    />
  );
}

const chatShown = (host: HTMLElement) => !host.querySelector('[data-slot="page-chat"]')!.className.split(/\s+/).includes("hidden");
const sideShown = (host: HTMLElement) => host.querySelector('[data-slot="page-pane"]') !== null;
const sideHasRow = (host: HTMLElement) => host.querySelector('[data-slot="page-pane"]')!.className.split(/\s+/).includes("flex-1");
const key = (init: KeyboardEventInit) => act(async () => { window.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

test("a narrow row shows one side, the shortcut swaps it, Esc gives the row back", async () => {
  // The layout, at once: how it moves is the motion tests' below.
  reducedMotion();
  measuredAs(596);
  const seen: Seen = { narrow: [], ratios: [] };
  const { host } = await mountAsync(<Owner seen={seen} initialOpen={false} />);
  expect(seen.narrow.at(-1)).toBe(true);
  expect([chatShown(host), sideShown(host)]).toEqual([true, false]);
  // The shortcut brings in the hidden side, whole.
  await key({ key: "Enter", shiftKey: true, metaKey: true });
  expect([chatShown(host), sideShown(host), sideHasRow(host)]).toEqual([false, true, true]);
  expect(host.querySelector('[data-slot="page-pane"]')!.getAttribute("aria-label")).toBe("Page");
  await key({ key: "Escape" });
  expect([chatShown(host), sideShown(host)]).toEqual([true, false]);
  // Wide again: both, side by side; the shortcut maximizes and Esc restores.
  await resizeRow(1200);
  expect(seen.narrow.at(-1)).toBe(false);
  expect([chatShown(host), sideShown(host), sideHasRow(host)]).toEqual([true, true, false]);
  await key({ key: "Enter", shiftKey: true, ctrlKey: true });
  expect([chatShown(host), sideHasRow(host)]).toEqual([false, true]);
  // A row that narrows while the side has it keeps the side.
  await resizeRow(600);
  expect([chatShown(host), sideHasRow(host)]).toEqual([false, true]);
  await resizeRow(1200);
  await key({ key: "Escape" });
  expect([chatShown(host), sideHasRow(host)]).toEqual([true, false]);
});

test("dragging reports a ratio, and the keys and a double click set it", async () => {
  measuredAs(1200);
  const seen: Seen = { narrow: [], ratios: [] };
  const { host } = await mountAsync(<Owner seen={seen} />);
  const separator = host.querySelector<HTMLElement>('[role="separator"]')!;
  expect([separator.getAttribute("aria-label"), separator.getAttribute("aria-valuetext")]).toEqual(["Resize page", "50% page"]);
  await act(async () => {
    separator.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 600, pointerId: 1 }));
    separator.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, clientX: 480, pointerId: 1 }));
    separator.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, clientX: 480, pointerId: 1 }));
  });
  // Dragged left by 120 of 1200: the side grows from half to 60%.
  expect(seen.ratios.at(-1)).toBeCloseTo(0.6, 5);
  await act(async () => { separator.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
  expect(seen.ratios.at(-1)!).toBeLessThan(0.6);
  await act(async () => { separator.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
  expect(seen.ratios.at(-1)).toBe(0.5);
});

// The pane moves as the layout changes, so it never pops in or out: in a wide
// row the divider slides (the side's width), in a narrow one the side slides
// over the chat, as a page opened on a phone does.
interface Drive { open(on: boolean): void; maximize(on: boolean): void; view(v: "chat" | "side"): void }

/** A row whose state the test sets, as its owner's toggles would. */
function Driven({ bind, initialOpen = false }: { bind: (drive: Drive) => void; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [maximized, setMaximized] = useState(false);
  const [narrowView, setNarrowView] = useState<"chat" | "side">("chat");
  useLayoutEffect(() => { bind({ open: setOpen, maximize: setMaximized, view: setNarrowView }); }, [bind]);
  return (
    <SplitRow
      open={open} maximized={maximized} narrowView={narrowView}
      onNarrow={() => {}} onNarrowView={setNarrowView} onMaximized={setMaximized} onOpen={() => setOpen(true)}
      ratio={0.5} onRatio={() => {}}
      slots={{ chat: "page-chat", side: "page-pane" }}
      labels={{ side: "Page", resize: "Resize page", valueSuffix: "page" }}
      chat={<p>chat</p>}
      side={<p>page</p>}
    />
  );
}

const pane = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="page-pane"]');
const widthsOf = (started: StartedAnimation[]) =>
  started.filter((a) => a.slot === "page-pane" && a.keyframes.some((k) => "width" in k)).map((a) => [a.keyframes.map((k) => k.width), a.duration]);
const slidesOf = (started: StartedAnimation[], slot: string) =>
  started.filter((a) => a.slot === slot && a.keyframes.some((k) => "transform" in k)).map((a) => a.keyframes.map((k) => k.transform));
const run = (change: () => void) => act(async () => { change(); });

test("opening pushes the side in from nothing to its share; closing pushes it out before it goes", async () => {
  measuredAs(1200);
  const started = recordAnimations();
  const drive = {} as Drive;
  const { host } = await mountAsync(<Driven bind={(d) => Object.assign(drive, d)} />);
  // Positive control: closed, and nothing moved at mount.
  expect([sideShown(host), started.length]).toEqual([false, 0]);
  await run(() => drive.open(true));
  expect(sideShown(host)).toBe(true);
  expect(widthsOf(started)).toEqual([[["0px", "600px"], 220]]);
  // The side's content is laid out at its final width while the edge moves,
  // and keeps the side's height: a scroller in it keeps its place.
  const body = pane(host)!.querySelector<HTMLElement>('[data-slot="split-side-body"]')!;
  expect([body.style.width, body.style.flex, body.className.split(/\s+/).includes("flex-1")]).toEqual(["600px", "", true]);
  await untilMotionEnds(() => pane(host)!.querySelector<HTMLElement>('[data-slot="split-side-body"]')!.style.width === "", "the push in ends");
  expect(pane(host)!.style.width).toBe("600px");

  await run(() => drive.open(false));
  // Still there while it goes, and out of reach.
  expect(sideShown(host)).toBe(true);
  expect(pane(host)!.hasAttribute("inert")).toBe(true);
  expect(widthsOf(started).at(-1)).toEqual([["600px", "0px"], 220]);
  await untilMotionEnds(() => !sideShown(host), "the push out ends");
  expect(chatShown(host)).toBe(true);
});

test("maximizing sweeps the divider to the edge, and the chat goes only once it is covered; restoring sweeps it back", async () => {
  measuredAs(1200);
  const started = recordAnimations();
  const drive = {} as Drive;
  const { host } = await mountAsync(<Driven bind={(d) => Object.assign(drive, d)} initialOpen />);
  expect([chatShown(host), sideHasRow(host), started.length]).toEqual([true, false, 0]);
  await run(() => drive.maximize(true));
  expect(widthsOf(started)).toEqual([[["600px", "1200px"], 220]]);
  expect(chatShown(host)).toBe(true);
  await untilMotionEnds(() => !chatShown(host), "the sweep to the edge ends");
  expect(sideHasRow(host)).toBe(true);
  await run(() => drive.maximize(false));
  expect(chatShown(host)).toBe(true);
  expect(widthsOf(started).at(-1)).toEqual([["1200px", "600px"], 220]);
  await untilMotionEnds(() => pane(host)!.style.width === "600px" && !sideHasRow(host), "the sweep back ends");
});

test("in a narrow row the side slides over the chat, and away again on the way back", async () => {
  measuredAs(596);
  const started = recordAnimations();
  const drive = {} as Drive;
  const { host } = await mountAsync(<Driven bind={(d) => Object.assign(drive, d)} initialOpen />);
  expect([chatShown(host), sideShown(host)]).toEqual([true, false]);
  await run(() => drive.view("side"));
  expect(slidesOf(started, "page-pane")).toEqual([["translateX(100%)", "translateX(0)"]]);
  expect(slidesOf(started, "page-chat")).toEqual([["translateX(0)", "translateX(-18%)"]]);
  // The chat stays under it until it is covered, and the row clips the side
  // still off its edge (no scrolling sideways while it slides).
  expect([chatShown(host), sideShown(host)]).toEqual([true, true]);
  expect(pane(host)!.parentElement!.className.split(/\s+/).includes("overflow-hidden")).toBe(true);
  await untilMotionEnds(() => !chatShown(host), "the slide over ends");
  expect(sideHasRow(host)).toBe(true);
  await run(() => drive.view("chat"));
  expect(slidesOf(started, "page-pane").at(-1)).toEqual(["translateX(0)", "translateX(100%)"]);
  expect([chatShown(host), sideShown(host)]).toEqual([true, true]);
  await untilMotionEnds(() => !sideShown(host), "the slide away ends");
});

test("asked for less motion, the layout changes at once and nothing moves", async () => {
  reducedMotion();
  measuredAs(1200);
  const started = recordAnimations();
  const drive = {} as Drive;
  const { host } = await mountAsync(<Driven bind={(d) => Object.assign(drive, d)} />);
  await run(() => drive.open(true));
  expect([sideShown(host), pane(host)!.style.width]).toEqual([true, "600px"]);
  await run(() => drive.maximize(true));
  expect([chatShown(host), sideHasRow(host)]).toEqual([false, true]);
  await run(() => drive.open(false));
  expect(sideShown(host)).toBe(false);
  expect(started.length).toBe(0);
});
