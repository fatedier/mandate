import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { WindowDetailPage } from "@/routes/sessions/WindowDetailPage";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { fakePhoneWidth } from "../fake-phone-width";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreWidth: (() => void) | null = null;

const DETAIL = {
  sessionName: "s", name: "main", windowId: "@9", index: 2, active: true,
  windowLayout: "abcd,80x24,0,0{40x24,0,0,1,40x24,40,0,2}",
  panes: [
    { paneId: "%1", index: 1, active: true, currentCommand: "zsh", currentPath: "/home/fate/a", preview: "", metadata: { name: "N", description: "", updatedAt: "" } },
    { paneId: "%2", index: 2, active: false, currentCommand: "codex", currentPath: "/home/fate/b", preview: "" }
  ]
};

function hasBoard(el: HTMLElement): boolean {
  return el.querySelector('[data-slot="pane-board"]') !== null;
}

beforeEach(() => {
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify({ window: DETAIL }), { status: 200, headers: { "content-type": "application/json" } });
});
afterEach(() => {
  act(() => root?.unmount()); host?.remove(); root = null; host = null;
  globalThis.fetch = realFetch;
  restoreWidth?.(); restoreWidth = null;
});

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={["/sessions/s/windows/main"]}>
        <PaneHeaderSlotsProvider>
          <PaneHeaderActionsSlot />
          <Routes>
            <Route path="/sessions/:sessionName/windows/:windowName" element={<WindowDetailPage />} />
          </Routes>
        </PaneHeaderSlotsProvider>
      </MemoryRouter>
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host!;
}

test("phone: pane rows replace the layout board; header line has the count and the hint", async () => {
  restoreWidth = fakePhoneWidth(390);
  const el = await render();
  expect(el.querySelector('[data-slot="pane-rows"]') === null).toBe(false);
  expect(el.querySelectorAll('[data-slot="pane-row"]').length).toBe(2);
  expect(el.querySelector('[data-slot="window-header"]')!.textContent).toContain("2 panes");
  expect(el.querySelector('[data-slot="window-header"]')!.textContent).toContain("tap a pane to open its terminal");
  expect(el.querySelector('[data-slot="pane-row"] a')!.getAttribute("href")).toBe("/sessions/s/windows/main/pane/%251");
  expect(hasBoard(el)).toBe(false);
  // Only the page's own markup and the rows are in the tree here (no board),
  // so a blanket check is meaningful.
  expect(el.querySelector(".bg-card") === null).toBe(true);
  expect(el.querySelector(".text-primary") === null).toBe(true);
});

/** The page's column: the header line's parent (the slot div and the page
 *  root are siblings under the host, so `firstElementChild` is the wrong one). */
function pageRoot(el: HTMLElement): Element {
  return el.querySelector('[data-slot="window-header"]')!.parentElement!;
}

test("desktop with a layout keeps the board, the wide column, and hides the phone hint", async () => {
  const el = await render();
  expect(el.querySelector('[data-slot="pane-rows"]') === null).toBe(true);
  expect(hasBoard(el)).toBe(true);
  // The board's panes are in the tree here, so this pins LayoutPane too.
  expect(el.querySelector(".bg-card") === null).toBe(true);
  expect(pageRoot(el).className.split(/\s+/)).toContain("max-w-[1280px]");
  expect(el.querySelector('[data-slot="window-header"]')!.textContent).toContain("2 panes");
  expect(el.querySelector('[data-slot="window-header"]')!.textContent).not.toContain("tap a pane");
});

test("desktop without a layout falls back to pane rows in the narrow column", async () => {
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify({ window: { ...DETAIL, windowLayout: "" } }), { status: 200, headers: { "content-type": "application/json" } });
  const el = await render();
  expect(el.querySelector('[data-slot="pane-rows"]') === null).toBe(false);
  expect(el.querySelectorAll('[data-slot="pane-row"]').length).toBe(2);
  expect(hasBoard(el)).toBe(false);
  expect(pageRoot(el).className.split(/\s+/)).toContain("max-w-[1040px]");
  expect(el.querySelector('[data-slot="window-header"]')!.textContent).not.toContain("tap a pane");
});

test("refresh lives in the header actions slot, once", async () => {
  const el = await render();
  const refreshes = el.querySelectorAll('button[aria-label="Refresh"]');
  expect(refreshes.length).toBe(1);
  expect(refreshes[0]!.closest('[data-slot="pane-actions"]') === null).toBe(false);
});

test("404: the not-found card is a panel and the back link is foreground, not primary", async () => {
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  const el = await render();
  expect(el.textContent).toContain("not found in session");
  const back = el.querySelector('a[href="/sessions/s"]')!;
  expect(back === null).toBe(false);
  expect(back.className.split(/\s+/)).toContain("text-foreground");
  expect(back.closest(".bg-panel") === null).toBe(false);
  expect(el.querySelector(".bg-card") === null).toBe(true);
  expect(el.querySelector(".text-primary") === null).toBe(true);
  expect(el.querySelector('[data-slot="window-header"]') === null).toBe(true);
});
