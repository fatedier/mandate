import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider, PaneHeaderTitleSlot } from "@/shell/pane-header-slots";
import { TerminalsPage } from "@/routes/terminals/TerminalsPage";
import { navItems } from "@/shell/nav-config";
import { useTerminalsStore } from "@/store/terminals";
import { useUIStore } from "@/store/ui";
import { TERMINAL_TABS_STORAGE_KEY, useTerminalTabsStore } from "@/store/terminal-tabs";
import { resetKeptTerminals, TERMINALS_PAGE_PATHS } from "@/routes/terminals/kept-terminals";
import { KeptAlivePage } from "@/shell/KeptAlivePage";
import type { SessionDto, SessionPaneDto, TerminalPinDto } from "@shared/api-contracts";
import { mount, typeInto } from "../helpers/mount.js";
import { onCleanup } from "../helpers/cleanup.js";

afterEach(() => {
  useTerminalsStore.setState({ sessions: null, pins: [], status: "idle", error: null, latest: 0, applied: 0, listApplied: 0 });
  useTerminalTabsStore.setState({ open: [] });
  localStorage.removeItem(TERMINAL_TABS_STORAGE_KEY);
  resetKeptTerminals();
});

const pane = (paneId: string, pid: number, over: Partial<SessionPaneDto> = {}): SessionPaneDto => ({
  paneId, index: 0, active: true, currentCommand: "codex", currentPath: "/home/dev/work", title: `Topic ${paneId}`, pid, ...over
});
const SESSIONS: SessionDto[] = [
  { name: "work", ownership: "unmanaged", projectId: null, projectName: null, windows: [
    { name: "main", windowId: "@1", index: 0, active: true, panes: [pane("%1", 101), pane("%2", 102)] },
    { name: "notes", windowId: "@2", index: 1, active: false, panes: [pane("%3", 103, { currentCommand: "zsh", title: "dev@box:~/work" }), pane("%4", 104, { currentCommand: "zsh", currentPath: "/home/dev" })] }
  ] }
];
const pin = (paneId: string, pid: number): TerminalPinDto => ({ paneId, pid, pinnedAt: `2026-11-13T00:00:0${pid % 10}.000Z` });

/** The server, as the page reads it: the list, pins, a new shell, pane lookups. */
function server(state: { sessions: SessionDto[]; pins: TerminalPinDto[]; lookupsHang?: boolean }) {
  const original = globalThis.fetch;
  const posts: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.endsWith("/api/terminals") && method === "GET") return json(state);
    if (u.endsWith("/api/terminals") && method === "POST") { posts.push("shell"); return json({ paneId: "%4", pid: 104 }); }
    if (u.endsWith("/api/terminals/pins") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { paneId: string; pid: number };
      posts.push(`pin ${body.paneId}`);
      state.pins = [...state.pins, pin(body.paneId, body.pid)];
      return json({ pins: state.pins });
    }
    if (u.endsWith("/api/terminals/pins/order") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { pins: Array<{ paneId: string; pid: number }> };
      posts.push(`order ${body.pins.map((p) => p.paneId).join(" ")}`);
      state.pins = body.pins.flatMap((o) => state.pins.filter((p) => p.paneId === o.paneId && p.pid === o.pid));
      return json({ pins: state.pins });
    }
    if (u.includes("/api/terminals/pins/") && method === "DELETE") {
      const id = decodeURIComponent(u.split("/api/terminals/pins/")[1]!);
      posts.push(`unpin ${id}`);
      state.pins = state.pins.filter((p) => p.paneId !== id);
      return json({ pins: state.pins });
    }
    const lookup = u.match(/\/api\/panes\/([^/?]+)/);
    if (lookup && state.lookupsHang) return new Promise<Response>(() => {});
    if (lookup) {
      const id = decodeURIComponent(lookup[1]!);
      const hit = state.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => ({ p, s, w })))).find(({ p }) => p.paneId === id);
      if (!hit) return json({ error: "pane not found" }, 404);
      return json({ paneId: id, sessionName: hit.s.name, windowName: hit.w.name, windowId: hit.w.windowId, windowIndex: hit.w.index, paneIndex: hit.p.index, active: true, currentCommand: hit.p.currentCommand, currentPath: hit.p.currentPath, pid: hit.p.pid, paneWidth: 80, paneHeight: 24, projectId: null });
    }
    return json({ error: "not stubbed" }, 404);
  }) as typeof fetch;
  const ws = globalThis.WebSocket;
  const sockets: string[] = [];
  globalThis.WebSocket = class { static OPEN = 1; readyState = 0; binaryType = ""; onopen = null; onclose = null; onerror = null; onmessage = null; constructor(url: string) { sockets.push(new URL(url, "http://x").searchParams.get("paneId") ?? url); } send() {} close() {} } as unknown as typeof WebSocket;
  onCleanup(() => { globalThis.fetch = original; globalThis.WebSocket = ws; });
  return { state, posts, sockets };
}

let where = "";
/** Follows an address from inside the page, as a link would. */
let goTo: (to: string) => void = () => {};
function GoTo() {
  const navigate = useNavigate();
  goTo = (to) => navigate(to);
  return null;
}
function Where() {
  const location = useLocation();
  where = `${location.pathname}${location.search}`;
  return null;
}

async function open(path: string, state: { sessions: SessionDto[]; pins: TerminalPinDto[]; lookupsHang?: boolean }) {
  return openWith(path, state);
}
async function openWith(path: string, state: { sessions: SessionDto[]; pins: TerminalPinDto[]; lookupsHang?: boolean }) {
  const s = server(state);
  const view = mount(
    <MemoryRouter initialEntries={[path]}>
      <PaneHeaderSlotsProvider>
        <PaneHeaderTitleSlot />
        <PaneHeaderActionsSlot />
        <Routes>
          <Route path="/terminals" element={<><TerminalsPage /><Where /></>} />
          <Route path="/terminals/pane/:paneId" element={<><TerminalsPage /><Where /></>} />
        </Routes>
        <GoTo />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  return { ...s, host: view.host, unmount: () => act(() => { view.unmount(); }) };
}
/** Lets fetches answer and the tree catch up: until the list has arrived and nothing changes for a few turns. */
const settle = async () => {
  let quiet = 0;
  let last = "";
  for (let i = 0; i < 200 && quiet < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
    const now = `${useTerminalsStore.getState().status}|${document.body.innerHTML.length}`;
    quiet = now === last && useTerminalsStore.getState().status !== "loading" ? quiet + 1 : 0;
    last = now;
  }
};
const tabs = (host: HTMLElement) => [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.replace(/Close .*/, "").trim());
const tab = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes(label))!;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };

test("the tab row is All, then the pins in the order made", async () => {
  const { host } = await open("/terminals", { sessions: SESSIONS, pins: [pin("%2", 102), pin("%1", 101)] });
  expect(tabs(host)).toEqual(["All", "Topic %2", "Topic %1"]);
});

test("a tab's tooltip is its full name and where it is: session › window", async () => {
  const { host } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [pin("%1", 101)] });
  const titleOf = (label: string) => tab(host, label).querySelector("[title]")!.getAttribute("title");
  expect(titleOf("Topic %1")).toBe("Topic %1\nwork › main");
  expect(titleOf("zsh · ~/work")).toBe("zsh · ~/work\nwork › notes");
});

test("a full-width title is the tab's name and, whole, its tooltip", async () => {
  const LONG = "整理花园的种植计划并更新到日历，然后检查每块菜地的浇水时间是否合适";
  const sessions: SessionDto[] = [{ ...SESSIONS[0]!, windows: [{ ...SESSIONS[0]!.windows[0]!, panes: [pane("%1", 101, { title: LONG })] }] }];
  const { host } = await open("/terminals", { sessions, pins: [pin("%1", 101)] });
  const label = tab(host, LONG.slice(0, 6)).querySelector("[title]")!;
  expect(label.textContent).toBe(LONG);
  expect(label.getAttribute("title")).toBe(`${LONG}\nwork › main`);
  expect(label.classList.contains("truncate")).toBe(true);
});

const closable = (host: HTMLElement, label: string) => tab(host, label).querySelector('[aria-label^="Close"]') !== null;

test("each pane opened gets a tab of its own after the pins, kept while another tab shows; × shows the tab to its right, else the one to its left", async () => {
  const { host } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [pin("%1", 101)] });
  expect(tabs(host)).toEqual(["All", "Topic %1", "zsh · ~/work"]);
  await click(tab(host, "All"));
  await click([...host.querySelectorAll('[data-open-pane="%4"]')][0]!);
  expect(tabs(host)).toEqual(["All", "Topic %1", "zsh · ~/work", "zsh · ~"]);
  // A pinned tab chosen: the panes opened stay.
  await click(tab(host, "Topic %1"));
  expect(tabs(host)).toEqual(["All", "Topic %1", "zsh · ~/work", "zsh · ~"]);
  expect([closable(host, "Topic %1"), closable(host, "zsh · ~/work"), closable(host, "zsh · ~")]).toEqual([false, true, true]);
  await click(tab(host, "zsh · ~/work"));
  await click(host.querySelector('[aria-label="Close zsh · ~/work"]')!);
  expect(where).toBe("/terminals/pane/%254?pid=104");
  await click(host.querySelector('[aria-label="Close zsh · ~"]')!);
  expect(where).toBe("/terminals/pane/%251?pid=101");
  expect(tabs(host)).toEqual(["All", "Topic %1"]);
});

test("closing a tab that is not shown leaves the one shown", async () => {
  const { host } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [] });
  await click(tab(host, "All"));
  await click(host.querySelector('[aria-label="Close zsh · ~/work"]')!);
  expect(where).toBe("/terminals");
  expect(tabs(host)).toEqual(["All"]);
});

test("the tabs opened are kept in this browser: a reload shows them again", async () => {
  const first = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [] });
  first.unmount();
  // A reload: memory starts empty, then reads what this browser kept.
  const kept = localStorage.getItem(TERMINAL_TABS_STORAGE_KEY);
  useTerminalTabsStore.setState({ open: [] });
  localStorage.setItem(TERMINAL_TABS_STORAGE_KEY, kept ?? "");
  await useTerminalTabsStore.persist.rehydrate();
  const again = await open("/terminals", { sessions: SESSIONS, pins: [] });
  expect(tabs(again.host)).toEqual(["All", "zsh · ~/work"]);
});

/** The open terminal's ⋯, opened: its items. */
async function terminalMenu(host: HTMLElement): Promise<HTMLElement[]> {
  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Terminal actions"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
}
const pinItem = async (host: HTMLElement) => (await terminalMenu(host)).find((i) => /^(Pin|Unpin)$/.test(i.textContent?.trim() ?? ""))!;

test("the tab row is the pane's header, with no header over the terminal: New terminal follows the tabs, the terminal's ⋯ ends the header and says where it is", async () => {
  const { host } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [pin("%1", 101)] });
  const title = host.querySelector('[data-slot="pane-title"]')!;
  expect(title.querySelector('[role="tablist"]') === null).toBe(false);
  // After the last tab, as a browser's, and away from ⋯ at the far right.
  const newTerminal = title.querySelector('[aria-label="New terminal"]')!;
  const lastTab = [...title.querySelectorAll('[role="tab"]')].at(-1)!;
  expect(Boolean(lastTab.compareDocumentPosition(newTerminal) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  // The actions, not the title: a header saying Reconnecting… takes its room
  // from the title, which would slide ⋯ under the word.
  const actions = [...host.querySelectorAll<HTMLElement>('[data-slot="pane-actions"] button')].map((b) => b.getAttribute("aria-label"));
  expect(actions).toEqual(["Terminal actions"]);
  expect(host.querySelector("header") === null).toBe(true);
  await terminalMenu(host);
  expect(document.querySelector('[role="menu"] [data-slot="dropdown-menu-label"]')?.textContent).toBe("zsh · work › notes · ~/work");
});

test("an address without a pid for a pane already open shows that tab while the pane is looked up, not a second one", async () => {
  const first = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [] });
  first.unmount();
  const again = await open("/terminals/pane/%253", { sessions: SESSIONS, pins: [], lookupsHang: true });
  expect(tabs(again.host)).toEqual(["All", "zsh · ~/work"]);
  expect(tab(again.host, "zsh · ~/work").getAttribute("aria-selected")).toBe("true");
});

test("a pane opened and gone before the list is read again keeps the name its tab had", async () => {
  const state = { sessions: structuredClone(SESSIONS), pins: [] as TerminalPinDto[] };
  const { host } = await open("/terminals", state);
  await click([...host.querySelectorAll('[data-open-pane="%3"]')][0]!);
  await click(tab(host, "All"));
  state.sessions[0]!.windows[1]!.panes = state.sessions[0]!.windows[1]!.panes.filter((p) => p.paneId !== "%3");
  await act(async () => { await useTerminalsStore.getState().refresh(); });
  await settle();
  expect(tabs(host)).toEqual(["All", "zsh · ~/work"]);
});

test("a pane open here, then pinned and unpinned anywhere (the panel's ⋯, another device), is an open tab again", async () => {
  const { host } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [] });
  await click(tab(host, "All"));
  await act(async () => { await useTerminalsStore.getState().pin("%3", 103); });
  await settle();
  expect(closable(host, "zsh · ~/work")).toBe(false);
  await act(async () => { await useTerminalsStore.getState().unpin("%3"); });
  await settle();
  expect(tabs(host)).toEqual(["All", "zsh · ~/work"]);
  expect(closable(host, "zsh · ~/work")).toBe(true);
});

test("another window's tabs reach this one, and a list read that renames nothing writes nothing over them", async () => {
  await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [] });
  const theirs = JSON.stringify({ state: { open: [{ paneId: "%3", pid: 103, name: "zsh · ~/work" }, { paneId: "%4", pid: 104, name: "zsh · ~" }] }, version: 0 });
  localStorage.setItem(TERMINAL_TABS_STORAGE_KEY, theirs);
  await act(async () => { window.dispatchEvent(new window.StorageEvent("storage", { key: TERMINAL_TABS_STORAGE_KEY, newValue: theirs })); await new Promise((r) => setTimeout(r, 0)); });
  expect(useTerminalTabsStore.getState().open.map((t) => t.paneId)).toEqual(["%3", "%4"]);
  useTerminalTabsStore.getState().rename([{ paneId: "%3", pid: 103, name: "zsh · ~/work" }]);
  expect(localStorage.getItem(TERMINAL_TABS_STORAGE_KEY)).toBe(theirs);
});

test("a pane whose tab was closed opens as a tab again when it is opened again", async () => {
  const { host } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [] });
  await click(tab(host, "All"));
  await click(host.querySelector('[aria-label="Close zsh · ~/work"]')!);
  await click([...host.querySelectorAll('[data-open-pane="%3"]')][0]!);
  expect(useTerminalTabsStore.getState().open.map((t) => t.paneId)).toEqual(["%3"]);
});

test("a tab another window closed is not opened again here by the next list read", async () => {
  await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [] });
  const theirs = JSON.stringify({ state: { open: [] }, version: 0 });
  localStorage.setItem(TERMINAL_TABS_STORAGE_KEY, theirs);
  await act(async () => { window.dispatchEvent(new window.StorageEvent("storage", { key: TERMINAL_TABS_STORAGE_KEY, newValue: theirs })); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await useTerminalsStore.getState().refresh(); });
  await settle();
  expect(useTerminalTabsStore.getState().open).toEqual([]);
  expect(localStorage.getItem(TERMINAL_TABS_STORAGE_KEY)).toBe(theirs);
});

const kept = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-kept-terminal]")];
const shownKept = (host: HTMLElement) => kept(host).filter((el) => !el.hasAttribute("inert")).map((el) => el.getAttribute("data-kept-terminal"));

test("a terminal shown before is kept connected while another tab shows: back on its tab, no new connection and only its ⋯ in the header", async () => {
  const { host, sockets } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [pin("%1", 101)] });
  await click(tab(host, "Topic %1"));
  await click(tab(host, "zsh · ~/work"));
  expect(sockets.filter((id) => id === "%3")).toHaveLength(1);
  expect(shownKept(host)).toEqual(["%3:103"]);
  expect(kept(host).find((el) => el.getAttribute("data-kept-terminal") === "%1:101")!.hasAttribute("inert")).toBe(true);
  expect(host.querySelectorAll('[data-slot="terminal-controls"] [aria-label="Terminal actions"]')).toHaveLength(1);
  await click(tab(host, "All"));
  expect(shownKept(host)).toEqual([]);
});

const MANY: SessionDto[] = [{ ...SESSIONS[0]!, windows: [{ ...SESSIONS[0]!.windows[0]!, panes: [1, 2, 3, 4, 5, 6].map((n) => pane(`%${n}`, 100 + n)) }] }];

test("an address without a pid for a pinned pane, followed once the pins are read, takes the pane's pid, so a reused id never reaches the pin's terminal", async () => {
  await open("/terminals", { sessions: SESSIONS, pins: [pin("%1", 101)] });
  await act(async () => { goTo("/terminals/pane/%251"); });
  await settle();
  expect(where).toBe("/terminals/pane/%251?pid=101");
});

test("a desktop keeps the 5 terminals shown last; the 6th lets the oldest go", async () => {
  const { host } = await open("/terminals/pane/%251?pid=101", { sessions: MANY, pins: [] });
  for (const n of [2, 3, 4, 5, 6]) {
    await click(tab(host, "All"));
    await click([...host.querySelectorAll(`[data-open-pane="%${n}"]`)][0]!);
  }
  expect(kept(host).map((el) => el.getAttribute("data-kept-terminal")).sort()).toEqual(["%2:102", "%3:103", "%4:104", "%5:105", "%6:106"]);
});

test("a phone keeps 3", async () => {
  const realMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  onCleanup(() => { window.matchMedia = realMatchMedia; });
  const { host } = await open("/terminals/pane/%251?pid=101", { sessions: MANY, pins: [] });
  for (const n of [2, 3, 4]) {
    await click(tab(host, "All"));
    await click([...host.querySelectorAll(`[data-open-pane="%${n}"]`)][0]!);
  }
  expect(kept(host).map((el) => el.getAttribute("data-kept-terminal")).sort()).toEqual(["%2:102", "%3:103", "%4:104"]);
});

test("fitted to the browser, the terminals shown last are kept as well", async () => {
  const before = useUIStore.getState().terminalDisplay;
  act(() => { useUIStore.getState().setTerminalDisplay("screen"); });
  onCleanup(() => { useUIStore.getState().setTerminalDisplay(before); });
  const { host, sockets } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [pin("%1", 101)] });
  await click(tab(host, "Topic %1"));
  await click(tab(host, "zsh · ~/work"));
  expect(kept(host).map((el) => el.getAttribute("data-kept-terminal"))).toEqual(["%1:101", "%3:103"]);
  expect(sockets).toEqual(["%3", "%1"]);
});

test("a closed tab's terminal is let go", async () => {
  const { host } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [pin("%1", 101)] });
  await click(tab(host, "Topic %1"));
  await click(host.querySelector('[aria-label="Close zsh · ~/work"]')!);
  expect(kept(host).map((el) => el.getAttribute("data-kept-terminal"))).toEqual(["%1:101"]);
});

test("Pin moves an open tab among the pins; Unpin leaves it open, with its ×", async () => {
  const { host, posts } = await open("/terminals/pane/%252?pid=102", { sessions: SESSIONS, pins: [] });
  let item = await pinItem(host);
  expect(item.textContent?.trim()).toBe("Pin");
  await click(item);
  expect(posts).toEqual(["pin %2"]);
  expect(closable(host, "Topic %2")).toBe(false);
  item = await pinItem(host);
  expect(item.textContent?.trim()).toBe("Unpin");
  await click(item);
  expect(posts).toEqual(["pin %2", "unpin %2"]);
  expect(closable(host, "Topic %2")).toBe(true);
});

test("All lists every pane under its session and window; search shows the matches with where they are", async () => {
  const { host } = await open("/terminals", { sessions: SESSIONS, pins: [pin("%1", 101)] });
  expect(host.textContent).toContain("2 windows");
  expect([...host.querySelectorAll("[data-open-pane]")].map((r) => r.getAttribute("data-open-pane"))).toEqual(["%1", "%2", "%3", "%4"]);
  const input = host.querySelector<HTMLInputElement>('input[placeholder="Search terminals"]')!;
  await typeInto(input, "notes");
  await settle();
  expect([...host.querySelectorAll("[data-open-pane]")].map((r) => r.getAttribute("data-open-pane"))).toEqual(["%3", "%4"]);
  expect(host.textContent).toContain("work › notes");
  await typeInto(input, "zzz");
  await settle();
  expect(host.textContent).toContain("No terminals match.");
});

test("with no pins, All says what pinning is for", async () => {
  const { host } = await open("/terminals", { sessions: SESSIONS, pins: [] });
  expect(host.textContent).toContain("Pin the terminals you use often to keep them one click away.");
});

test("with no tmux sessions, All says how to open one", async () => {
  const { host } = await open("/terminals", { sessions: [], pins: [] });
  expect(host.textContent).toContain("No tmux sessions detected");
  expect(host.textContent).toContain("Open one with New terminal, or start tmux in your own terminal.");
});

test("New terminal opens the new shell's tab", async () => {
  const { host, posts } = await open("/terminals", { sessions: SESSIONS, pins: [] });
  await click(host.querySelector('[aria-label="New terminal"]')!);
  expect(posts).toEqual(["shell"]);
  expect(where).toBe("/terminals/pane/%254?pid=104");
});

test("a pane whose pid no longer matches shows the terminal closed", async () => {
  const { host } = await open("/terminals/pane/%251?pid=999", { sessions: SESSIONS, pins: [] });
  expect(host.textContent).toContain("This terminal has closed.");
});

test("an address without a pid takes the pane's pid at once, so a reused id never attaches later", async () => {
  await open("/terminals/pane/%251", { sessions: SESSIONS, pins: [] });
  expect(where).toBe("/terminals/pane/%251?pid=101");
});

test("a pane's row in All is a link to its terminal (so it opens in a new browser tab too), its pin beside the link", async () => {
  const { host } = await open("/terminals", { sessions: SESSIONS, pins: [] });
  const link = host.querySelector<HTMLElement>('[data-open-pane="%1"]')!;
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe("/terminals/pane/%251?pid=101");
  expect(link.querySelector("button") === null).toBe(true);
  expect(host.querySelector('[data-pane-row="%1"] > [aria-label="Pin"]') === null).toBe(false);
});

test("Enter on a row's pin pins it and stays in All", async () => {
  const { host, posts } = await open("/terminals", { sessions: SESSIONS, pins: [] });
  const pinOf2 = host.querySelector<HTMLElement>('[data-pane-row="%2"] [aria-label="Pin"]')!;
  await act(async () => {
    pinOf2.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    pinOf2.click();
  });
  await settle();
  expect(posts).toEqual(["pin %2"]);
  expect(where).toBe("/terminals");
});

test("the sidebar names Terminals, and Sessions is gone", () => {
  expect(navItems.map((item) => [item.to, item.label])).toContainEqual(["/terminals", "Terminals"]);
  expect(navItems.some((item) => item.label === "Sessions" || item.to === "/sessions")).toBe(false);
});

/** The page as the shell keeps it (KeptAlivePage), beside other pages. */
async function openKept(path: string, state: { sessions: SessionDto[]; pins: TerminalPinDto[] }) {
  const s = server(state);
  const view = mount(
    <MemoryRouter initialEntries={[path]}>
      <PaneHeaderSlotsProvider>
        <PaneHeaderTitleSlot />
        <PaneHeaderActionsSlot />
        <KeptAlivePage paths={TERMINALS_PAGE_PATHS} keepMs={60_000}><TerminalsPage /></KeptAlivePage>
        <Routes><Route path="*" element={<Where />} /></Routes>
        <GoTo />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  return { ...s, host: view.host };
}

test("left for another page, it keeps its terminals connected, hidden, reads no list and draws no tabs; back, the one shown shows again", async () => {
  const { host, sockets } = await openKept("/terminals/pane/%251?pid=101", { sessions: SESSIONS, pins: [pin("%3", 103)] });
  await click(tab(host, "zsh · ~/work"));
  expect(sockets).toEqual(["%1", "%3"]);
  let lists = 0;
  const stub = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/terminals") && (init?.method ?? "GET") === "GET") lists += 1;
    return stub(url, init);
  }) as typeof fetch;

  act(() => { goTo("/tasks"); });
  await settle();
  expect(host.querySelector('[data-slot="pane-title"] [role="tab"]') === null).toBe(true);
  expect(kept(host).map((el) => el.className.includes("invisible"))).toEqual([true, true]);
  act(() => { document.dispatchEvent(new window.Event("visibilitychange")); });
  await settle();
  expect(lists).toBe(0);

  act(() => { goTo("/terminals/pane/%253?pid=103"); });
  await settle();
  expect(sockets).toEqual(["%1", "%3"]);
  expect(kept(host).filter((el) => !el.className.includes("invisible")).map((el) => el.getAttribute("data-kept-terminal"))).toEqual(["%3:103"]);
  expect(tabs(host)).toContain("zsh · ~/work");
});


// Dragged into another order (e2e drags them: happy-dom has no layout), or
// moved by ⋯'s Move left / Move right, which go the same way: pins among the
// pins, saved on the server; open tabs among the open tabs, in this browser.
/** ⋯ opened once: its Move left and Move right. */
const moveItems = async (host: HTMLElement) => {
  const items = await terminalMenu(host);
  const named = (name: string) => items.find((i) => i.textContent?.trim() === name)!;
  return { left: named("Move left"), right: named("Move right") };
};
const disabled = (item: HTMLElement) => item.hasAttribute("data-disabled");
const closeMenu = async () => {
  await act(async () => { document.activeElement?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
};

test("pins are dragged among the pins and open tabs among the open tabs; All is not dragged", async () => {
  const { host } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [pin("%1", 101)] });
  expect([tab(host, "All").dataset.sortOrder, tab(host, "Topic %1").dataset.sortOrder, tab(host, "zsh · ~/work").dataset.sortOrder]).toEqual([undefined, "pins", "open"]);
});

test("Move right on the shown open tab puts it after the next open tab; Move left is off on the first open tab", async () => {
  const { host, posts } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [pin("%1", 101)] });
  await click(tab(host, "All"));
  await click([...host.querySelectorAll('[data-open-pane="%4"]')][0]!);
  await click(tab(host, "zsh · ~/work"));
  expect(tabs(host)).toEqual(["All", "Topic %1", "zsh · ~/work", "zsh · ~"]);
  let move = await moveItems(host);
  expect([disabled(move.left), disabled(move.right)]).toEqual([true, false]);
  await click(move.right);
  expect(tabs(host)).toEqual(["All", "Topic %1", "zsh · ~", "zsh · ~/work"]);
  expect(useTerminalTabsStore.getState().open.map((t) => t.paneId)).toEqual(["%4", "%3"]);
  move = await moveItems(host);
  expect([disabled(move.left), disabled(move.right)]).toEqual([false, true]);
  await closeMenu();
  expect(posts).toEqual([]);
});

test("Move right on a pin saves the new pin order; Move left is off on the first pin", async () => {
  const { host, posts } = await open("/terminals/pane/%251?pid=101", { sessions: SESSIONS, pins: [pin("%1", 101), pin("%2", 102)] });
  expect(tabs(host)).toEqual(["All", "Topic %1", "Topic %2"]);
  let move = await moveItems(host);
  expect([disabled(move.left), disabled(move.right)]).toEqual([true, false]);
  await click(move.right);
  expect(posts).toEqual(["order %2 %1"]);
  expect(tabs(host)).toEqual(["All", "Topic %2", "Topic %1"]);
  // The last pin goes no further: open tabs are another group.
  move = await moveItems(host);
  expect([disabled(move.left), disabled(move.right)]).toEqual([false, true]);
  await closeMenu();
});

// A tab still shown here that another window closed is no longer one of this
// browser's open tabs: nothing to drag or move.
test("a shown tab another window closed is not dragged and its ⋯ offers no Move", async () => {
  const { host } = await open("/terminals/pane/%253?pid=103", { sessions: SESSIONS, pins: [] });
  await click(tab(host, "All"));
  await click([...host.querySelectorAll('[data-open-pane="%4"]')][0]!);
  await click(tab(host, "zsh · ~/work"));
  const theirs = JSON.stringify({ state: { open: [{ paneId: "%4", pid: 104 }] }, version: 0 });
  localStorage.setItem(TERMINAL_TABS_STORAGE_KEY, theirs);
  await act(async () => { window.dispatchEvent(new window.StorageEvent("storage", { key: TERMINAL_TABS_STORAGE_KEY, newValue: theirs })); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  // Still shown, by its address, after this browser's open tabs.
  expect(tabs(host)).toEqual(["All", "zsh · ~", "zsh · ~/work"]);
  const [kept, shownOnly] = [...host.querySelectorAll<HTMLElement>('[role="tab"][data-terminal-tab]')];
  expect([kept!.dataset.sortOrder, shownOnly!.dataset.sortOrder]).toEqual(["open", undefined]);
  const items = (await terminalMenu(host)).map((i) => i.textContent?.trim());
  expect(items.filter((t) => t === "Move left" || t === "Move right")).toEqual([]);
  await closeMenu();
});
