import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { canvasBridgeScript, canvasRuntimeScript, readCanvasFrameMessage } from "@/routes/canvas/canvas-bridge";

test("frame messages are read only for this canvas and only when well formed", () => {
  expect(readCanvasFrameMessage({ type: "mandate.canvas.scroll", canvasId: "a", y: 120, height: 4000 }, "a")).toEqual({ type: "scroll", y: 120, height: 4000 });
  expect(readCanvasFrameMessage({ type: "mandate.canvas.scroll", canvasId: "b", y: 120, height: 4000 }, "a")).toBeNull();
  expect(readCanvasFrameMessage({ type: "mandate.canvas.scroll", canvasId: "a", y: "1", height: 4000 }, "a")).toBeNull();
  expect(readCanvasFrameMessage({ type: "mandate.canvas.zoom", canvasId: "a", wheel: -100, x: 10, y: 20 }, "a")).toEqual({ type: "zoom", wheel: -100, scale: null, x: 10, y: 20, scrollY: null, height: null });
  expect(readCanvasFrameMessage({ type: "mandate.canvas.zoom", canvasId: "a", scale: 1.05, x: 10, y: 20 }, "a")).toEqual({ type: "zoom", wheel: null, scale: 1.05, x: 10, y: 20, scrollY: null, height: null });
  expect(readCanvasFrameMessage({ type: "mandate.canvas.zoom", canvasId: "a", wheel: -100, scale: 1.05, x: 10, y: 20 }, "a")).toBeNull();
  expect(readCanvasFrameMessage({ type: "mandate.canvas.zoom", canvasId: "a", scale: 0, x: 10, y: 20 }, "a")).toBeNull();
  expect(readCanvasFrameMessage({ type: "mandate.canvas.key", canvasId: "a", key: "Escape" }, "a")).toEqual({ type: "key", key: "Escape", metaKey: false, ctrlKey: false, shiftKey: false });
  expect(readCanvasFrameMessage({ type: "mandate.canvas.height", canvasId: "a", value: 900 }, "a")).toBeNull();
  expect(readCanvasFrameMessage(null, "a")).toBeNull();
});

test("the bridge reports scroll and zoom gestures and takes theme and scroll-to messages", () => {
  const script = canvasBridgeScript("cnv_1");
  for (const piece of ['"mandate.canvas.scroll"', '"mandate.canvas.zoom"', '"mandate.canvas.key"', '"mandate.canvas.theme"', '"mandate.canvas.scrollTo"', "(pointer: coarse)", "gesturechange", "passive: false"]) {
    expect(script).toContain(piece);
  }
  for (const gone of ["mandate.canvas.height", "mandate.canvas.submit", "data-mandate-action"]) {
    expect(script).not.toContain(gone);
  }
  expect(canvasRuntimeScript()).toContain("installStorageFallback(\"localStorage\")");
});

test("the bridge reports the reader's own scrolling so a kept place can let go", () => {
  expect(readCanvasFrameMessage({ type: "mandate.canvas.interact", canvasId: "a" }, "a")).toEqual({ type: "interact" });
  expect(readCanvasFrameMessage({ type: "mandate.canvas.interact", canvasId: "b" }, "a")).toBeNull();
  const script = canvasBridgeScript("cnv_1");
  expect(script).toContain('"mandate.canvas.interact"');
  expect(script).toContain("touchmove");
});

test("any pointer press in the page counts as the reader acting (links, scrollbar drags)", () => {
  expect(canvasBridgeScript("cnv_1")).toContain('addEventListener("pointerdown", interacted');
});

test("wheel deltas in lines or pages are normalised to pixels before they are reported", () => {
  const script = canvasBridgeScript("cnv_1");
  expect(script).toContain("event.deltaMode === 1 ? event.deltaY * 40");
});

test("zoom reports carry the page's scroll", () => {
  expect(readCanvasFrameMessage({ type: "mandate.canvas.zoom", canvasId: "a", wheel: -100, x: 1, y: 2, scrollY: 900, height: 4000 }, "a"))
    .toEqual({ type: "zoom", wheel: -100, scale: null, x: 1, y: 2, scrollY: 900, height: 4000 });
  // And the bridge sends them: nothing else would notice zoom reports losing their scroll.
  expect(canvasBridgeScript("cnv_1")).toContain("scrollY: window.scrollY, height: pageHeight()");
});

test("the reader's own input is reported at once, ahead of any queued scroll report", () => {
  const script = canvasBridgeScript("cnv_1");
  // Sent synchronously from the input handler, not deferred to a frame.
  expect(script).toContain('const interacted = () => send({ type: "mandate.canvas.interact" });');
});

test("image-map areas open in a new tab too", () => {
  expect(canvasRuntimeScript()).toContain('closest("a[href], area[href]")');
});

test("the viewer's scroll-to jumps, even on a page with smooth scrolling", () => {
  expect(canvasBridgeScript("cnv_1")).toContain('window.scrollTo({ top: data.y, behavior: "instant" })');
});

/** The runtime and bridge run in a window of their own, as in the frame, so
 *  their listeners never reach the shared test window. `scrolledTo` names what
 *  the click scrolled to: an element's id or name, or "top". */
function clickInFrame(html: string, selector: string, artboard?: { path: string; boards: string[] }) {
  const frame = new Window({ url: "http://127.0.0.1:4173/api/canvases/cnv_1/assets/" });
  const intrinsics = frame as unknown as Record<string, unknown>;
  for (const key of ["Error", "TypeError", "SyntaxError", "RangeError"]) intrinsics[key] ??= (globalThis as Record<string, unknown>)[key];
  frame.document.body.innerHTML = html;
  const sent: Array<Record<string, unknown>> = [];
  (frame as unknown as { postMessage: (data: Record<string, unknown>) => void }).postMessage = (data) => { sent.push(data); };
  let scrolledTo: string | null = null;
  frame.HTMLElement.prototype.scrollIntoView = function (this: Element) { scrolledTo = this.id || this.getAttribute("name"); };
  (frame as unknown as { scrollTo: (options: { top: number }) => void }).scrollTo = (options) => { if (options.top === 0) scrolledTo = "top"; };
  const run = (script: string) => {
    const body = script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "document", "requestAnimationFrame", "ResizeObserver", body)(frame, frame.document, () => 0, undefined);
  };
  run(canvasRuntimeScript());
  run(canvasBridgeScript("cnv_1", { artboard }));
  // Last in line: note whether anything prevented the click, then stop the
  // test window from following the link.
  let prevented = false;
  frame.addEventListener("click", (event) => { prevented = event.defaultPrevented; event.preventDefault(); });
  const link = frame.document.querySelector(selector)!;
  link.dispatchEvent(new frame.MouseEvent("click", { bubbles: true, cancelable: true }));
  void frame.happyDOM.abort();
  return { prevented, scrolledTo, target: link.getAttribute("target"), sent };
}

test("an in-page link scrolls inside the report, to the element the browser would find", () => {
  const page = '<h2 id="概述">Overview</h2><a name="legacy">Old anchor</a><h2 id="plain">Plain</h2>' +
    '<a id="encoded" href="#%E6%A6%82%E8%BF%B0">a</a><a id="named" href="#legacy">b</a><a id="direct" href="#plain">c</a>' +
    '<a id="top-link" href="#top">d</a><a id="bare" href="#">e</a>';
  expect(clickInFrame(page, "#encoded")).toMatchObject({ prevented: true, scrolledTo: "概述" });
  expect(clickInFrame(page, "#named")).toMatchObject({ prevented: true, scrolledTo: "legacy" });
  expect(clickInFrame(page, "#direct")).toMatchObject({ prevented: true, scrolledTo: "plain" });
  expect(clickInFrame(page, "#top-link")).toMatchObject({ prevented: true, scrolledTo: "top" });
  expect(clickInFrame(page, "#bare")).toMatchObject({ prevented: true, scrolledTo: "top" });
});

test("an in-page link to nothing stays in the report instead of opening the report's folder", () => {
  const page = '<a id="missing" href="#nowhere">x</a><a id="out" href="https://github.com/acmecorp/project-1">y</a>';
  expect(clickInFrame(page, "#missing")).toMatchObject({ prevented: true, scrolledTo: null });
  // Other links still leave, in a new tab.
  expect(clickInFrame(page, "#out")).toMatchObject({ prevented: false, scrolledTo: null, target: "_blank" });
});

test("in an artboard, a link that names another board moves the design viewer to it", () => {
  const artboard = { path: "screens/Cart.html", boards: ["screens/Cart.html", "screens/Pay.html", "Main.html"] };
  const page = '<a id="rel" href="Pay.html">p</a><a id="up" href="../Main.html">m</a><a id="root" href="/Main.html?x=1#top">r</a>' +
    '<a id="other" href="Notes.html">n</a><a id="web" href="https://github.com">w</a><h2 id="s">S</h2><a id="hash" href="#s">h</a>' +
    // An external link whose path happens to name a board, behind whitespace
    // the URL parser trims.
    '<a id="spaced" href=" https://example.com/Main.html">x</a><a id="tabbed" href="\thttps://example.com/Main.html">t</a>';
  const go = (selector: string) => {
    const result = clickInFrame(page, selector, artboard);
    return { prevented: result.prevented, go: result.sent.filter((m) => m.type === "mandate.canvas.go").map((m) => m.path) };
  };
  expect(go("#rel")).toEqual({ prevented: true, go: ["screens/Pay.html"] });
  expect(go("#up")).toEqual({ prevented: true, go: ["Main.html"] });
  expect(go("#root")).toEqual({ prevented: true, go: ["Main.html"] });
  expect(go("#other")).toEqual({ prevented: false, go: [] });
  expect(go("#web")).toEqual({ prevented: false, go: [] });
  expect(go("#hash")).toEqual({ prevented: true, go: [] });
  expect(go("#spaced")).toEqual({ prevented: false, go: [] });
  expect(go("#tabbed")).toEqual({ prevented: false, go: [] });
  // A report's bridge has no board list and sends nothing.
  expect(clickInFrame(page, "#rel").sent.filter((m) => m.type === "mandate.canvas.go")).toStrictEqual([]);
  expect(readCanvasFrameMessage({ type: "mandate.canvas.go", canvasId: "a", path: "Pay.html" }, "a")).toEqual({ type: "go", path: "Pay.html" });
  expect(readCanvasFrameMessage({ type: "mandate.canvas.go", canvasId: "a", path: 3 }, "a")).toBeNull();
});

/** A wheel in a frame running the runtime and bridge; whether the bridge
 *  prevented it. happy-dom's WheelEvent drops the modifier keys: set them. */
function wheelInFrame(init: { ctrlKey?: boolean; metaKey?: boolean }, artboard?: { path: string; boards: string[] }) {
  const frame = new Window({ url: "http://127.0.0.1:4173/api/canvases/cnv_1/assets/" });
  const intrinsics = frame as unknown as Record<string, unknown>;
  for (const key of ["Error", "TypeError", "SyntaxError", "RangeError"]) intrinsics[key] ??= (globalThis as Record<string, unknown>)[key];
  (frame as unknown as { postMessage: () => void }).postMessage = () => {};
  const run = (script: string) => {
    const body = script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "document", "requestAnimationFrame", "ResizeObserver", body)(frame, frame.document, () => 0, undefined);
  };
  run(canvasRuntimeScript());
  run(canvasBridgeScript("cnv_1", { artboard }));
  const event = new frame.WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
  for (const [key, value] of [["ctrlKey", init.ctrlKey ?? false], ["metaKey", init.metaKey ?? false]] as const) {
    Object.defineProperty(event, key, { value });
  }
  frame.document.body.dispatchEvent(event);
  void frame.happyDOM.abort();
  return event.defaultPrevented;
}

test("in an artboard, a ⌘+wheel never reaches the browser (Firefox on a Mac zooms the page with it)", () => {
  const artboard = { path: "Main.html", boards: ["Main.html"] };
  expect(wheelInFrame({ metaKey: true }, artboard)).toBe(true);
  expect(wheelInFrame({ ctrlKey: true }, artboard)).toBe(true);
  expect(wheelInFrame({}, artboard)).toBe(false);
  // A report's bridge is as it was.
  expect(wheelInFrame({ metaKey: true })).toBe(false);
});
