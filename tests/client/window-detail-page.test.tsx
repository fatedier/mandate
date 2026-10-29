import { beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { WindowDetailPage } from "@/routes/sessions/WindowDetailPage";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

const DETAIL = {
  sessionName: "s", name: "main", windowId: "@9", index: 2, active: true,
  windowLayout: "abcd,80x24,0,0{40x24,0,0,1,40x24,40,0,2}",
  panes: [
    { paneId: "%1", index: 1, active: true, currentCommand: "zsh", currentPath: "/home/user/a", preview: "", metadata: { name: "N", description: "", updatedAt: "" } },
    { paneId: "%2", index: 2, active: false, currentCommand: "codex", currentPath: "/home/user/b", preview: "" }
  ]
};

function hasBoard(el: HTMLElement): boolean {
  return el.querySelector('[data-slot="pane-board"]') !== null;
}

beforeEach(() => {
  mockFetch(() => jsonResponse({ window: DETAIL }));
});

async function render() {
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/sessions/s/windows/main"]}>
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <Routes>
          <Route path="/sessions/:sessionName/windows/:windowName" element={<WindowDetailPage />} />
        </Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  return host;
}

test("phone: pane rows replace the layout board; header line has the count and the hint", async () => {
  onCleanup(fakePhoneWidth(390));
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
  mockFetch(() => jsonResponse({ window: { ...DETAIL, windowLayout: "" } }));
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

test("404: the window says it isn't there, frameless, with a foreground way back to its session", async () => {
  mockFetch(() => jsonResponse({ error: "not found" }, 404));
  const el = await render();
  const state = el.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Window not found");
  expect(state.textContent).toContain("Session s has no window named main.");
  const back = state.querySelector('a[href="/sessions/s"]')!;
  expect(back.textContent).toBe("Back to session");
  expect(back.className.split(/\s+/)).toContain("text-foreground");
  // A frame means "this wants you"; a missing window is not a card.
  expect(back.closest(".bg-panel") === null).toBe(true);
  expect(el.querySelector(".text-primary") === null).toBe(true);
  expect(el.querySelector('[data-slot="window-header"]') === null).toBe(true);
});

test("a window that fails to load says why and can retry", async () => {
  let reads = 0;
  mockFetch(() => {
    reads++;
    return reads === 1 ? jsonResponse({ error: "tmux server not running" }, 500) : jsonResponse({ window: DETAIL });
  });
  const el = await render();
  const state = el.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Couldn't load this window");
  expect(state.textContent).toContain("tmux server not running");
  await act(async () => { [...state.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click(); });
  await settle();
  expect(el.querySelector('[data-slot="state-message"]') === null).toBe(true);
  expect(el.querySelector('[data-slot="window-header"]') === null).toBe(false);
});
