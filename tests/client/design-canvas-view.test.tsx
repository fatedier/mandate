import { expect, test } from "bun:test";
import { act, useState } from "react";
import { DesignCanvasView } from "@/routes/canvas/DesignCanvasView";
import { DesignViewControls } from "@/routes/canvas/DesignViewControls";
import { useDesignViewer, type DesignViewer } from "@/routes/canvas/use-design-viewer";
import { stepDesignZoom } from "@/routes/canvas/design-camera";
import type { DesignBoard, DesignNote, DesignSnapshot } from "@shared/api-contracts";
import { mountAsync } from "../helpers/mount.js";
import { CanvasShownContext } from "@/routes/canvas/canvas-shown";

let host: HTMLElement | null = null;

const STAGE = { width: 1000, height: 700 };
const board = (path: string, x: number, page = "flows", extra: Partial<DesignBoard> = {}): DesignBoard =>
  ({ path, x, y: 0, w: 390, h: 844, title: path.replace(".html", ""), page, expand: null, interactive: false, radius: 0, ...extra });
const note = (id: string, kind: "title1" | "sticky", extra: Partial<DesignNote> = {}): DesignNote =>
  ({ id, kind, x: 0, y: -300, text: id, page: "flows", w: null, maxW: null, maxH: null, size: null, bold: false, italic: false, color: null, fill: null, ...extra });

function snapshot(overrides: Partial<DesignSnapshot["index"]> = {}, artboards?: Record<string, string>): DesignSnapshot {
  const index = {
    title: "Checkout redesign",
    pages: [{ id: "flows", name: "Flows" }, { id: "empty", name: "Empty states" }],
    boards: [board("Cart.html", 0, "flows", { interactive: true }), board("Pay.html", 470), board("Empty.html", 0, "empty")],
    notes: [note("Row", "title1", { maxW: 860 }), note("Why", "sticky", { x: 0, y: 944, w: 240, fill: "yellow" })],
    launch: { view: "canvas" as const, page: "flows" },
    ...overrides
  };
  return { index, artboards: artboards ?? Object.fromEntries(index.boards.map((b) => [b.path, `<p>${b.path}</p>`])) };
}

let viewer!: DesignViewer;
let setDesign!: (design: DesignSnapshot, revision?: number) => void;
function Harness({ initial, shown = true }: { initial: DesignSnapshot; shown?: boolean }) {
  const [{ design, revision }, set] = useState({ design: initial, revision: 1 });
  setDesign = (next, nextRevision = revision) => set({ design: next, revision: nextRevision });
  viewer = useDesignViewer("cnv_d", design, STAGE);
  return (
    <div>
      <DesignViewControls viewer={viewer} />
      <CanvasShownContext.Provider value={shown}>
        <div data-slot="canvas-view">
          <DesignCanvasView canvasId="cnv_d" design={design} revision={revision} viewer={viewer} />
        </div>
      </CanvasShownContext.Provider>
      <input data-slot="beside" aria-label="Thread title" />
    </div>
  );
}

async function render(design = snapshot(), shown = true) {
  host = (await mountAsync(<Harness initial={design} shown={shown} />)).host;
  return host;
}

const stage = () => host!.querySelector<HTMLElement>('[data-slot="design-stage"]')!;
const world = () => host!.querySelector<HTMLElement>('[data-slot="design-world"]')!;
/** A pointer event as a browser sends it: the primary button held while pressed. */
const pointer = (type: string, init: PointerEventInit) =>
  new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1, ...init });
/** happy-dom's WheelEvent drops the MouseEvent fields (ctrlKey, clientX…): set them by hand. */
const wheel = (init: { deltaX?: number; deltaY: number; deltaMode?: number; ctrlKey?: boolean; clientX?: number; clientY?: number }) => {
  const event = new window.WheelEvent("wheel", { deltaX: init.deltaX ?? 0, deltaY: init.deltaY, bubbles: true, cancelable: true });
  for (const [key, value] of [["ctrlKey", init.ctrlKey ?? false], ["metaKey", false], ["clientX", init.clientX ?? 0], ["clientY", init.clientY ?? 0], ["deltaMode", init.deltaMode ?? 0]] as const) {
    Object.defineProperty(event, key, { value });
  }
  return event;
};

test("the canvas view draws this page's boards as frames at their places, with name strips, a ▶ for interactive ones, and notes", async () => {
  const el = await render();
  const frames = [...el.querySelectorAll("iframe")];
  expect(frames.map((f) => f.getAttribute("data-artboard"))).toEqual(["Cart.html", "Pay.html"]);
  const wrapper = el.querySelector<HTMLElement>('[data-board="Pay.html"]')!;
  expect([wrapper.style.left, wrapper.style.top, wrapper.style.width, wrapper.style.height]).toEqual(["470px", "0px", "390px", "844px"]);
  expect(el.querySelector('[aria-label="Try Cart"]')).not.toBeNull();
  expect(el.querySelector('[aria-label="Try Pay"]') === null).toBe(true);
  expect([...el.querySelectorAll('[data-slot="design-note"]')].map((n) => [n.getAttribute("data-kind"), n.textContent])).toEqual([["title1", "Row"], ["sticky", "Why"]]);
  // Fitted at launch: the world is scaled below 100%.
  expect(viewer.fitted).toBe(true);
  expect(world().style.transform).toContain(`scale(${viewer.camera.z})`);
  expect(viewer.camera.z).toBeLessThan(1);
});

test("a click (a press that did not move) on an artboard focuses it; a drag pans instead", async () => {
  await render();
  const before = viewer.camera;
  const pay = host!.querySelector<HTMLElement>('[data-board="Pay.html"]')!;
  await act(async () => {
    pay.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 500, clientY: 300 }));
    pay.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 540, clientY: 320 }));
    pay.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 540, clientY: 320 }));
  });
  expect(viewer.focused).toBeNull();
  // The first 3 px of each axis tell a drag from a tap and do not pan.
  expect(viewer.camera).toEqual({ x: before.x + 37, y: before.y + 17, z: before.z });
  expect(viewer.fitted).toBe(false);
  await act(async () => {
    pay.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 500, clientY: 300 }));
    pay.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 501, clientY: 300 }));
  });
  expect(viewer.focused?.path).toBe("Pay.html");
  const frame = host!.querySelector<HTMLIFrameElement>('[data-slot="design-focus"] iframe')!;
  expect(frame.getAttribute("data-artboard")).toBe("Pay.html");
  expect(frame.style.pointerEvents).toBe("auto");
});

test("Ctrl+wheel zooms around the pointer; a plain wheel pans", async () => {
  await render();
  const start = viewer.camera;
  await act(async () => { stage().dispatchEvent(wheel({ deltaX: 10, deltaY: 30 })); });
  expect(viewer.camera).toEqual({ x: start.x - 10, y: start.y - 30, z: start.z });
  // A mouse notch steps the ladder, as in a report.
  await act(async () => { stage().dispatchEvent(wheel({ deltaY: -100, ctrlKey: true })); });
  expect(viewer.camera.z).toBe(stepDesignZoom(start.z, 1));
});

test("the focused view walks this page's boards, and a go message from the focused frame moves it", async () => {
  await render();
  await act(async () => { viewer.focus("Cart.html"); });
  expect(viewer.focusIndex).toBe(0);
  await act(async () => { viewer.next(); });
  expect(viewer.focused?.path).toBe("Pay.html");
  await act(async () => { viewer.next(); });
  expect(viewer.focused?.path).toBe("Pay.html");
  const frame = host!.querySelector<HTMLIFrameElement>('[data-slot="design-focus"] iframe')!;
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.go", canvasId: "cnv_d", path: "Cart.html" }, source: frame.contentWindow as Window }));
  });
  expect(viewer.focused?.path).toBe("Cart.html");
  // From anywhere but the focused frame, or naming no board, it does nothing.
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.go", canvasId: "cnv_d", path: "Pay.html" }, source: window }));
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.go", canvasId: "cnv_d", path: "Ghost.html" }, source: frame.contentWindow as Window }));
  });
  expect(viewer.focused?.path).toBe("Cart.html");
});

test("focusing a board on another page switches the page; back returns to the page and camera it left", async () => {
  await render();
  await act(async () => { viewer.panBy(30, 40); });
  const camera = viewer.camera;
  await act(async () => { viewer.focus("Empty.html"); });
  expect(viewer.page).toBe("empty");
  expect(viewer.focused?.path).toBe("Empty.html");
  await act(async () => { viewer.unfocus(); });
  expect(viewer.page).toBe("flows");
  expect(viewer.camera).toEqual(camera);
  expect([...host!.querySelectorAll("iframe")].map((f) => f.getAttribute("data-artboard"))).toEqual(["Cart.html", "Pay.html"]);
});

test("Esc in the focused view returns to the canvas and never reaches the modal; back restores the camera", async () => {
  await render();
  await act(async () => { viewer.panBy(123, 45); });
  const camera = viewer.camera;
  await act(async () => { viewer.focus("Pay.html"); });
  let reachedWindow = false;
  const onWindow = () => { reachedWindow = true; };
  window.addEventListener("keydown", onWindow);
  try {
    await act(async () => { document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  } finally {
    window.removeEventListener("keydown", onWindow);
  }
  expect(viewer.focused).toBeNull();
  expect(reachedWindow).toBe(false);
  expect(viewer.camera).toEqual(camera);
  // Esc on the canvas view is left alone (the modal closes on it).
  reachedWindow = false;
  window.addEventListener("keydown", onWindow);
  try {
    await act(async () => { document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  } finally {
    window.removeEventListener("keydown", onWindow);
  }
  expect(reachedWindow).toBe(true);
});

test("a key message for Escape from the focused frame returns to the canvas", async () => {
  await render();
  await act(async () => { viewer.focus("Pay.html"); });
  const frame = host!.querySelector<HTMLIFrameElement>('[data-slot="design-focus"] iframe')!;
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.key", canvasId: "cnv_d", key: "Escape" }, source: frame.contentWindow as Window }));
  });
  expect(viewer.focused).toBeNull();
});

test("a republish keeps the page, the camera and the focused artboard", async () => {
  await render();
  await act(async () => { viewer.setPage("empty"); });
  await act(async () => { viewer.panBy(10, 10); });
  const camera = viewer.camera;
  await act(async () => { setDesign(snapshot({}, { "Cart.html": "<p>v2</p>", "Pay.html": "<p>v2</p>", "Empty.html": "<p>v2</p>" })); });
  expect(viewer.page).toBe("empty");
  expect(viewer.camera).toEqual(camera);
  await act(async () => { viewer.focus("Empty.html"); });
  await act(async () => { setDesign(snapshot({}, { "Cart.html": "<p>v3</p>", "Pay.html": "<p>v3</p>", "Empty.html": "<p>v3</p>" })); });
  expect(viewer.focused?.path).toBe("Empty.html");
  // A board that no longer exists drops the focus.
  await act(async () => { setDesign(snapshot({ boards: [board("Cart.html", 0)] }, { "Cart.html": "<p>v4</p>" })); });
  expect(viewer.focused).toBeNull();
});

test("a focused launch opens on its board; the controls show pages and zoom, and focused-view controls", async () => {
  const el = await render(snapshot({ launch: { view: "focused", path: "Pay.html" } }));
  expect(viewer.focused?.path).toBe("Pay.html");
  expect(el.querySelector('[aria-label="Previous artboard"]')).not.toBeNull();
  expect(el.querySelector('[aria-label="Next artboard"]')).not.toBeNull();
  expect(el.textContent).toContain("2 / 2");
  await act(async () => { viewer.unfocus(); });
  expect(el.querySelector('[aria-label="Page, Flows"]')).not.toBeNull();
  expect(el.querySelector(`[aria-label="Zoom, ${Math.round(viewer.camera.z * 100)}%"]`)).not.toBeNull();
});

test("a design without named pages shows no page menu", async () => {
  const el = await render(snapshot({ pages: [{ id: "main", name: "" }], boards: [board("Cart.html", 0, "main")], notes: [], launch: { view: "canvas", page: "main" } }));
  expect(el.querySelector('[aria-label^="Page,"]') === null).toBe(true);
});

test("a row title longer than its maxW shrinks to fit it; one that fits keeps its size", async () => {
  // happy-dom has no layout: at 72 px the title measures 1720 px, in proportion to its font size.
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
  Object.defineProperty(proto, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) { return this.getAttribute("data-kind") === "title1" ? (parseFloat(this.style.fontSize) / 72) * 1720 : 0; }
  });
  try {
    const el = await render(snapshot({ notes: [note("Long", "title1", { maxW: 860 }), note("Short", "title1", { y: -600, maxW: 2000 })] }));
    const titles = [...el.querySelectorAll<HTMLElement>('[data-slot="design-note"][data-kind="title1"]')];
    expect(titles.map((t) => [t.textContent, t.style.fontSize])).toEqual([["Long", "36px"], ["Short", "72px"]]);
  } finally {
    if (original) Object.defineProperty(proto, "scrollWidth", original);
    else delete (proto as { scrollWidth?: number }).scrollWidth;
  }
});

test("Ctrl+wheel events that arrive before a render all count", async () => {
  await render();
  const z = viewer.camera.z;
  await act(async () => {
    stage().dispatchEvent(wheel({ deltaY: -50, ctrlKey: true }));
    stage().dispatchEvent(wheel({ deltaY: -50, ctrlKey: true }));
  });
  expect(viewer.camera.z).toBe(stepDesignZoom(stepDesignZoom(z, 1), 1));
});

test("a press the browser cancelled does not focus", async () => {
  await render();
  const pay = host!.querySelector<HTMLElement>('[data-board="Pay.html"]')!;
  await act(async () => {
    pay.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 500, clientY: 300 }));
    pay.dispatchEvent(pointer("pointercancel", { pointerId: 1, clientX: 500, clientY: 300 }));
  });
  expect(viewer.focused).toBeNull();
});

test("a republish that moves the focused board to another page follows it there", async () => {
  await render();
  await act(async () => { viewer.focus("Pay.html"); });
  await act(async () => { setDesign(snapshot({ boards: [board("Cart.html", 0), board("Pay.html", 470, "empty"), board("Empty.html", 0, "empty")] })); });
  expect(viewer.focused?.path).toBe("Pay.html");
  expect(viewer.page).toBe("empty");
  expect(host!.textContent).toContain("1 / 2");
});

test("a republish with a new revision reloads the frames, even when no page changed; the same revision keeps them", async () => {
  await render();
  const before = host!.querySelector('iframe[data-artboard="Cart.html"]');
  await act(async () => { setDesign(snapshot(), 2); });
  const after = host!.querySelector('iframe[data-artboard="Cart.html"]');
  expect(after !== null && after !== before).toBe(true);
  await act(async () => { setDesign(snapshot(), 2); });
  expect(host!.querySelector('iframe[data-artboard="Cart.html"]') === after).toBe(true);
});

test("the wheel over a sticky note with more to show scrolls the note; at its end it pans the canvas", async () => {
  await render();
  const sticky = host!.querySelector<HTMLElement>('[data-kind="sticky"]')!;
  for (const [key, value] of [["scrollHeight", 500], ["clientHeight", 200], ["scrollTop", 0]] as const) {
    Object.defineProperty(sticky, key, { configurable: true, value });
  }
  const camera = viewer.camera;
  const inside = wheel({ deltaY: 30 });
  await act(async () => { sticky.dispatchEvent(inside); });
  expect(viewer.camera).toEqual(camera);
  expect(inside.defaultPrevented).toBe(false);
  Object.defineProperty(sticky, "scrollTop", { configurable: true, value: 300 });
  const atEnd = wheel({ deltaY: 30 });
  await act(async () => { sticky.dispatchEvent(atEnd); });
  expect(viewer.camera).toEqual({ ...camera, y: camera.y - 30 });
  expect(atEnd.defaultPrevented).toBe(true);
});

test("a fill artboard in the focused view fills the stage, with no padding around it", async () => {
  await render(snapshot({ boards: [board("Cart.html", 0, "flows", { expand: "fill" }), board("Pay.html", 470)] }));
  await act(async () => { viewer.focus("Cart.html"); });
  const focus = () => host!.querySelector<HTMLElement>('[data-slot="design-focus"]')!;
  expect(focus().style.padding).toBe("0px");
  const frame = focus().querySelector("iframe")!;
  expect([frame.style.width, frame.style.height]).toEqual(["1000px", "700px"]);
  await act(async () => { viewer.focus("Pay.html"); });
  expect(focus().style.padding).toBe("24px");
});

test("a wheel that scrolls in lines pans by their pixels", async () => {
  await render();
  const camera = viewer.camera;
  await act(async () => { stage().dispatchEvent(wheel({ deltaY: 3, deltaMode: 1 })); });
  expect(viewer.camera).toEqual({ ...camera, y: camera.y - 120 });
});

test("a finger on a sticky note with more to show scrolls the note; a mouse drag there still pans", async () => {
  await render();
  const sticky = host!.querySelector<HTMLElement>('[data-kind="sticky"]')!;
  for (const [key, value] of [["scrollHeight", 500], ["clientHeight", 200]] as const) {
    Object.defineProperty(sticky, key, { configurable: true, value });
  }
  expect(sticky.style.touchAction).toBe("pan-y");
  const camera = viewer.camera;
  await act(async () => {
    sticky.dispatchEvent(pointer("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 }));
    sticky.dispatchEvent(pointer("pointermove", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 60 }));
    sticky.dispatchEvent(pointer("pointerup", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 60 }));
  });
  expect(viewer.camera).toEqual(camera);
  await act(async () => {
    sticky.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 }));
    sticky.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 100, clientY: 60 }));
    sticky.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 100, clientY: 60 }));
  });
  expect(viewer.camera).toEqual({ ...camera, y: camera.y - 37 });
});

test("a sticky note wraps a long word instead of scrolling sideways", async () => {
  const el = await render();
  const sticky = el.querySelector<HTMLElement>('[data-kind="sticky"]')!;
  expect([sticky.style.overflowX, sticky.style.overflowY, sticky.style.overflowWrap]).toEqual(["hidden", "auto", "anywhere"]);
});

test("a republish that removes the focused board returns to the canvas view it was opened from", async () => {
  await render();
  await act(async () => { viewer.panBy(30, 40); });
  const camera = viewer.camera;
  // A prototype link took the focus to another page's board.
  await act(async () => { viewer.focus("Empty.html"); });
  expect(viewer.page).toBe("empty");
  await act(async () => { setDesign(snapshot({ boards: [board("Cart.html", 0), board("Pay.html", 470), board("Other.html", 0, "empty")] }), 2); });
  expect(viewer.focused).toBeNull();
  expect(viewer.page).toBe("flows");
  expect(viewer.camera).toEqual(camera);
});

test("a Ctrl+wheel or a pinch anywhere in the focused view never zooms the browser page; a plain wheel scrolls", async () => {
  await render();
  await act(async () => { viewer.focus("Pay.html"); });
  const focus = host!.querySelector<HTMLElement>('[data-slot="design-focus"]')!;
  const zoomWheel = wheel({ deltaY: -100, ctrlKey: true });
  const plain = wheel({ deltaY: 30 });
  const gesture = new window.Event("gesturestart", { bubbles: true, cancelable: true });
  const change = new window.Event("gesturechange", { bubbles: true, cancelable: true });
  await act(async () => { for (const event of [zoomWheel, plain, gesture, change]) focus.dispatchEvent(event); });
  expect([zoomWheel.defaultPrevented, gesture.defaultPrevented, change.defaultPrevented]).toEqual([true, true, true]);
  expect(plain.defaultPrevented).toBe(false);
});

test("a sticky note keeps the line breaks in its text", async () => {
  const el = await render();
  expect(el.querySelector<HTMLElement>('[data-kind="sticky"]')!.style.whiteSpace).toBe("pre-wrap");
});

test("a row title is measured again when it turns italic", async () => {
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
  // Italic glyphs are wider in this font: 1720 px upright, 2150 px italic, at 72 px.
  Object.defineProperty(proto, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute("data-kind") !== "title1") return 0;
      return (parseFloat(this.style.fontSize) / 72) * (this.style.fontStyle === "italic" ? 2150 : 1720);
    }
  });
  try {
    const el = await render(snapshot({ notes: [note("Long", "title1", { maxW: 860 })] }));
    const title = () => el.querySelector<HTMLElement>('[data-kind="title1"]')!;
    expect(title().style.fontSize).toBe("36px");
    await act(async () => { setDesign(snapshot({ notes: [note("Long", "title1", { maxW: 860, italic: true })] }), 2); });
    expect(title().style.fontSize).toBe("28.8px");
  } finally {
    if (original) Object.defineProperty(proto, "scrollWidth", original);
    else delete (proto as { scrollWidth?: number }).scrollWidth;
  }
});

test("a held Esc that closed the focused view's menu does not also leave the focused view", async () => {
  await render();
  await act(async () => { viewer.focus("Pay.html"); });
  const trigger = host!.querySelector<HTMLElement>('[aria-label="Zoom, Fit"]')!;
  await act(async () => { trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await act(async () => { document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
  await act(async () => { document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true, cancelable: true })); });
  expect(viewer.focused?.path).toBe("Pay.html");
});

test("a drag that starts on a name strip's button pans, and does not focus", async () => {
  await render();
  const button = host!.querySelector<HTMLElement>('[aria-label="Try Cart"]')!;
  const camera = viewer.camera;
  await act(async () => {
    button.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 }));
    button.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 140, clientY: 100 }));
    stage().dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 140, clientY: 100 }));
  });
  expect(viewer.camera).toEqual({ ...camera, x: camera.x + 37 });
  expect(viewer.focused).toBeNull();
});

test("two quick presses on the zoom menu's + step twice", async () => {
  await render();
  const z = viewer.camera.z;
  const trigger = host!.querySelector<HTMLElement>('[aria-label^="Zoom, "]')!;
  await act(async () => { trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  const zoomIn = document.querySelector<HTMLElement>('[aria-label="Zoom in"]')!;
  await act(async () => { zoomIn.click(); zoomIn.click(); });
  expect(viewer.camera.z).toBe(stepDesignZoom(stepDesignZoom(z, 1), 1));
});

test("a third finger moving alone changes nothing, Fit all included", async () => {
  await render();
  const touch = (type: string, pointerId: number, clientX: number) =>
    stage().dispatchEvent(pointer(type, { pointerId, pointerType: "touch", clientX, clientY: 300 }));
  await act(async () => {
    touch("pointerdown", 1, 400);
    touch("pointerdown", 2, 600);
    touch("pointerdown", 3, 800);
    touch("pointermove", 3, 900);
  });
  expect(viewer.fitted).toBe(true);
});

test("a release from a pointer the stage never saw pressed does nothing", async () => {
  await render();
  const cart = host!.querySelector<HTMLElement>('[data-board="Cart.html"]')!;
  await act(async () => {
    cart.dispatchEvent(pointer("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 }));
    cart.dispatchEvent(pointer("pointerup", { pointerId: 2, clientX: 100, clientY: 100 }));
  });
  expect(viewer.focused).toBeNull();
  // The finger's own release is still a click.
  await act(async () => { cart.dispatchEvent(pointer("pointerup", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 })); });
  expect(viewer.focused?.path).toBe("Cart.html");
});

test("the canvas's artboards cannot take focus (inert); the focused one can", async () => {
  await render();
  expect(host!.querySelector('[data-slot="design-stage"] iframe')!.hasAttribute("inert")).toBe(true);
  await act(async () => { viewer.focus("Pay.html"); });
  expect(host!.querySelector('[data-slot="design-focus"] iframe')!.hasAttribute("inert")).toBe(false);
});

test("a drag across the canvas selects no text, and a name strip is never wider than its board on screen", async () => {
  await render();
  expect(stage().classList.contains("select-none")).toBe(true);
  const strip = host!.querySelector<HTMLElement>('[data-board="Cart.html"] [data-slot="name-strip"]')!;
  expect(strip.style.maxWidth).toBe(`${390 * viewer.camera.z}px`);
});

test("one Ctrl+wheel notch zooms one step and one wheel pans once, also after the gesture has ended", async () => {
  await render();
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  const z = viewer.camera.z;
  await act(async () => { stage().dispatchEvent(wheel({ deltaY: -100, ctrlKey: true })); });
  await settle();
  expect(viewer.camera.z).toBe(stepDesignZoom(z, 1));
  const camera = viewer.camera;
  await act(async () => { stage().dispatchEvent(wheel({ deltaY: 30 })); });
  await settle();
  expect(viewer.camera).toEqual({ ...camera, y: camera.y - 30 });
});

test("a prototype link to another page keeps the canvas it will return to loaded", async () => {
  await render();
  const before = host!.querySelector('[data-slot="design-stage"] iframe[data-artboard="Cart.html"]');
  await act(async () => { viewer.focus("Pay.html"); });
  // A prototype link takes the focus to a board on another page.
  await act(async () => { viewer.focus("Empty.html"); });
  expect(host!.querySelector('[data-slot="design-stage"] iframe[data-artboard="Cart.html"]') === before).toBe(true);
  await act(async () => { viewer.unfocus(); });
  expect(host!.querySelector('[data-slot="design-stage"] iframe[data-artboard="Cart.html"]') === before).toBe(true);
});

// A panel keeps a canvas tab drawn while another tab shows: its focused design
// must leave Esc to the tab that shows.
test("a focused design in a tab not shown leaves Esc to what is shown", async () => {
  await render(snapshot(), false);
  await act(async () => { viewer.focus("Pay.html"); });
  let reachedWindow = false;
  const onWindow = () => { reachedWindow = true; };
  window.addEventListener("keydown", onWindow);
  try {
    await act(async () => { document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  } finally {
    window.removeEventListener("keydown", onWindow);
  }
  expect(viewer.focused?.path).toBe("Pay.html");
  expect(reachedWindow).toBe(true);
});

// ⌘⇧Enter does not bubble out of an iframe: the frame sends it, and the
// page hears it as the report viewer passes it on, so the panel's Hide chat
// shortcut works from a focused artboard.
test("the panel's shortcut from the focused frame reaches the page", async () => {
  await render();
  await act(async () => { viewer.focus("Pay.html"); });
  const frame = host!.querySelector<HTMLIFrameElement>('[data-slot="design-focus"] iframe')!;
  const heard: Array<[string, boolean, boolean]> = [];
  const onWindow = (event: KeyboardEvent) => { heard.push([event.key, event.metaKey || event.ctrlKey, event.shiftKey]); };
  window.addEventListener("keydown", onWindow);
  try {
    await act(async () => {
      window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.key", canvasId: "cnv_d", key: "Enter", metaKey: true, ctrlKey: false, shiftKey: true }, source: frame.contentWindow as Window }));
    });
  } finally {
    window.removeEventListener("keydown", onWindow);
  }
  expect(heard).toEqual([["Enter", true, true]]);
  // Still focused: the shortcut is the panel's, not the design's.
  expect(viewer.focused?.path).toBe("Pay.html");
});

// Beside the chat, Esc pressed in the chat (renaming the thread, the
// composer) is the chat's: the focused design no longer covers the page.
test("Esc pressed outside the canvas is not the focused design's", async () => {
  await render();
  await act(async () => { viewer.focus("Pay.html"); });
  const beside = host!.querySelector<HTMLInputElement>('[data-slot="beside"]')!;
  let reachedWindow = false;
  const onWindow = () => { reachedWindow = true; };
  window.addEventListener("keydown", onWindow);
  try {
    await act(async () => { beside.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  } finally {
    window.removeEventListener("keydown", onWindow);
  }
  expect(viewer.focused?.path).toBe("Pay.html");
  expect(reachedWindow).toBe(true);
});
