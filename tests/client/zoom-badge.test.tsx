import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ZoomBadge } from "@/shell/ZoomBadge";
import { useUIStore } from "@/store/ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  useUIStore.setState({ interfaceZoom: 1 });
});

function render(durationMs: number) {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<ZoomBadge durationMs={durationMs} />);
  });
  return host!;
}

const badge = (el: HTMLElement) => el.querySelector('[data-slot="zoom-badge"]');

test("desktop: nothing at boot, the badge after a step, gone after the duration", async () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const el = render(30);
  expect(badge(el) === null).toBe(true);
  act(() => useUIStore.getState().setInterfaceZoom(1.25));
  expect(badge(el)?.textContent).toContain("125%");
  expect(badge(el)?.textContent).toContain("⌘0 resets");
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  expect(badge(el) === null).toBe(true);
});

test("the badge follows the latest value while steps keep coming", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const el = render(10_000);
  act(() => useUIStore.getState().setInterfaceZoom(1.1));
  act(() => useUIStore.getState().setInterfaceZoom(1.25));
  expect(badge(el)?.textContent).toContain("125%");
  expect(badge(el)?.textContent).not.toContain("110%");
});

test("browser: no badge even when the store changes", () => {
  const el = render(10_000);
  act(() => useUIStore.getState().setInterfaceZoom(1.5));
  expect(badge(el) === null).toBe(true);
});
