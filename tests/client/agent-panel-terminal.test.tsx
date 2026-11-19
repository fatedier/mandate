import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { useLocation } from "react-router";
import { AgentPagePane } from "@/routes/personal/page/AgentPagePane";
import { resetAgentPageStore } from "@/store/agent-page";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useThreadTabsStore } from "@/store/thread-tabs";
import { useClosedTabsStore } from "@/store/closed-tabs";
import { useTerminalsStore } from "@/store/terminals";
import { resetKeptTerminals } from "@/routes/terminals/kept-terminals";
import { onCleanup } from "../helpers/cleanup.js";
import { CALENDAR_TAB, NOTES_TAB, terminalOfTab, terminalTabId } from "@/lib/panel-tabs";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settleUntil } from "../helpers/mount.js";

// Terminals beside the personal agent: New terminal and the pinned panes in
// its panel's +, each opening a terminal tab there (a phone goes full screen).

const UI = { open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat" as const, tabs: [], active: "page", fileLines: {}, history: false, recent: [], tasksView: { query: "", showCancelled: false } };
const realMatchMedia = window.matchMedia;
afterEach(() => {
  runCleanups();
  resetAgentPageStore();
  useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
  useTerminalsStore.setState({ sessions: null, pins: [], status: "idle", error: null, latest: 0, applied: 0, listApplied: 0 });
  useAgentPageUi.setState(UI);
  useClosedTabsStore.setState({ byPanel: {} });
  window.matchMedia = realMatchMedia;
  resetKeptTerminals();
});

const SESSIONS = [{
  name: "work", ownership: "unmanaged", projectId: null, projectName: null,
  windows: [{ name: "main", windowId: "@1", index: 0, active: true, panes: [
    { paneId: "%3", index: 0, active: true, currentCommand: "codex", currentPath: "/home/dev/work", title: "Model list sync", pid: 333 },
    { paneId: "%7", index: 1, active: false, currentCommand: "zsh", currentPath: "/home/dev", title: null, pid: 4242 }
  ] }]
}];

/** The server's pins; a test changes them to stand for the server dropping one. */
let serverPins = [{ paneId: "%3", pid: 333, pinnedAt: "2026-11-13T00:00:00.000Z" }];

function serve(livePid: Record<string, number> = { "%3": 333, "%7": 4242 }) {
  serverPins = [{ paneId: "%3", pid: 333, pinnedAt: "2026-11-13T00:00:00.000Z" }];
  return mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") return jsonResponse({ latest: null, write: null });
    if (path === "/api/agents/personal/thread-tabs") return jsonResponse({ tabs: [] });
    if (path === "/api/agents/threads/thr_g/reply-tabs") return jsonResponse({ tabs: [] });
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    if (path === "/api/terminals" && call.method === "GET") return jsonResponse({ sessions: SESSIONS, pins: serverPins });
    if (path === "/api/terminals" && call.method === "POST") return jsonResponse({ paneId: "%7", pid: 4242 });
    const pane = path.match(/^\/api\/panes\/(.+)$/);
    if (pane) {
      const id = decodeURIComponent(pane[1]!);
      return jsonResponse({ paneId: id, sessionName: "work", windowName: "main", windowId: "@1", windowIndex: 0, paneIndex: 0, active: true, currentCommand: id === "%3" ? "codex" : "zsh", currentPath: "/home/dev", pid: livePid[id] ?? 1, paneWidth: 80, paneHeight: 24, projectId: null });
    }
    return jsonResponse({}, 404);
  });
}

async function openAddMenu(host: HTMLElement) {
  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Open a thread beside Juno"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')];
}
const menuText = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"], [role="menu"] [data-slot="dropdown-menu-label"]')].map((el) => el.textContent?.trim());

test("a terminal tab id names the pane and its pid, and reads back", () => {
  expect(terminalTabId("%7", 4242)).toBe("terminal:%7:4242");
  expect(terminalOfTab("terminal:%7:4242")).toEqual({ paneId: "%7", pid: 4242 });
  expect([terminalOfTab("task:x"), terminalOfTab("terminal:%7"), terminalOfTab("terminal::1")]).toEqual([null, null, null]);
});

test("+ offers New terminal and the pinned terminals, after Calendar and before the threads", async () => {
  serve();
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => useTerminalsStore.getState().sessions !== null, "the terminals read");
  await openAddMenu(host);
  const text = menuText();
  expect(text.slice(0, 6)).toEqual(["Tasks", "Notes", "Calendar", "New terminal", "Terminals", "Model list sync"]);
  expect(text).toContain("Open beside Juno");
});

test("+ reads the terminals again as it opens: a pin whose pane closed since is not offered", async () => {
  serve();
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => useTerminalsStore.getState().pins.length === 1, "the first read");
  serverPins = [];
  await openAddMenu(host);
  await settleUntil(() => !menuText().includes("Model list sync"), "the closed pane's pin gone from the menu");
  expect(menuText()).not.toContain("Terminals");
});

test("New terminal opens the new shell as a tab beside the agent", async () => {
  serve();
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  const items = await openAddMenu(host);
  await act(async () => { items.find((i) => i.textContent?.trim() === "New terminal")!.click(); });
  await settleUntil(() => useAgentPageUi.getState().active === "terminal:%7:4242", "the new shell's tab shown");
  expect(useAgentPageUi.getState().tabs).toContain("terminal:%7:4242");
  expect(host.querySelector('[data-terminal-tab="%7"][role="tab"]') === null).toBe(false);
});

test("a pinned terminal opens as a tab, and the menu ticks it next time", async () => {
  serve();
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => useTerminalsStore.getState().sessions !== null, "the terminals read");
  let items = await openAddMenu(host);
  await act(async () => { items.find((i) => i.textContent?.includes("Model list sync"))!.click(); });
  expect(useAgentPageUi.getState().active).toBe("terminal:%3:333");
  items = await openAddMenu(host);
  expect(items.find((i) => i.textContent?.includes("Model list sync"))!.querySelector('[aria-label="Open"]') === null).toBe(false);
});

test("a terminal tab's tooltip is its full name and where it is", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: ["terminal:%3:333"], active: "terminal:%3:333" }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => (host.querySelector('[data-terminal-tab="%3"] [title]')?.getAttribute("title") ?? "").includes("›"), "the tab named with its place");
  expect(host.querySelector('[data-terminal-tab="%3"] [title]')!.getAttribute("title")).toBe("Model list sync\nwork › main");
});

test("a terminal tab draws no header of its own: its ⋯ is in the panel's row, before the panel's own tools", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: ["terminal:%3:333"], active: "terminal:%3:333" }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => host.querySelector('[data-slot="terminal-controls"] [aria-label="Terminal actions"]') !== null, "the terminal's controls in the row");
  const tablist = host.querySelector('[role="tablist"]')!;
  expect(tablist.parentElement!.contains(host.querySelector('[data-slot="terminal-controls"]'))).toBe(true);
  expect(host.querySelector("header") === null).toBe(true);
});

test("the panel keeps the terminals it showed connected: back on one, no new connection", async () => {
  serve();
  const sockets: string[] = [];
  const realSocket = globalThis.WebSocket;
  globalThis.WebSocket = class { static OPEN = 1; readyState = 0; binaryType = ""; onopen = null; onclose = null; onerror = null; onmessage = null; constructor(url: string) { sockets.push(new URL(url, "http://x").searchParams.get("paneId") ?? url); } send() {} close() {} } as unknown as typeof WebSocket;
  onCleanup(() => { globalThis.WebSocket = realSocket; });
  act(() => { useAgentPageUi.setState({ tabs: ["terminal:%3:333", "terminal:%7:4242"], active: "terminal:%3:333" }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => sockets.includes("%3"), "the first terminal connected");
  act(() => { useAgentPageUi.setState({ active: "terminal:%7:4242" }); });
  await settleUntil(() => sockets.includes("%7"), "the second terminal connected");
  act(() => { useAgentPageUi.setState({ active: "terminal:%3:333" }); });
  // Its terminal drawn again (a new one would look its pane up first, then connect).
  await settleUntil(() => host.querySelector('[data-kept-terminal="terminal:%3:333"]:not([inert])') !== null
    && host.querySelector('[data-slot="terminal-controls"] [aria-label="Terminal actions"]') !== null, "the first shown again, with its controls");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(sockets.filter((id) => id === "%3")).toHaveLength(1);
});

test("a saved tab whose pane now has another pid shows the terminal closed", async () => {
  serve({ "%3": 999 });
  act(() => { useAgentPageUi.setState({ tabs: ["terminal:%3:333"], active: "terminal:%3:333" }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => (host.textContent ?? "").includes("This terminal has closed."), "the closed notice");
});

let where = "";
function Where() { where = useLocation().pathname + useLocation().search; return null; }

test("on a phone the same choice opens the terminal full screen", async () => {
  window.matchMedia = ((query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  serve();
  const host = (await mountAsync(<><AgentPagePane name="Juno" threadId="thr_g" /><Where /></>, { path: "/agent" })).host;
  const items = await openAddMenu(host);
  await act(async () => { items.find((i) => i.textContent?.trim() === "New terminal")!.click(); });
  await settleUntil(() => where.startsWith("/terminals/pane/"), "the full-screen terminal");
  expect(where).toBe("/terminals/pane/%257?pid=4242");
  expect(useAgentPageUi.getState().tabs).toEqual([]);
});

test("on a phone a terminal tab kept from a wide screen is no place to fall back to", async () => {
  window.matchMedia = ((query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  serve();
  act(() => { useAgentPageUi.setState({ tabs: [NOTES_TAB, "terminal:%3:333", CALENDAR_TAB], recent: [NOTES_TAB, "terminal:%3:333", CALENDAR_TAB], active: CALENDAR_TAB }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await act(async () => { host.querySelector<HTMLElement>('[aria-label="Close Calendar"]')!.click(); });
  expect(useAgentPageUi.getState().active).toBe(NOTES_TAB);
});


// Move left / Move right order the Terminals page's tabs: the panel's tabs
// are not that order, so its ⋯ has neither.
test("a terminal tab's ⋯ in the panel has no Move left or Move right", async () => {
  serve();
  act(() => { useAgentPageUi.setState({ tabs: ["terminal:%3:333"], active: "terminal:%3:333" }); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  await settleUntil(() => host.querySelector('[data-slot="terminal-controls"] [aria-label="Terminal actions"]') !== null, "the terminal's controls in the row");
  await act(async () => {
    host.querySelector<HTMLElement>('[data-slot="terminal-controls"] [aria-label="Terminal actions"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const items = menuText();
  expect(items.some((t) => t === "Pin" || t === "Unpin")).toBe(true);
  expect(items.filter((t) => t === "Move left" || t === "Move right")).toEqual([]);
});
