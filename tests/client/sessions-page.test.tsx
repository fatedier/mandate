import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { SessionsPage } from "@/routes/sessions/SessionsPage";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { useProjectsStore, type Project } from "@/store/projects";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { stub } from "../helpers/typed.js";

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
  useProjectsStore.setState({ byId: { p1: stub<Project>({ id: "p1", name: "project-1", tmuxAlive: true, tmuxStatus: "alive" }) } });
});
afterEach(() => {
  // Unmount before the projects the page reads are reset under it.
  runCleanups();
  useProjectsStore.setState({ byId: {} });
});

async function render() {
  const { host } = await mountAsync(
    <MemoryRouter>
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <SessionsPage />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  return host;
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
  expect(lineTwo.textContent?.trim().startsWith("project-1 ·")).toBe(true);
  expect(row.querySelector('[data-slot="session-live"]') === null).toBe(false);
  // The old "managed by <link>" affordance is gone from the managed row too.
  expect(row.querySelector(".text-primary") === null).toBe(true);
  expect(row.textContent).not.toContain("managed by");
});

test("a managed row whose project is gone has no live dot", async () => {
  useProjectsStore.setState({ byId: { p1: stub<Project>({ id: "p1", name: "project-1", tmuxAlive: true, tmuxStatus: "gone" }) } });
  const el = await render();
  const row = el.querySelector('[data-slot="session-row"][data-ownership="managed"]')!;
  expect(row === null).toBe(false);
  expect(row.querySelector('[data-slot="session-live"]') === null).toBe(true);
});

test("the live dot follows tmuxStatus when it disagrees with tmuxAlive, as Home does", async () => {
  useProjectsStore.setState({ byId: { p1: stub<Project>({ id: "p1", name: "project-1", tmuxAlive: false, tmuxStatus: "alive" }) } });
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
  expect(link.getAttribute("href")).toBe("/sessions/md-project-1-0a1b2c3d4e");
});

test("a first load that fails says so and can retry, instead of a skeleton for ever", async () => {
  let failing = true;
  mockFetch(() => failing ? jsonResponse({ error: "tmux server not running" }, 500) : jsonResponse(SESSIONS));
  const host = await render();
  const state = host.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Couldn't load tmux sessions");
  failing = false;
  const retry = [...state.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
  await act(async () => { retry.click(); });
  await settle();
  expect(host.querySelector('[data-slot="state-message"]') === null).toBe(true);
  expect(host.textContent).toContain("md-project-1-0a1b2c3d4e");
});

