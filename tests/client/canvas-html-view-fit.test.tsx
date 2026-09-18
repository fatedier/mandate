import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CanvasHtmlView } from "@/routes/canvas/CanvasHtmlView";
import type { CanvasFit } from "@/routes/canvas/canvas-fit";
import type { CanvasDocumentDto } from "@shared/api-contracts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

const CANVAS: CanvasDocumentDto = {
  id: "cnv_1", title: "T", kind: "html", html: "<h1>Hi</h1>", contentRevision: 1,
  scope: "worker", scopeId: "f1", projectId: "p1", projectName: "P", projectSlug: "p",
  featureId: "f1", featureName: "F", featureSlug: "f", threadId: "t1",
  createdAt: "2026-09-15T09:00:00.000Z", updatedAt: "2026-09-15T09:00:00.000Z"
};

function postFromFrame(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  // The component checks event.source against the iframe's contentWindow.
  // happy-dom's MessageEvent (window.MessageEvent) accepts its own window as
  // the source; bun's native global MessageEvent rejects it.
  const event = new window.MessageEvent("message", { data, source: frame.contentWindow as Window });
  window.dispatchEvent(event);
}

test("a height report with a width wider than the container yields a scaled fit", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  const fits: Array<CanvasFit | null> = [];
  await act(async () => {
    root = createRoot(host!);
    root.render(<CanvasHtmlView canvas={CANVAS} onFitChange={(f) => fits.push(f)} containerWidth={358} />);
  });
  const frame = host!.querySelector("iframe")!;
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.height", canvasId: "cnv_1", value: 800, width: 1024 }); });
  const last = fits[fits.length - 1]!;
  expect(last.scale).toBeCloseTo(358 / 1024, 4);
  expect(frame.style.width).toBe("1024px");
  // 358/1024 is exact in binary, so the serialised scale is stable.
  expect(frame.style.transform).toBe("scale(0.349609375)");
  // happy-dom keeps the authored value; a browser would serialise it as "0px 0px".
  expect(frame.style.transformOrigin).toBe("0 0");
  const wrapper = frame.parentElement!;
  expect(wrapper.style.height).toBe(`${Math.ceil(800 * (358 / 1024))}px`);
});

test("a report without a width, or narrower than the container, leaves the frame at 100% and no transform", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  const fits: Array<CanvasFit | null> = [];
  await act(async () => {
    root = createRoot(host!);
    root.render(<CanvasHtmlView canvas={CANVAS} onFitChange={(f) => fits.push(f)} containerWidth={358} />);
  });
  const frame = host!.querySelector("iframe")!;
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.height", canvasId: "cnv_1", value: 300 }); });
  expect(fits[fits.length - 1]!.scale).toBe(1);
  expect(frame.style.width).toBe("100%");
  expect(frame.style.transform).toBe("");
  expect(frame.style.height).toBe("300px");
});

// A reported width is floored at the frame's own viewport, so a scaled frame
// pinned at that width would keep reporting it forever. A container change
// drops the stored width so the frame returns to 100% and the bridge
// re-measures at the new viewport.
async function mountScaledAt358(fits: Array<CanvasFit | null>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<CanvasHtmlView canvas={CANVAS} onFitChange={(f) => fits.push(f)} containerWidth={358} />);
  });
  const frame = host!.querySelector("iframe")!;
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.height", canvasId: "cnv_1", value: 800, width: 1024 }); });
  expect(frame.style.transform).toContain("scale(");
  return frame;
}

test("a wider container drops the stored width: the frame returns to 100% before any new report, and a re-report that fits stays unscaled", async () => {
  const fits: Array<CanvasFit | null> = [];
  const frame = await mountScaledAt358(fits);
  await act(async () => {
    root!.render(<CanvasHtmlView canvas={CANVAS} onFitChange={(f) => fits.push(f)} containerWidth={1200} />);
  });
  expect(frame.style.transform).toBe("");
  expect(frame.style.width).toBe("100%");
  expect(fits[fits.length - 1]!.scale).toBe(1);
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.height", canvasId: "cnv_1", value: 800, width: 1024 }); });
  expect(frame.style.transform).toBe("");
  expect(frame.style.width).toBe("100%");
  expect(frame.style.height).toBe("800px");
  expect(fits[fits.length - 1]!.scale).toBe(1);
});

test("a narrower container drops the stored width too, and a fresh report that is still too wide scales again", async () => {
  const fits: Array<CanvasFit | null> = [];
  const frame = await mountScaledAt358(fits);
  await act(async () => {
    root!.render(<CanvasHtmlView canvas={CANVAS} onFitChange={(f) => fits.push(f)} containerWidth={600} />);
  });
  expect(frame.style.transform).toBe("");
  expect(frame.style.width).toBe("100%");
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.height", canvasId: "cnv_1", value: 800, width: 1024 }); });
  expect(frame.style.transform).toContain("scale(");
  expect(frame.style.width).toBe("1024px");
  expect(fits[fits.length - 1]!.scale).toBeCloseTo(600 / 1024, 4);
});

test("fillParent never scales", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  const fits: Array<CanvasFit | null> = [];
  await act(async () => {
    root = createRoot(host!);
    root.render(<CanvasHtmlView canvas={CANVAS} fillParent onFitChange={(f) => fits.push(f)} containerWidth={358} />);
  });
  const frame = host!.querySelector("iframe")!;
  await act(async () => { postFromFrame(frame, { type: "mandate.canvas.height", canvasId: "cnv_1", value: 800, width: 1024 }); });
  expect(fits.length).toBe(0);
  expect(frame.style.transform).toBe("");
});
