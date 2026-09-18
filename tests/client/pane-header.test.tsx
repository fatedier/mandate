import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ReactNode } from "react";
import { PaneHeader } from "@/shell/PaneHeader";
import { PaneHeaderActions, PaneHeaderSlotsProvider, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { TopBar } from "@/shell/TopBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(pathname: string, page: ReactNode = null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={[pathname]}>
        <PaneHeaderSlotsProvider>
          <PaneHeader />
          <Routes>
            <Route path="*" element={page} />
          </Routes>
        </PaneHeaderSlotsProvider>
      </MemoryRouter>
    );
  });
  return host!;
}

test("a route without a title renders the breadcrumb's current segment", () => {
  const el = render("/activity");
  const title = el.querySelector('[data-slot="pane-default-title"]');
  expect(title?.textContent).toBe("Activity");
  expect(el.querySelector('[data-slot="pane-header"]')?.hasAttribute("data-tauri-drag-region")).toBe(true);
});

test("a route that claims the title replaces the default", () => {
  const el = render(
    "/activity",
    <PaneHeaderTitle>
      <span data-testid="custom">Custom title</span>
    </PaneHeaderTitle>
  );
  expect(el.querySelector('[data-slot="pane-default-title"]') === null).toBe(true);
  expect(el.querySelector('[data-slot="pane-title"] [data-testid="custom"]')?.textContent).toBe("Custom title");
});

test("route actions land in the header's actions slot", () => {
  const el = render(
    "/activity",
    <PaneHeaderActions>
      <button type="button" aria-label="Do thing" />
    </PaneHeaderActions>
  );
  expect(el.querySelector('[data-slot="pane-actions"] [aria-label="Do thing"]') === null).toBe(false);
});

test("the header shows the worker zoom button only on a feature route", () => {
  const plain = render("/activity");
  expect(plain.querySelector('[data-pane-zoom="worker"]') === null).toBe(true);
});

test("TopBar renders nothing on desktop", () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={["/activity"]}>
        <PaneHeaderSlotsProvider>
          <TopBar />
        </PaneHeaderSlotsProvider>
      </MemoryRouter>
    );
  });
  expect(host!.childElementCount).toBe(0);
});
