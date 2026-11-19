import { expect, test } from "bun:test";
import { findPane, searchTerminals, sessionLabel, terminalDisplayName, terminalHref, terminalWhere, windowHref } from "@/lib/terminals-model";
import type { SessionDto, SessionPaneDto } from "@shared/api-contracts";

const pane = (over: Partial<SessionPaneDto>): SessionPaneDto => ({
  paneId: "%1", index: 0, active: true, currentCommand: "zsh", currentPath: "/Users/dev", title: null, pid: 101, ...over
});
const session = (name: string, windows: Array<{ name: string; panes: SessionPaneDto[] }>, project?: string): SessionDto => ({
  name, ownership: project ? "managed" : "unmanaged", projectId: project ? "p1" : null, projectName: project ?? null,
  windows: windows.map((w, i) => ({ name: w.name, windowId: `@${i + 1}`, index: i, active: i === 0, panes: w.panes }))
});

test("a pane's display name: Mandate's name, a shell by its folder, a program by its title, else command and folder", () => {
  expect(terminalDisplayName(pane({ currentCommand: "codex", title: "x", metadata: { name: "Release check", description: "", updatedAt: "" } }))).toBe("Release check");
  expect(terminalDisplayName(pane({ currentPath: "/Users/dev/work/x", title: "dev@box:~/work/x" }))).toBe("zsh · ~/work/x");
  expect(terminalDisplayName(pane({ currentCommand: "codex", title: "Garden plan sync" }))).toBe("Garden plan sync");
  expect(terminalDisplayName(pane({ currentCommand: "htop", title: null }))).toBe("htop · ~");
});

test("where a pane is: command, session › window, folder", () => {
  expect(terminalWhere(pane({ currentCommand: "codex", currentPath: "/Users/dev/work" }), "work", "main")).toBe("codex · work › main · ~/work");
});

test("a terminal's address carries its pid and round-trips a pane id", () => {
  const href = terminalHref("%12", 4242);
  expect(href).toBe("/terminals/pane/%2512?pid=4242");
  expect(decodeURIComponent(href.split("/")[3]!.split("?")[0]!)).toBe("%12");
  expect(windowHref("@3")).toBe("/terminals/window/%403");
});

test("search matches a title in any script, a window name, and nothing else", () => {
  const sessions = [
    session("work", [{ name: "main", panes: [pane({ paneId: "%1", currentCommand: "codex", title: "整理花园种植计划" })] }, { name: "notes", panes: [pane({ paneId: "%2" })] }])
  ];
  expect(searchTerminals(sessions, "花园").map((hit) => hit.pane.paneId)).toEqual(["%1"]);
  expect(searchTerminals(sessions, "NOTES").map((hit) => [hit.pane.paneId, hit.session, hit.window.name])).toEqual([["%2", "work", "notes"]]);
  expect(searchTerminals(sessions, "nothing-like-it")).toEqual([]);
});

test("a session's small text: its window count, or the project it belongs to", () => {
  expect(sessionLabel(session("work", [{ name: "a", panes: [] }]))).toBe("1 window");
  expect(sessionLabel(session("work", [{ name: "a", panes: [] }, { name: "b", panes: [] }, { name: "c", panes: [] }]))).toBe("3 windows");
  expect(sessionLabel(session("md-orchard", [{ name: "a", panes: [] }], "Orchard"))).toBe("Orchard · project");
});

test("findPane names a pane by id and pid", () => {
  const sessions = [session("work", [{ name: "main", panes: [pane({ paneId: "%1", pid: 101 })] }])];
  expect(findPane(sessions, "%1", 101)?.window.name).toBe("main");
  expect(findPane(sessions, "%1", 999)).toBeNull();
  expect(findPane(sessions, "%9", 101)).toBeNull();
});
