import { afterEach, expect, test } from "bun:test";
import { installDesktopZoomIfDesktop } from "@/shell/desktop-zoom-wiring";
import { useUIStore } from "@/store/ui";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  useUIStore.setState({ interfaceZoom: 1 });
});

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

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
  press("+");
  expect(useUIStore.getState().interfaceZoom).toBe(1);
});
