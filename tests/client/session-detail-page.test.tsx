import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { SessionDetailPage } from "@/routes/sessions/SessionDetailPage";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

const SESSIONS = { sessions: [
  { name: "frp", ownership: "unmanaged", projectId: null, projectName: null, windows: [
    { name: "zsh", windowId: "@1", index: 1, active: true, panes: [{ paneId: "%1", index: 1, active: true, currentCommand: "zsh", currentPath: "/x" }] },
    { name: "main", windowId: "@2", index: 2, active: false, panes: [{ paneId: "%2", index: 1, active: true, currentCommand: "zsh", currentPath: "/x" }, { paneId: "%3", index: 2, active: false, currentCommand: "codex", currentPath: "/x" }] }
  ] },
  { name: "md-frp-2784c3e426", ownership: "managed", projectId: "p1", projectName: "frp", windows: [
    { name: "main", windowId: "@9", index: 2, active: true, panes: [{ paneId: "%28", index: 1, active: true, currentCommand: "zsh", currentPath: "/x" }] }
  ] }
] };

beforeEach(() => {
  (globalThis as { fetch: unknown }).fetch = async () => new Response(JSON.stringify(SESSIONS), { status: 200, headers: { "content-type": "application/json" } });
});
afterEach(() => {
  act(() => root?.unmount()); host?.remove(); root = null; host = null;
  globalThis.fetch = realFetch;
});

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={["/sessions/frp"]}>
        <PaneHeaderSlotsProvider>
          <PaneHeaderActionsSlot />
          <Routes>
            <Route path="/sessions/:sessionName" element={<SessionDetailPage />} />
          </Routes>
        </PaneHeaderSlotsProvider>
      </MemoryRouter>
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host!;
}

test("header line names the ownership and window count; refresh is not a body button", async () => {
  const el = await render();
  const header = el.querySelector('[data-slot="windows-header"]')!;
  expect(header === null).toBe(false);
  expect(header.textContent).toContain("Unmanaged");
  expect(header.textContent).toContain("2 windows");
  expect(el.textContent).not.toContain("Unmanaged tmux session");
  // Refresh lives in the header band, not as an orphan button above the list.
  expect(el.querySelector('[data-slot="pane-actions"] button[aria-label="Refresh"]') === null).toBe(false);
  expect(el.querySelectorAll('button[aria-label="Refresh"]').length).toBe(1);
});

test("window rows: index, mono name, live dot for the active window, pane count and commands, link to the window", async () => {
  const el = await render();
  const rows = Array.from(el.querySelectorAll('[data-slot="window-row"]'));
  expect(rows.length).toBe(2);
  expect(rows[0]!.getAttribute("data-active")).toBe("true");
  expect(rows[0]!.querySelector('[data-slot="window-live"]') === null).toBe(false);
  expect(rows[1]!.querySelector('[data-slot="window-live"]') === null).toBe(true);
  expect(rows[1]!.textContent).toContain("[2]");
  expect(rows[1]!.querySelector('[data-slot="window-name"]')!.className.split(/\s+/)).toContain("font-mono");
  expect(rows[1]!.textContent).toContain("2 panes · zsh, codex");
  expect(rows[1]!.querySelector("a")!.getAttribute("href")).toBe("/sessions/frp/windows/main");
  expect(el.querySelector(".text-primary") === null).toBe(true);
});
