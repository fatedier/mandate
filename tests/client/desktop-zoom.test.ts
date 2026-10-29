import { afterEach, describe, expect, test } from "bun:test";
import {
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  createZoomController,
  formatZoom,
  nextZoom,
  snapZoom,
  zoomShortcut
} from "@/lib/desktop-zoom";
import { installDesktopZoomIfDesktop } from "@/shell/desktop-zoom-wiring";
import { useUIStore } from "@/store/ui";

test("the ladder is the browser's, ascending, with 100% on it", () => {
  expect(ZOOM_STEPS).toEqual([0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
  expect(ZOOM_STEPS).toContain(ZOOM_DEFAULT);
  expect(ZOOM_MIN).toBe(0.8);
  expect(ZOOM_MAX).toBe(2);
});

test("nextZoom steps along the ladder and clamps at both ends", () => {
  expect(nextZoom(1, "in")).toBe(1.1);
  expect(nextZoom(1.1, "in")).toBe(1.25);
  expect(nextZoom(1, "out")).toBe(0.9);
  expect(nextZoom(ZOOM_MAX, "in")).toBe(ZOOM_MAX);
  expect(nextZoom(ZOOM_MIN, "out")).toBe(ZOOM_MIN);
  expect(nextZoom(1.75, "reset")).toBe(1);
});

test("a value between steps snaps to the nearest step before stepping", () => {
  expect(snapZoom(1.2)).toBe(1.25);
  expect(snapZoom(1.04)).toBe(1);
  expect(snapZoom(NaN)).toBe(ZOOM_DEFAULT);
  expect(snapZoom(9)).toBe(ZOOM_MAX);
  expect(nextZoom(1.2, "in")).toBe(1.5);
});

test("formatZoom is a whole percentage", () => {
  expect(formatZoom(1)).toBe("100%");
  expect(formatZoom(1.25)).toBe("125%");
  expect(formatZoom(0.9)).toBe("90%");
});

test("zoomShortcut: ⌘ with + = − _ 0, no Alt; nothing else", () => {
  const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
    zoomShortcut({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  expect(k("+", { metaKey: true })).toBe("in");
  expect(k("=", { metaKey: true })).toBe("in");
  expect(k("-", { metaKey: true })).toBe("out");
  expect(k("_", { metaKey: true })).toBe("out");
  expect(k("0", { metaKey: true })).toBe("reset");
  expect(k("=", { ctrlKey: true })).toBe("in");
  expect(k("=")).toBe(null);
  expect(k("=", { metaKey: true, altKey: true })).toBe(null);
  expect(k("1", { metaKey: true })).toBe(null);
  expect(k("k", { metaKey: true })).toBe(null);
});

test("the controller drops a same-direction request from another source within the window, keeps same-source repeats", () => {
  let now = 1000;
  let value = 1;
  const c = createZoomController({ get: () => value, set: (f) => { value = f; }, now: () => now, dedupeMs: 150 });
  c.step("in", "menu");
  expect(value).toBe(1.1);
  now += 20;
  c.step("in", "keyboard"); // the same keypress reported twice
  expect(value).toBe(1.1);
  now += 20;
  c.step("in", "keyboard"); // held key: same source, goes through
  expect(value).toBe(1.25);
  now += 20;
  c.step("out", "menu"); // different direction: not a duplicate
  expect(value).toBe(1.1);
  now += 200;
  c.step("in", "keyboard"); // outside the window
  expect(value).toBe(1.25);
});

// The shortcut's wiring into the document: the desktop app steps the store, a
// browser keeps its own zoom.
describe("wiring", () => {
  type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

  afterEach(() => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    useUIStore.setState({ interfaceZoom: 1 });
  });

  test("desktop: ⌘+ steps the store and is consumed; a key the menu owns is only a fallback and still steps when it arrives", () => {
    (window as TauriWindow).__TAURI_INTERNALS__ = {};
    // A throwaway document so the listener does not outlive the test.
    const doc = document.implementation.createHTMLDocument("zoom");
    installDesktopZoomIfDesktop(doc);
    const fire = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true, ...init });
      doc.dispatchEvent(event);
      return event;
    };
    expect(fire("+").defaultPrevented).toBe(true);
    expect(useUIStore.getState().interfaceZoom).toBe(1.1);
    fire("+");
    expect(useUIStore.getState().interfaceZoom).toBe(1.25);
    fire("-");
    expect(useUIStore.getState().interfaceZoom).toBe(1.1);
    fire("0");
    expect(useUIStore.getState().interfaceZoom).toBe(1);
    // Not a zoom key: untouched, not consumed.
    expect(fire("k").defaultPrevented).toBe(false);
    expect(useUIStore.getState().interfaceZoom).toBe(1);
  });

  test("browser: the shortcut is left to the browser", () => {
    const doc = document.implementation.createHTMLDocument("zoom");
    installDesktopZoomIfDesktop(doc);
    const event = new KeyboardEvent("keydown", { key: "+", metaKey: true, bubbles: true, cancelable: true });
    doc.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(useUIStore.getState().interfaceZoom).toBe(1);
  });
});
