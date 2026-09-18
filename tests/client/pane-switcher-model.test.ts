import { expect, test } from "bun:test";
import { SWITCHER_RECENT_MAX, buildSwitcherModel } from "@/routes/terminal/pane-switcher-model";
import type { SessionDto } from "@shared/api-contracts";
import type { RecentPane } from "@/store/ui";

const pane = (paneId: string, index: number, command = "zsh", name?: string) =>
  ({ paneId, index, active: index === 1, currentCommand: command, currentPath: "/home/fate/p", ...(name ? { metadata: { name, description: "", updatedAt: "" } } : {}) });
// Windows deliberately declared OUT of index order (2, 8, 3, 1): the sort
// assertion below is vacuous if the fixture already arrives sorted.
const SESSION: SessionDto = {
  name: "md-frp", ownership: "managed", projectId: "p", projectName: "frp",
  windows: [
    { name: "main", windowId: "@2", index: 2, active: true, panes: [pane("%28", 1, "zsh", "Untracked file forensics"), pane("%29", 2), pane("%30", 3, "codex")] },
    { name: "frp_issue_5460", windowId: "@8", index: 8, active: false, panes: [pane("%40", 1, "codex")] },
    { name: "tests", windowId: "@3", index: 3, active: false, panes: [pane("%50", 1), pane("%51", 2, "bun")] },
    { name: "zsh", windowId: "@1", index: 1, active: false, panes: [pane("%1", 1)] }
  ]
};
// A second, managed session: Recent reaches across sessions and labels those
// rows with the project name.
const OTHER: SessionDto = {
  name: "md-yamux", ownership: "managed", projectId: "p2", projectName: "yamux",
  windows: [{ name: "main", windowId: "@20", index: 1, active: true, panes: [pane("%200", 1, "codex")] }]
};
const r = (paneId: string, windowName: string, at: string): RecentPane => ({ sessionName: "md-frp", windowName, paneId, at });

test("Recent reaches other sessions: rows carry the project name in their prefix and their own session", () => {
  const m = buildSwitcherModel({
    sessions: [SESSION, OTHER], sessionName: "md-frp",
    recent: [
      { sessionName: "md-yamux", windowName: "main", paneId: "%200", at: "2026-09-17T10:05:00Z" },
      r("%30", "main", "2026-09-17T10:04:00Z"),
      { sessionName: "gone-session", windowName: "x", paneId: "%999", at: "2026-09-17T10:03:00Z" }
    ],
    currentPaneId: "%28"
  });
  expect(m.recent.map((x) => [x.paneId, x.sessionName, x.prefix])).toEqual([
    ["%200", "md-yamux", "yamux / main"],
    ["%30", "md-frp", "main"]
  ]);
  // The window list stays the current session's.
  expect(m.windows.map((w) => w.windowName)).toEqual(["zsh", "main", "tests", "frp_issue_5460"]);
});

test("windows keep tmux index order and carry their panes; the current pane is not in Recent", () => {
  const m = buildSwitcherModel({ sessions: [SESSION, OTHER], sessionName: "md-frp", recent: [r("%28", "main", "2026-09-17T10:00:00Z")], currentPaneId: "%28" });
  expect(m.windows.map((w) => w.windowName)).toEqual(["zsh", "main", "tests", "frp_issue_5460"]);
  expect(m.windows[1]!.panes.map((p) => p.paneId)).toEqual(["%28", "%29", "%30"]);
  expect(m.recent.length).toBe(0);
});

test("Recent is newest first, capped, labelled with its window, and drops panes the session no longer has", () => {
  // Seven valid entries (plus one gone pane) so the cap is actually reached:
  // the sixth and seventh must be cut, not merely absent from a short list.
  const recent = [
    r("%40", "frp_issue_5460", "2026-09-17T10:07:00Z"),
    r("%30", "main", "2026-09-17T10:06:00Z"),
    r("%999", "gone", "2026-09-17T10:05:00Z"),
    r("%1", "zsh", "2026-09-17T10:04:00Z"),
    r("%29", "main", "2026-09-17T10:03:00Z"),
    r("%28", "main", "2026-09-17T10:02:00Z"),
    r("%50", "tests", "2026-09-17T10:01:00Z"),
    r("%51", "tests", "2026-09-17T10:00:00Z")
  ];
  const m = buildSwitcherModel({ sessions: [SESSION, OTHER], sessionName: "md-frp", recent, currentPaneId: "%77" });
  expect(m.recent.length).toBe(SWITCHER_RECENT_MAX);
  expect(m.recent.map((p) => p.paneId)).toEqual(["%40", "%30", "%1", "%29", "%28"]);
  expect(m.recent.some((p) => p.paneId === "%50")).toBe(false);
  expect(m.recent.some((p) => p.paneId === "%51")).toBe(false);
  expect(m.recent[0]!.windowName).toBe("frp_issue_5460");
  expect(m.recent[1]!.name).toBe(null);
  expect(m.recent[1]!.command).toBe("codex");
});

test("recent entries from an unknown session are dropped; recentOutput comes from changedAt", () => {
  const m = buildSwitcherModel({
    sessions: [SESSION, OTHER], sessionName: "md-frp",
    recent: [{ sessionName: "other", windowName: "main", paneId: "%28", at: "2026-09-17T10:00:00Z" }],
    currentPaneId: "%1",
    changedAtById: { "%30": "2026-09-17T09:59:00Z" },
    now: Date.parse("2026-09-17T10:00:00Z")
  });
  expect(m.recent.length).toBe(0);
  expect(m.windows[1]!.panes[2]!.recentOutput).toBe(true);
  expect(m.windows[1]!.panes[1]!.recentOutput).toBe(false);
});

test("a null session yields empty groups", () => {
  expect(buildSwitcherModel({ sessions: [], sessionName: "md-frp", recent: [], currentPaneId: "%1" })).toEqual({ recent: [], windows: [] });
});
