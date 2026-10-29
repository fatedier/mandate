import { afterEach, expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { CanvasHtmlView } from "@/routes/canvas/CanvasHtmlView";
import { anchorAt, resolveCanvasView, scrollForAnchor, type CanvasView, type ResolvedCanvasView } from "@/routes/canvas/canvas-view";
import { useUIStore } from "@/store/ui";
import type { CanvasDocumentDto } from "@shared/api-contracts";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, type Mounted } from "../helpers/mount.js";

let mounted: Mounted | null = null;
// Unmount before the theme the view reads is reset under it.
afterEach(() => { runCleanups(); useUIStore.setState({ theme: "system" }); });

const CANVAS: CanvasDocumentDto = {
  id: "cnv_1", title: "Cache policy", kind: "report", html: "<title>Cache policy</title><h1>Hi</h1>", contentRevision: 1,
  scope: "worker", scopeId: "f1", projectId: "p1", projectName: "P", projectSlug: "p",
  featureId: "f1", featureName: "F", featureSlug: "f", threadId: "t1",
  createdAt: "2026-09-28T09:00:00.000Z", updatedAt: "2026-09-28T09:00:00.000Z"
};

async function render(view: CanvasView, resolved: ResolvedCanvasView, onViewChange: (view: CanvasView) => void = () => {}) {
  mounted = await mountAsync(<CanvasHtmlView canvas={CANVAS} view={view} resolved={resolved} onViewChange={onViewChange} />);
  return mounted.host.querySelector("iframe")!;
}

function postFromFrame(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  // happy-dom's MessageEvent accepts its own window as the source; bun's does not.
  window.dispatchEvent(new window.MessageEvent("message", { data, source: frame.contentWindow as Window }));
}

test("at 100% without Desktop site the frame fills the viewer and has no transform", async () => {
  const frame = await render({ desktop: null, zoom: null }, { desktop: false, zoom: 1, fit: true, layoutWidth: 390 });
  expect(frame.style.width).toBe("100%");
  expect(frame.style.height).toBe("100%");
  expect(frame.style.transform).toBe("");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
});

test("Desktop site lays the page out at its width and scales the frame to the viewer's height", async () => {
  const zoom = 390 / 1280;
  const frame = await render({ desktop: null, zoom: null }, { desktop: true, zoom, fit: true, layoutWidth: 1280 });
  expect(frame.style.width).toBe("1280px");
  expect(Number.parseFloat(frame.style.height)).toBeCloseTo(100 / zoom, 6);
  expect(frame.style.height.endsWith("%")).toBe(true);
  expect(frame.style.transform).toBe(`scale(${zoom})`);
  expect(frame.parentElement!.style.width).toBe(`${1280 * zoom}px`);
});

test("zoom without Desktop site reflows: the frame is wider and taller by 1/zoom and scaled back", async () => {
  const frame = await render({ desktop: null, zoom: 1.25 }, { desktop: false, zoom: 1.25, fit: false, layoutWidth: 312 });
  expect(frame.style.width).toBe("80%");
  expect(frame.style.height).toBe("80%");
  expect(frame.style.transform).toBe("scale(1.25)");
  expect(frame.parentElement!.style.width).toBe("100%");
});

test("a Ctrl+scroll notch from the page asks for the next ladder step", async () => {
  const onViewChange = mock((_: CanvasView) => {});
  const frame = await render({ desktop: null, zoom: null }, { desktop: false, zoom: 1, fit: true, layoutWidth: 390 }, onViewChange);
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "cnv_1", wheel: -100, x: 100, y: 200 }); });
  expect(onViewChange.mock.calls).toStrictEqual([[{ desktop: null, zoom: 1.1 }]]);
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "other", wheel: -100, x: 100, y: 200 }); });
  expect(onViewChange.mock.calls).toHaveLength(1);
});

test("a theme change after load is posted to the page instead of rebuilding it", async () => {
  useUIStore.setState({ theme: "light" });
  const frame = await render({ desktop: null, zoom: null }, { desktop: false, zoom: 1, fit: true, layoutWidth: 390 });
  const srcDoc = frame.getAttribute("srcdoc");
  const posted: unknown[] = [];
  (frame.contentWindow as Window).postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => { // happy-dom only accepts its own Event class.
    frame.dispatchEvent(new window.Event("load")); });
  await act(async () => { useUIStore.setState({ theme: "dark" }); });
  expect(posted).toContainEqual({ type: "mandate.canvas.theme", theme: "dark" });
  expect(frame.getAttribute("srcdoc")).toBe(srcDoc);
});

test("every load of the frame gets the current theme, and the frame delegates clipboard and fullscreen", async () => {
  useUIStore.setState({ theme: "light" });
  const frame = await render({ desktop: null, zoom: null }, { desktop: false, zoom: 1, fit: true, layoutWidth: 390 });
  expect(frame.getAttribute("allow")).toBe("clipboard-write *; fullscreen *");
  const posted: unknown[] = [];
  (frame.contentWindow as Window).postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => { frame.dispatchEvent(new window.Event("load")); });
  await act(async () => { useUIStore.setState({ theme: "dark" }); });
  posted.length = 0;
  // The page reloaded itself: it starts again from the srcdoc's theme.
  await act(async () => { frame.dispatchEvent(new window.Event("load")); });
  expect(posted).toContainEqual({ type: "mandate.canvas.theme", theme: "dark" });
});

async function renderControlled(view: CanvasView, resolved: ResolvedCanvasView) {
  const frame = await render(view, resolved);
  // happy-dom does no layout: give the viewer box the size a phone would.
  const box = frame.parentElement!.parentElement!;
  Object.defineProperty(box, "clientWidth", { configurable: true, value: 390 });
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 780 });
  const posted: unknown[] = [];
  (frame.contentWindow as Window).postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  // The page reports where it is: 500px down a 3000px page.
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.scroll", canvasId: "cnv_1", y: 500, height: 3000 }); });
  const rerender = async (nextView: CanvasView, nextResolved: ResolvedCanvasView) => {
    mounted!.rerender(<CanvasHtmlView canvas={CANVAS} view={nextView} resolved={nextResolved} onViewChange={() => {}} />);
  };
  const scrolls = () => posted.filter((m) => (m as { type?: string }).type === "mandate.canvas.scrollTo");
  return { frame, posted, rerender, scrolls };
}

test("a fit zoom recomputed from the viewer's width does not move the page", async () => {
  const { rerender, scrolls } = await renderControlled({ desktop: null, zoom: null }, { desktop: true, zoom: 1, fit: true, layoutWidth: 1280 });
  await rerender({ desktop: null, zoom: null }, { desktop: true, zoom: 0.5, fit: true, layoutWidth: 1280 });
  expect(scrolls()).toStrictEqual([]);
});

test("a zoom the reader chose keeps their place, until they scroll themselves", async () => {
  const { frame, rerender, scrolls, posted } = await renderControlled({ desktop: null, zoom: null }, { desktop: false, zoom: 1, fit: true, layoutWidth: 390 });
  await rerender({ desktop: null, zoom: 1.25 }, { desktop: false, zoom: 1.25, fit: false, layoutWidth: 312 });
  expect(scrolls().length).toBe(1);
  posted.length = 0;
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.interact", canvasId: "cnv_1" }); });
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.scroll", canvasId: "cnv_1", y: 1400, height: 3000 }); });
  expect(scrolls()).toStrictEqual([]);
});

function Harness() {
  const [view, setView] = useState<CanvasView>({ desktop: null, zoom: null });
  const resolved = resolveCanvasView(view, { declaredWidth: null, viewerWidth: 390 });
  return <CanvasHtmlView canvas={CANVAS} view={view} resolved={resolved} onViewChange={setView} />;
}

test("a continuous pinch keeps the point it started on, not one taken from a stale scroll", async () => {
  const { host } = await mountAsync(<Harness />);
  const frame = host.querySelector("iframe")!;
  const box = frame.parentElement!.parentElement!;
  Object.defineProperty(box, "clientWidth", { configurable: true, value: 390 });
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 780 });
  const posted: Array<{ type?: string; y?: number }> = [];
  (frame.contentWindow as Window).postMessage = ((message: { type?: string; y?: number }) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.scroll", canvasId: "cnv_1", y: 1000, height: 4000 }); });
  // Two pinch steps at the same point, before the page reports its new scroll.
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "cnv_1", wheel: -10, x: 100, y: 200 }); });
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "cnv_1", wheel: -10, x: 100, y: 200 }); });
  const finalZoom = Math.exp(0.2);
  const expected = scrollForAnchor(
    anchorAt({ ox: 100, oy: 200, scrollLeft: 0, scrollTop: 1000, zoom: 1, layoutWidth: 390, pageHeight: 4000 }),
    { zoom: finalZoom, layoutWidth: 390 / finalZoom, pageHeight: 4000 }
  ).scrollTop;
  const last = posted.filter((m) => m.type === "mandate.canvas.scrollTo").at(-1)!;
  expect(last.y!).toBeCloseTo(expected, 6);
});

test("pressing the viewer's own scrollbar lets a kept place go", async () => {
  const { frame, rerender, scrolls, posted } = await renderControlled({ desktop: null, zoom: null }, { desktop: true, zoom: 0.5, fit: true, layoutWidth: 1280 });
  await rerender({ desktop: null, zoom: 1 }, { desktop: true, zoom: 1, fit: false, layoutWidth: 1280 });
  expect(scrolls().length).toBe(1);
  posted.length = 0;
  const box = frame.parentElement!.parentElement!;
  await act(async () => { box.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })); });
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.scroll", canvasId: "cnv_1", y: 900, height: 3000 }); });
  expect(scrolls()).toStrictEqual([]);
});

test("a gesture right after a scroll anchors on the scroll the page reports with it", async () => {
  const { host } = await mountAsync(<Harness />);
  const frame = host.querySelector("iframe")!;
  const box = frame.parentElement!.parentElement!;
  Object.defineProperty(box, "clientWidth", { configurable: true, value: 390 });
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 780 });
  const posted: Array<{ type?: string; y?: number }> = [];
  (frame.contentWindow as Window).postMessage = ((message: { type?: string; y?: number }) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.scroll", canvasId: "cnv_1", y: 0, height: 4000 }); });
  // The reader scrolled to 2000 and zoomed before the scroll report arrived.
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "cnv_1", wheel: -100, x: 100, y: 200, scrollY: 2000, height: 4000 }); });
  const expected = scrollForAnchor(
    anchorAt({ ox: 100, oy: 200, scrollLeft: 0, scrollTop: 2000, zoom: 1, layoutWidth: 390, pageHeight: 4000 }),
    { zoom: 1.1, layoutWidth: 390 / 1.1, pageHeight: 4000 }
  ).scrollTop;
  const last = posted.filter((m) => m.type === "mandate.canvas.scrollTo").at(-1)!;
  expect(last.y!).toBeCloseTo(expected, 6);
});

let setHarnessView: (view: CanvasView) => void = () => {};
function ExposedHarness() {
  const [view, setView] = useState<CanvasView>({ desktop: null, zoom: null });
  setHarnessView = setView;
  const resolved = resolveCanvasView(view, { declaredWidth: null, viewerWidth: 390 });
  return <CanvasHtmlView canvas={CANVAS} view={view} resolved={resolved} onViewChange={setView} />;
}

test("a pinch right after a menu zoom anchors on its own point, not the menu's centre", async () => {
  const { host } = await mountAsync(<ExposedHarness />);
  const frame = host.querySelector("iframe")!;
  const box = frame.parentElement!.parentElement!;
  Object.defineProperty(box, "clientWidth", { configurable: true, value: 390 });
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 780 });
  const posted: Array<{ type?: string; y?: number }> = [];
  (frame.contentWindow as Window).postMessage = ((message: { type?: string; y?: number }) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.scroll", canvasId: "cnv_1", y: 1000, height: 4000 }); });
  await act(async () => { setHarnessView({ desktop: null, zoom: 1.25 }); });
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "cnv_1", wheel: -100, x: 300, y: 600, scrollY: 1100, height: 4000 }); });
  const expected = scrollForAnchor(
    anchorAt({ ox: 300 * 1.25, oy: 600 * 1.25, scrollLeft: 0, scrollTop: 1100, zoom: 1.25, layoutWidth: 390 / 1.25, pageHeight: 4000 }),
    { zoom: 1.5, layoutWidth: 390 / 1.5, pageHeight: 4000 }
  ).scrollTop;
  const last = posted.filter((m) => m.type === "mandate.canvas.scrollTo").at(-1)!;
  expect(last.y!).toBeCloseTo(expected, 6);
});

test("zoom steps delivered before a re-render add up", async () => {
  const { host } = await mountAsync(<Harness />);
  const frame = host.querySelector("iframe")!;
  await act(async () => {
    postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "cnv_1", wheel: -100, x: 100, y: 200 });
    postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "cnv_1", wheel: -100, x: 100, y: 200 });
  });
  expect(frame.style.transform).toBe("scale(1.25)");
});

test("a menu zoom right after a pinch anchors on the current centre, not the pinch's point", async () => {
  const { host } = await mountAsync(<ExposedHarness />);
  const frame = host.querySelector("iframe")!;
  const box = frame.parentElement!.parentElement!;
  Object.defineProperty(box, "clientWidth", { configurable: true, value: 390 });
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 780 });
  const posted: Array<{ type?: string; y?: number }> = [];
  (frame.contentWindow as Window).postMessage = ((message: { type?: string; y?: number }) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.scroll", canvasId: "cnv_1", y: 1000, height: 4000 }); });
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "cnv_1", wheel: -100, x: 300, y: 600, scrollY: 1000, height: 4000 }); });
  const afterPinch = posted.filter((m) => m.type === "mandate.canvas.scrollTo").at(-1)!.y!;
  // The page reports where the pinch left it; then, still within the hold, a menu zoom.
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.scroll", canvasId: "cnv_1", y: afterPinch, height: 4000 }); });
  await act(async () => { setHarnessView({ desktop: null, zoom: 1.25 }); });
  const expected = scrollForAnchor(
    anchorAt({ ox: 195, oy: 390, scrollLeft: 0, scrollTop: afterPinch, zoom: 1.1, layoutWidth: 390 / 1.1, pageHeight: 4000 }),
    { zoom: 1.25, layoutWidth: 390 / 1.25, pageHeight: 4000 }
  ).scrollTop;
  const last = posted.filter((m) => m.type === "mandate.canvas.scrollTo").at(-1)!;
  expect(last.y!).toBeCloseTo(expected, 6);
});

async function exposed() {
  const { host } = await mountAsync(<ExposedHarness />);
  const frame = host.querySelector("iframe")!;
  const box = frame.parentElement!.parentElement!;
  Object.defineProperty(box, "clientWidth", { configurable: true, value: 390 });
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 780 });
  const posted: Array<{ type?: string; y?: number }> = [];
  (frame.contentWindow as Window).postMessage = ((message: { type?: string; y?: number }) => { posted.push(message); }) as Window["postMessage"];
  const lastScrollTo = () => posted.filter((m) => m.type === "mandate.canvas.scrollTo").at(-1)!.y!;
  return { frame, lastScrollTo };
}

test("a pinch that drifts slowly re-anchors once it is far from where its anchor was taken", async () => {
  const { frame, lastScrollTo } = await exposed();
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.scroll", canvasId: "cnv_1", y: 1000, height: 4000 }); });
  const step = async (x: number) => {
    await act(async () => { postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "cnv_1", wheel: -3, x, y: 200 }); });
  };
  await step(100);
  await step(115);
  const afterSecond = lastScrollTo();
  await step(130); // 38px from where the anchor was taken: a new one here
  await step(145); // 21px from that one: reused
  const z2 = Math.exp(0.06);
  const z4 = Math.exp(0.12);
  const anchor = anchorAt({ ox: 130 * z2, oy: 200 * z2, scrollLeft: 0, scrollTop: afterSecond, zoom: z2, layoutWidth: 390 / z2, pageHeight: 4000 });
  expect(lastScrollTo()).toBeCloseTo(scrollForAnchor(anchor, { zoom: z4, layoutWidth: 390 / z4, pageHeight: 4000 }).scrollTop, 6);
});

test("the centre follows the scroll the viewer just asked for, before the page reports it", async () => {
  const { frame, lastScrollTo } = await exposed();
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.scroll", canvasId: "cnv_1", y: 1000, height: 4000 }); });
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.zoom", canvasId: "cnv_1", wheel: -100, x: 300, y: 600, scrollY: 1000, height: 4000 }); });
  const afterPinch = lastScrollTo();
  // No scroll report yet; a menu zoom.
  await act(async () => { setHarnessView({ desktop: null, zoom: 1.25 }); });
  const expected = scrollForAnchor(
    anchorAt({ ox: 195, oy: 390, scrollLeft: 0, scrollTop: afterPinch, zoom: 1.1, layoutWidth: 390 / 1.1, pageHeight: 4000 }),
    { zoom: 1.25, layoutWidth: 390 / 1.25, pageHeight: 4000 }
  ).scrollTop;
  expect(lastScrollTo()).toBeCloseTo(expected, 6);
});
