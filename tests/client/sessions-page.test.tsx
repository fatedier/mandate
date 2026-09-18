import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { SessionsPage } from "@/routes/sessions/SessionsPage";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { useProjectsStore } from "@/store/projects";

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
  globalThis.fetch = (async () => new Response(JSON.stringify(SESSIONS), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  useProjectsStore.setState({ byId: { p1: { id: "p1", name: "frp", tmuxAlive: true, tmuxStatus: "alive" } as never } });
});
afterEach(() => {
  act(() => root?.unmount()); host?.remove(); root = null; host = null;
  globalThis.fetch = realFetch;
  useProjectsStore.setState({ byId: {} });
});

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter>
        <PaneHeaderSlotsProvider>
          <PaneHeaderActionsSlot />
          <SessionsPage />
        </PaneHeaderSlotsProvider>
      </MemoryRouter>
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host!;
}

test("one header line carries the count and the unmanaged count; the old subtitle is gone", async () => {
  const el = await render();
  const header = el.querySelector('[data-slot="sessions-header"]')!;
  expect(header === null).toBe(false);
  expect(header.className.split(/\s+/)).toContain("h-8");
  expect(header.textContent).toContain("2");
  expect(header.textContent).toContain("1 unmanaged");
  expect(el.textContent).not.toContain("All tmux sessions on this machine");
  // Refresh lives in the header band, not as an orphan button above the list.
  expect(el.querySelector('[data-slot="pane-actions"] button[aria-label="Refresh"]') === null).toBe(false);
  expect(el.querySelectorAll('button[aria-label="Refresh"]').length).toBe(1);
});

test("an unmanaged row: amber pill, Adopt button, counts on line two; no 'managed by' link", async () => {
  const el = await render();
  const row = el.querySelector('[data-slot="session-row"][data-ownership="unmanaged"]')!;
  expect(row === null).toBe(false);
  const pill = row.querySelector(".pill");
  expect(pill === null).toBe(false);
  expect(pill!.className.split(/\s+/)).toContain("pill-amber");
  expect(pill!.textContent?.trim()).toBe("unmanaged");
  const adopt = Array.from(row.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Adopt")!;
  expect(adopt === undefined).toBe(false);
  expect(adopt.className.split(/\s+/)).toContain("h-7");
  expect(row.textContent).toContain("2 windows · 3 panes");
  expect(row.querySelector("a .text-primary") === null).toBe(true);
});

test("a managed row: project name starts line two, no pill, no Adopt, live dot when the project is alive", async () => {
  const el = await render();
  const row = el.querySelector('[data-slot="session-row"][data-ownership="managed"]')!;
  expect(row.querySelector(".pill") === null).toBe(true);
  expect(Array.from(row.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Adopt")).toBe(false);
  const lineTwo = row.querySelector('[data-slot="session-meta"]')!;
  expect(lineTwo.textContent?.trim().startsWith("frp ·")).toBe(true);
  expect(row.querySelector('[data-slot="session-live"]') === null).toBe(false);
  // The old "managed by <link>" affordance is gone from the managed row too.
  expect(row.querySelector(".text-primary") === null).toBe(true);
  expect(row.textContent).not.toContain("managed by");
});

test("a managed row whose project is gone has no live dot", async () => {
  useProjectsStore.setState({ byId: { p1: { id: "p1", name: "frp", tmuxAlive: true, tmuxStatus: "gone" } as never } });
  const el = await render();
  const row = el.querySelector('[data-slot="session-row"][data-ownership="managed"]')!;
  expect(row === null).toBe(false);
  expect(row.querySelector('[data-slot="session-live"]') === null).toBe(true);
});

test("the live dot follows tmuxStatus when it disagrees with tmuxAlive, as Home does", async () => {
  useProjectsStore.setState({ byId: { p1: { id: "p1", name: "frp", tmuxAlive: false, tmuxStatus: "alive" } as never } });
  const el = await render();
  const row = el.querySelector('[data-slot="session-row"][data-ownership="managed"]')!;
  expect(row.querySelector('[data-slot="session-live"]') === null).toBe(false);
});

test("session names are mono and the whole row is one link to the session", async () => {
  const el = await render();
  const row = el.querySelector('[data-slot="session-row"][data-ownership="managed"]')!;
  const name = row.querySelector('[data-slot="session-name"]')!;
  expect(name.className.split(/\s+/)).toContain("font-mono");
  const link = row.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("/sessions/md-frp-2784c3e426");
});
