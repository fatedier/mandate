import { beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { SessionDetailPage } from "@/routes/sessions/SessionDetailPage";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

const SESSIONS = { sessions: [
  { name: "project-1", ownership: "unmanaged", projectId: null, projectName: null, windows: [
    { name: "zsh", windowId: "@1", index: 1, active: true, panes: [{ paneId: "%1", index: 1, active: true, currentCommand: "zsh", currentPath: "/x" }] },
    { name: "main", windowId: "@2", index: 2, active: false, panes: [{ paneId: "%2", index: 1, active: true, currentCommand: "zsh", currentPath: "/x" }, { paneId: "%3", index: 2, active: false, currentCommand: "codex", currentPath: "/x" }] }
  ] },
  { name: "md-project-1-0a1b2c3d4e", ownership: "managed", projectId: "p1", projectName: "project-1", windows: [
    { name: "main", windowId: "@9", index: 2, active: true, panes: [{ paneId: "%28", index: 1, active: true, currentCommand: "zsh", currentPath: "/x" }] }
  ] }
] };

beforeEach(() => {
  mockFetch(() => jsonResponse(SESSIONS));
});

async function render(path = "/sessions/project-1") {
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={[path]}>
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <Routes>
          <Route path="/sessions/:sessionName" element={<SessionDetailPage />} />
        </Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  return host;
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
  expect(rows[1]!.querySelector("a")!.getAttribute("href")).toBe("/sessions/project-1/windows/main");
  expect(el.querySelector(".text-primary") === null).toBe(true);
});

test("a session that isn't there says so and leads back to all sessions", async () => {
  const host = await render("/sessions/nope");
  const state = host.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Session not found");
  expect(state.textContent).toContain("No tmux session is named nope.");
  const back = state.querySelector<HTMLAnchorElement>('a[href="/sessions"]')!;
  expect(back.textContent).toBe("Back to all sessions");
});

test("a first load that fails says so and can retry", async () => {
  let reads = 0;
  mockFetch(() => {
    reads++;
    return reads === 1 ? jsonResponse({ error: "tmux server not running" }, 500) : jsonResponse(SESSIONS);
  });
  const host = await render();
  const state = host.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Couldn't load this session");
  await act(async () => { [...state.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click(); });
  await settle();
  expect(host.querySelector('[data-slot="state-message"]') === null).toBe(true);
  expect(host.querySelectorAll('[data-slot="window-row"]').length).toBe(2);
});

