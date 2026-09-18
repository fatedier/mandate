import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { PaneSwitcherSheet } from "@/routes/terminal/PaneSwitcherSheet";
import { useUIStore, type RecentPane } from "@/store/ui";
import type { SessionDto } from "@shared/api-contracts";
import { fakePhoneWidth } from "../fake-phone-width";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreWidth: (() => void) | null = null;

const pane = (paneId: string, index: number, command = "zsh", name?: string) =>
  ({ paneId, index, active: index === 1, currentCommand: command, currentPath: "/home/fate/p", ...(name ? { metadata: { name, description: "", updatedAt: "" } } : {}) });
const SESSION: SessionDto = {
  name: "md-frp", ownership: "managed", projectId: "p", projectName: "frp",
  windows: [
    { name: "zsh", windowId: "@1", index: 1, active: false, panes: [pane("%1", 1)] },
    { name: "main", windowId: "@2", index: 2, active: true, panes: [pane("%28", 1, "zsh", "Untracked file forensics"), pane("%29", 2), pane("%30", 3, "codex")] },
    { name: "frp_issue_5460", windowId: "@8", index: 8, active: false, panes: [pane("%40", 1, "codex")] }
  ]
};
const OTHER: SessionDto = {
  name: "md-yamux", ownership: "managed", projectId: "p2", projectName: "yamux",
  windows: [{ name: "main", windowId: "@20", index: 1, active: true, panes: [pane("%200", 1, "codex")] }]
};
const r = (paneId: string, windowName: string, at: string): RecentPane => ({ sessionName: "md-frp", windowName, paneId, at });
// Newest first, plus the current pane (%28), which the sheet must leave out.
const RECENT: RecentPane[] = [
  r("%40", "frp_issue_5460", "2026-09-17T10:05:00Z"),
  r("%30", "main", "2026-09-17T10:04:00Z"),
  r("%28", "main", "2026-09-17T10:00:00Z")
];

let fetches = 0;
function stubSessions(sessions: SessionDto[]) {
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({ sessions }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  restoreWidth = fakePhoneWidth(390);
  fetches = 0;
  stubSessions([SESSION]);
  useUIStore.setState({ recentPanes: RECENT });
});
afterEach(() => {
  act(() => root?.unmount()); host?.remove(); root = null; host = null;
  // The sheet portals into document.body, outside `host`.
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
  useUIStore.setState({ recentPanes: [] });
  restoreWidth?.(); restoreWidth = null;
});

/** Mounts on first call; later calls re-render the same root with new props
 *  (the refetch test flips `open` on one mounted sheet). */
async function render(props: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
  }
  await act(async () => {
    root ??= createRoot(host!);
    root.render(
      <MemoryRouter>
        <PaneSwitcherSheet
          open={props.open ?? true}
          onOpenChange={props.onOpenChange ?? (() => {})}
          sessionName="md-frp"
          currentPaneId="%28"
          hrefFor={(sn, w, p) => `/sessions/${encodeURIComponent(sn)}/windows/${encodeURIComponent(w)}/pane/${encodeURIComponent(p)}`}
        />
      </MemoryRouter>
    );
  });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
}

test("the sheet lists Recent then every window in tmux order, current highlighted, one link per pane", async () => {
  await render();
  const sheet = document.querySelector('[data-slot="pane-switcher"]')!;
  expect(sheet === null).toBe(false);
  expect(sheet.querySelector('[data-slot="switcher-title"]')!.textContent).toContain("Switch pane");
  const groups = Array.from(sheet.querySelectorAll('[data-slot="switcher-group"]')).map((g) => g.getAttribute("data-group"));
  expect(groups).toEqual(["recent", "zsh", "main", "frp_issue_5460"]);
  const recentRows = sheet.querySelectorAll('[data-slot="switcher-group"][data-group="recent"] [data-slot="pane-row"]');
  expect(recentRows.length).toBe(2);
  expect(recentRows[0]!.textContent).toContain("frp_issue_5460");
  const current = sheet.querySelector('[data-slot="pane-row"][data-current="true"]')!;
  expect(current.getAttribute("data-pane-id")).toBe("%28");
  expect(current.closest('[data-slot="switcher-group"]')!.getAttribute("data-group")).toBe("main");
  expect(sheet.querySelector('[data-pane-id="%30"] a')!.getAttribute("href")).toBe("/sessions/md-frp/windows/main/pane/%2530");
});

test("without recents the Recent group is absent", async () => {
  useUIStore.setState({ recentPanes: [] });
  await render();
  const groups = Array.from(document.querySelectorAll('[data-slot="switcher-group"]')).map((g) => g.getAttribute("data-group"));
  expect(groups[0]).toBe("zsh");
  // The All windows heading is structure, not a Recent-group appendix (§8.2).
  expect(document.querySelector('[data-slot="pane-switcher"]')!.textContent).toContain("All windows");
});

test("choosing a pane closes the sheet", async () => {
  let closed = 0;
  await render({ onOpenChange: (o: boolean) => { if (!o) closed += 1; } });
  const link = document.querySelector('[data-pane-id="%30"] a') as HTMLAnchorElement;
  act(() => { link.click(); });
  expect(closed).toBe(1);
});

test("the session list is fetched on every open and never while closed (§8.3)", async () => {
  await render({ open: false });
  expect(fetches).toBe(0);
  await render({ open: true });
  expect(fetches).toBe(1);
  await render({ open: false });
  expect(fetches).toBe(1);
  await render({ open: true });
  expect(fetches).toBe(2);
});

test("the title line pluralises the window count", async () => {
  stubSessions([{ ...SESSION, windows: [SESSION.windows[1]!] }]);
  await render();
  const text = document.querySelector('[data-slot="pane-switcher"]')!.textContent ?? "";
  expect(text).toContain("1 window");
  expect(text).not.toContain("1 windows");
});

test("at 390px the title line stays one line: title and legend never wrap, the session meta truncates", async () => {
  await render();
  const sheet = document.querySelector('[data-slot="pane-switcher"]')!;
  const title = sheet.querySelector('[data-slot="switcher-title"]');
  expect(title === null).toBe(false);
  const titleTokens = title!.className.split(/\s+/);
  expect(titleTokens).toContain("shrink-0");
  expect(titleTokens).toContain("whitespace-nowrap");
  const meta = sheet.querySelector('[data-slot="switcher-session"]');
  expect(meta === null).toBe(false);
  const metaTokens = meta!.className.split(/\s+/);
  expect(metaTokens).toContain("min-w-0");
  expect(metaTokens).toContain("truncate");
  expect(metaTokens).toContain("font-mono");
  expect(metaTokens).toContain("text-faint");
  expect(meta!.textContent).toContain("md-frp");
  const legend = sheet.querySelector('[data-slot="switcher-legend"]');
  expect(legend === null).toBe(false);
  const legendTokens = legend!.className.split(/\s+/);
  expect(legendTokens).toContain("shrink-0");
  expect(legendTokens).toContain("whitespace-nowrap");
  expect(legend!.textContent).toContain("recent output");
});

test("the open dialog carries no focus outline (Radix focuses the content on open)", async () => {
  await render();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog === null).toBe(false);
  expect(dialog!.className.split(/\s+/)).toContain("outline-none");
});

test("a Recent row from another session shows 'project / window' and links into that session", async () => {
  stubSessions([SESSION, OTHER]);
  useUIStore.setState({ recentPanes: [
    { sessionName: "md-yamux", windowName: "main", paneId: "%200", at: "2026-09-17T10:06:00Z" },
    ...RECENT
  ] });
  await render();
  const sheet = document.querySelector('[data-slot="pane-switcher"]')!;
  const rows = sheet.querySelectorAll('[data-slot="switcher-group"][data-group="recent"] [data-slot="pane-row"]');
  expect(rows.length).toBe(3);
  const first = rows[0]!;
  expect(first.getAttribute("data-pane-id")).toBe("%200");
  expect(first.querySelector('[data-slot="pane-prefix"]')!.textContent).toContain("yamux / main");
  expect(first.querySelector("a")!.getAttribute("href")).toBe("/sessions/md-yamux/windows/main/pane/%25200");
  // Same-session rows keep the bare window name.
  expect(rows[1]!.querySelector('[data-slot="pane-prefix"]')!.textContent).not.toContain("/ frp");
  // The window list is still the current session's.
  const groups = Array.from(sheet.querySelectorAll('[data-slot="switcher-group"]')).map((g) => g.getAttribute("data-group"));
  expect(groups).toEqual(["recent", "zsh", "main", "frp_issue_5460"]);
});

test("× on a Recent row forgets that pane without closing the sheet; Clear empties the group", async () => {
  let closed = 0;
  await render({ onOpenChange: (o: boolean) => { if (!o) closed += 1; } });
  const sheet = document.querySelector('[data-slot="pane-switcher"]')!;
  const before = sheet.querySelectorAll('[data-group="recent"] [data-slot="pane-row"]').length;
  expect(before).toBe(2);
  const dismiss = sheet.querySelector<HTMLButtonElement>('[data-group="recent"] [data-pane-id="%40"] [data-slot="pane-dismiss"]')!;
  expect(dismiss === null).toBe(false);
  await act(async () => { dismiss.click(); });
  expect(useUIStore.getState().recentPanes.some((r) => r.paneId === "%40")).toBe(false);
  expect(document.querySelectorAll('[data-group="recent"] [data-slot="pane-row"]').length).toBe(1);
  expect(closed).toBe(0);
  const clear = document.querySelector<HTMLButtonElement>('[data-slot="switcher-clear"]')!;
  expect(clear === null).toBe(false);
  await act(async () => { clear.click(); });
  expect(useUIStore.getState().recentPanes).toEqual([]);
  expect(document.querySelector('[data-group="recent"]') === null).toBe(true);
  expect(document.querySelector('[data-slot="switcher-clear"]') === null).toBe(true);
});
