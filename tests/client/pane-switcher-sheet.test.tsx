import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { PaneSwitcherSheet } from "@/routes/terminal/PaneSwitcherSheet";
import { SWITCHER_RECENT_MAX, buildSwitcherModel } from "@/routes/terminal/pane-switcher-model";
import { useUIStore, type RecentPane } from "@/store/ui";
import type { SessionDto } from "@shared/api-contracts";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mountAsync, settle, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;

const pane = (paneId: string, index: number, command = "zsh", name?: string) =>
  ({ paneId, index, active: index === 1, currentCommand: command, currentPath: "/home/user/p", title: null, pid: 100 + index, ...(name ? { metadata: { name, description: "", updatedAt: "" } } : {}) });
const SESSION: SessionDto = {
  name: "md-project-1", ownership: "managed", projectId: "p", projectName: "project-1",
  windows: [
    { name: "zsh", windowId: "@1", index: 1, active: false, panes: [pane("%1", 1)] },
    { name: "main", windowId: "@2", index: 2, active: true, panes: [pane("%28", 1, "zsh", "Build cache notes"), pane("%29", 2), pane("%30", 3, "codex")] },
    { name: "project1_issue_39", windowId: "@8", index: 8, active: false, panes: [pane("%40", 1, "codex")] }
  ]
};
const OTHER: SessionDto = {
  name: "md-project-2", ownership: "managed", projectId: "p2", projectName: "project-2",
  windows: [{ name: "main", windowId: "@20", index: 1, active: true, panes: [pane("%200", 1, "codex")] }]
};
const r = (paneId: string): RecentPane => ({ sessionName: "md-project-1", paneId });
// Newest first, plus the current pane (%28), which the sheet must leave out.
const RECENT: RecentPane[] = [
  r("%40"),
  r("%30"),
  r("%28")
];

// ── the switcher's model ────────────────────────────────────────────

// Windows deliberately declared OUT of index order (2, 8, 3, 1): the sort
// assertion below is vacuous if the fixture already arrives sorted.
const UNSORTED: SessionDto = {
  name: "md-project-1", ownership: "managed", projectId: "p", projectName: "project-1",
  windows: [
    { name: "main", windowId: "@2", index: 2, active: true, panes: [pane("%28", 1, "zsh", "Build cache notes"), pane("%29", 2), pane("%30", 3, "codex")] },
    { name: "project1_issue_39", windowId: "@8", index: 8, active: false, panes: [pane("%40", 1, "codex")] },
    { name: "tests", windowId: "@3", index: 3, active: false, panes: [pane("%50", 1), pane("%51", 2, "bun")] },
    { name: "zsh", windowId: "@1", index: 1, active: false, panes: [pane("%1", 1)] }
  ]
};

test("Recent reaches other sessions: rows carry the project name in their prefix and their own session", () => {
  const m = buildSwitcherModel({
    sessions: [UNSORTED, OTHER], sessionName: "md-project-1",
    recent: [
      { sessionName: "md-project-2", paneId: "%200" },
      r("%30"),
      { sessionName: "gone-session", paneId: "%999" }
    ],
    currentPaneId: "%28"
  });
  expect(m.recent.map((x) => [x.paneId, x.sessionName, x.prefix])).toEqual([
    ["%200", "md-project-2", "project-2 / main"],
    ["%30", "md-project-1", "main"]
  ]);
  // The window list stays the current session's.
  expect(m.windows.map((w) => w.windowName)).toEqual(["zsh", "main", "tests", "project1_issue_39"]);
});

test("windows keep tmux index order and carry their panes; the current pane is not in Recent", () => {
  const m = buildSwitcherModel({ sessions: [UNSORTED, OTHER], sessionName: "md-project-1", recent: [r("%28")], currentPaneId: "%28" });
  expect(m.windows.map((w) => w.windowName)).toEqual(["zsh", "main", "tests", "project1_issue_39"]);
  expect(m.windows[1]!.panes.map((p) => p.paneId)).toEqual(["%28", "%29", "%30"]);
  expect(m.recent.length).toBe(0);
});

test("Recent is newest first, capped, labelled with its window, and drops panes the session no longer has", () => {
  // Seven valid entries (plus one gone pane) so the cap is actually reached:
  // the sixth and seventh must be cut, not merely absent from a short list.
  const recent = [
    r("%40"),
    r("%30"),
    r("%999"),
    r("%1"),
    r("%29"),
    r("%28"),
    r("%50"),
    r("%51")
  ];
  const m = buildSwitcherModel({ sessions: [UNSORTED, OTHER], sessionName: "md-project-1", recent, currentPaneId: "%77" });
  expect(m.recent.length).toBe(SWITCHER_RECENT_MAX);
  expect(m.recent.map((p) => p.paneId)).toEqual(["%40", "%30", "%1", "%29", "%28"]);
  expect(m.recent.some((p) => p.paneId === "%50")).toBe(false);
  expect(m.recent.some((p) => p.paneId === "%51")).toBe(false);
  expect(m.recent[0]!.windowName).toBe("project1_issue_39");
  expect(m.recent[1]!.name).toBe(null);
  expect(m.recent[1]!.command).toBe("codex");
});

test("recent entries from an unknown session are dropped; recentOutput comes from changedAt", () => {
  const m = buildSwitcherModel({
    sessions: [UNSORTED, OTHER], sessionName: "md-project-1",
    recent: [{ sessionName: "other", paneId: "%28" }],
    currentPaneId: "%1",
    changedAtById: { "%30": "2026-09-17T09:59:00Z" },
    now: Date.parse("2026-09-17T10:00:00Z")
  });
  expect(m.recent.length).toBe(0);
  expect(m.windows[1]!.panes[2]!.recentOutput).toBe(true);
  expect(m.windows[1]!.panes[1]!.recentOutput).toBe(false);
});

test("a null session yields empty groups", () => {
  expect(buildSwitcherModel({ sessions: [], sessionName: "md-project-1", recent: [], currentPaneId: "%1" })).toEqual({ recent: [], windows: [] });
});

// ── the sheet ──────────────────────────────────────────────────────

let fetches: FetchCall[] = [];
function stubSessions(sessions: SessionDto[]) {
  fetches = mockFetch(() => jsonResponse({ sessions }));
}

beforeEach(() => {
  onCleanup(fakePhoneWidth(390));
  stubSessions([SESSION]);
  useUIStore.setState({ recentPanes: RECENT });
});
afterEach(() => {
  // Unmount before the recent panes the sheet reads are reset under it.
  runCleanups();
  view = null;
  // The sheet portals into document.body, outside its host.
  document.body.innerHTML = "";
  useUIStore.setState({ recentPanes: [] });
});

/** Mounts on first call; later calls re-render the same root with new props
 *  (the refetch test flips `open` on one mounted sheet). */
async function render(props: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  const tree = (
    <MemoryRouter>
      <PaneSwitcherSheet
        open={props.open ?? true}
        onOpenChange={props.onOpenChange ?? (() => {})}
        sessionName="md-project-1"
        currentPaneId="%28"
        hrefFor={(sn, w, p, pid) => `/x/${encodeURIComponent(sn)}/${encodeURIComponent(w)}/${encodeURIComponent(p)}?pid=${pid}`}
      />
    </MemoryRouter>
  );
  if (view) view.rerender(tree);
  else view = await mountAsync(tree);
  await settle();
}

test("the sheet lists Recent then every window in tmux order, current highlighted, one link per pane", async () => {
  await render();
  const sheet = document.querySelector('[data-slot="pane-switcher"]')!;
  expect(sheet === null).toBe(false);
  expect(sheet.querySelector('[data-slot="switcher-title"]')!.textContent).toContain("Switch pane");
  const groups = Array.from(sheet.querySelectorAll('[data-slot="switcher-group"]')).map((g) => g.getAttribute("data-group"));
  expect(groups).toEqual(["recent", "zsh", "main", "project1_issue_39"]);
  const recentRows = sheet.querySelectorAll('[data-slot="switcher-group"][data-group="recent"] [data-slot="pane-row"]');
  expect(recentRows.length).toBe(2);
  expect(recentRows[0]!.textContent).toContain("project1_issue_39");
  const current = sheet.querySelector('[data-slot="pane-row"][data-current="true"]')!;
  expect(current.getAttribute("data-pane-id")).toBe("%28");
  expect(current.closest('[data-slot="switcher-group"]')!.getAttribute("data-group")).toBe("main");
  expect(sheet.querySelector('[data-pane-id="%30"] a')!.getAttribute("href")).toBe("/x/md-project-1/main/%2530?pid=103");
});

test("without recents the Recent group is absent", async () => {
  useUIStore.setState({ recentPanes: [] });
  await render();
  const groups = Array.from(document.querySelectorAll('[data-slot="switcher-group"]')).map((g) => g.getAttribute("data-group"));
  expect(groups[0]).toBe("zsh");
  // The All windows heading is structure, not a Recent-group appendix.
  expect(document.querySelector('[data-slot="pane-switcher"]')!.textContent).toContain("All windows");
});

test("choosing a pane closes the sheet", async () => {
  let closed = 0;
  await render({ onOpenChange: (o: boolean) => { if (!o) closed += 1; } });
  const link = document.querySelector('[data-pane-id="%30"] a') as HTMLAnchorElement;
  act(() => { link.click(); });
  expect(closed).toBe(1);
});

test("the session list is fetched on every open and never while closed", async () => {
  await render({ open: false });
  expect(fetches.length).toBe(0);
  await render({ open: true });
  expect(fetches.length).toBe(1);
  await render({ open: false });
  expect(fetches.length).toBe(1);
  await render({ open: true });
  expect(fetches.length).toBe(2);
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
  expect(meta!.textContent).toContain("md-project-1");
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
    { sessionName: "md-project-2", paneId: "%200" },
    ...RECENT
  ] });
  await render();
  const sheet = document.querySelector('[data-slot="pane-switcher"]')!;
  const rows = sheet.querySelectorAll('[data-slot="switcher-group"][data-group="recent"] [data-slot="pane-row"]');
  expect(rows.length).toBe(3);
  const first = rows[0]!;
  expect(first.getAttribute("data-pane-id")).toBe("%200");
  expect(first.querySelector('[data-slot="pane-prefix"]')!.textContent).toContain("project-2 / main");
  expect(first.querySelector("a")!.getAttribute("href")).toBe("/x/md-project-2/main/%25200?pid=101");
  // Same-session rows keep the bare window name.
  expect(rows[1]!.querySelector('[data-slot="pane-prefix"]')!.textContent).not.toContain("project-1");
  // The window list is still the current session's.
  const groups = Array.from(sheet.querySelectorAll('[data-slot="switcher-group"]')).map((g) => g.getAttribute("data-group"));
  expect(groups).toEqual(["recent", "zsh", "main", "project1_issue_39"]);
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
