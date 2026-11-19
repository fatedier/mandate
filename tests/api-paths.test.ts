import { expect, test } from "bun:test";
import { apiPath, apiWebSocketPath } from "../src/client/lib/api-base.js";
import { api } from "../src/client/lib/api-paths.js";

// The server mounts on the same API_ROUTES constants, so a bare constant
// cannot drift from it: these are the paths that encode or add a query.
// Each path is built inside its own row, so a builder that throws fails that row.
const builtPaths: { name: string; path: () => string; expected: string }[] = [
  { name: "provider models encode the provider name", path: () => api.settingsProviderModels("open router"), expected: "/api/settings/providers/open%20router/models" },
  { name: "provider models ask for a refresh", path: () => api.settingsProviderModels("proxy", { refresh: true }), expected: "/api/settings/providers/proxy/models?refresh=1" },
  { name: "a provider check encodes the provider name", path: () => api.settingsProviderCheck("my proxy"), expected: "/api/settings/providers/my%20proxy/check" },
  { name: "a dream run encodes its id", path: () => api.memoryDreamRun("run 1"), expected: "/api/memory/dream/runs/run%201" },
  { name: "worker panes", path: () => api.workerPanes("worker 1"), expected: "/api/workers/worker%201/panes" },
  { name: "worker plans", path: () => api.workerPlan("worker 1"), expected: "/api/workers/worker%201/plan" },
  { name: "a pane encodes its id", path: () => api.paneById("%12"), expected: "/api/panes/%2512" },
  { name: "a pane split encodes the pane id", path: () => api.paneSplit("%12"), expected: "/api/panes/%2512/split" },
  { name: "tmux sessions", path: () => api.tmuxSessions, expected: "/api/tmux/sessions" },
  { name: "a task encodes its id", path: () => api.taskBoardTask("tsk 1"), expected: "/api/task-board/tasks/tsk%201" },
  { name: "the deleted tasks are asked for", path: () => api.taskBoardTasks({ deleted: true }), expected: "/api/task-board/tasks?deleted=1" },
  { name: "a task opened encodes its id", path: () => api.taskBoardOpened("tsk 1"), expected: "/api/task-board/tasks/tsk%201/opened" },
  { name: "a sticky note done encodes its id", path: () => api.stickyNoteDone("note 1"), expected: "/api/sticky-notes/note%201/done" },
  { name: "a sticky note restored encodes its id", path: () => api.stickyNoteRestore("note 1"), expected: "/api/sticky-notes/note%201/restore" },
  { name: "sticky notes shown are marked seen", path: () => api.stickyNotesSeen, expected: "/api/sticky-notes/seen" },
  { name: "the calendar's range is asked in epoch ms", path: () => api.calendar(1000, 2000), expected: "/api/calendar?from=1000&to=2000" },
  { name: "a calendar entry paused encodes its id", path: () => api.calendarPause("cal 1"), expected: "/api/calendar/cal%201/pause" },
  { name: "a calendar entry resumed encodes its id", path: () => api.calendarResume("cal 1"), expected: "/api/calendar/cal%201/resume" },
  { name: "a calendar time skipped encodes its id", path: () => api.calendarSkip("cal 1"), expected: "/api/calendar/cal%201/skip" },
  { name: "a calendar entry deleted encodes its id", path: () => api.calendarEntry("cal 1"), expected: "/api/calendar/cal%201" },
  { name: "a window encodes its tmux id", path: () => api.terminalWindow("@12"), expected: "/api/terminals/windows/%4012" },
  { name: "a pin encodes its pane id", path: () => api.terminalPin("%3"), expected: "/api/terminals/pins/%253" },
  { name: "Codex OAuth status encodes request id", path: () => api.codexAuthStatus("req 1"), expected: "/api/settings/auth/codex/status?requestId=req%201" },
  { name: "the activity summary carries the window", path: () => api.activitySummary(30), expected: "/api/activity/summary?days=30" },
  {
    name: "the activity summary carries the reader's time zone",
    path: () => api.activitySummary(30, "purpose", { tz: "Asia/Singapore" }),
    expected: "/api/activity/summary?days=30&group=purpose&tz=Asia%2FSingapore"
  }
];

test.each(builtPaths)("api paths: $name", ({ path, expected }) => {
  expect(path()).toBe(expected);
});

test("api paths: activity call filters encode query params", () => {
  expect(api.activityCall("call 1")).toBe("/api/activity/calls/call%201");
  expect(
    api.activityCalls({
      limit: 25,
      before: "2026-05-09T00:00:00.000Z",
      // The cursor is the pair. A builder that carried only the timestamp would
      // produce a URL that looks right and pages past rows sharing that
      // millisecond, so the id has to reach the query string.
      beforeId: "llm_cursor",
      status: null,
      purpose: null,
      q: "llm_abc"
    })
  ).toBe(
    "/api/activity/calls?limit=25&before=2026-05-09T00%3A00%3A00.000Z&beforeId=llm_cursor&q=llm_abc"
  );
});

test("api paths: the filters a breakdown row links by reach the query string", () => {
  // Three filters with no control on the log — the url is their only route in,
  // so a builder that drops one turns a breakdown row into a jump to the
  // unfiltered list.
  expect(
    api.activityCalls({ limit: 5, scopeType: "memory", day: "2026-08-04", fallback: "1" })
  ).toBe("/api/activity/calls?limit=5&scopeType=memory&day=2026-08-04&fallback=1");

  // The other half of the fallback cut, and the one a truthiness test drops:
  // "0" is the primary calls, not the absence of a filter.
  expect(api.activityCalls({ limit: 5, fallback: "0" }))
    .toBe("/api/activity/calls?limit=5&fallback=0");
});

test("api paths: the log's day travels with the reader's time zone", () => {
  // The server cuts the day in this zone; without it the day is UTC's.
  expect(api.activityCalls({ limit: 5, day: "2026-10-25", tz: "Asia/Singapore" }))
    .toBe("/api/activity/calls?limit=5&day=2026-10-25&tz=Asia%2FSingapore");
});

test("api base: desktop injection prefixes HTTP and WebSocket paths", () => {
  // bun:test runs without a DOM, so api-base's `typeof window === "undefined"`
  // guard short-circuits. Stub globalThis.window for this case so we can
  // exercise the desktop-config branch.
  const g = globalThis as unknown as {
    window?: { __MANDATE_DESKTOP__?: { apiBaseUrl?: string } };
  };
  const previous = g.window;
  try {
    g.window = { __MANDATE_DESKTOP__: { apiBaseUrl: "http://127.0.0.1:49152/" } };
    expect(apiPath("/api/state")).toBe("http://127.0.0.1:49152/api/state");
    expect(apiWebSocketPath("/api/terminal?paneId=p1")).toBe(
      "ws://127.0.0.1:49152/api/terminal?paneId=p1"
    );
  } finally {
    if (previous === undefined) delete g.window;
    else g.window = previous;
  }
});
