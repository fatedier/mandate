import { expect, test } from "bun:test";
import { apiPath, apiWebSocketPath } from "../src/client/lib/api-base.js";
import { api } from "../src/client/lib/api-paths.js";

test("api paths: static endpoints", () => {
  expect(api.events).toBe("/api/events");
  expect(api.state).toBe("/api/state");
  expect(api.settingsConfig).toBe("/api/settings/config");
  expect(api.setupStatus).toBe("/api/setup/status");
  expect(api.projectReorder).toBe("/api/projects/reorder");
  expect(api.codexAuthStart).toBe("/api/settings/auth/codex/start");
  expect(api.codexAuthLogout).toBe("/api/settings/auth/codex/logout");
  expect(api.settingsProviderModels("open router")).toBe(
    "/api/settings/providers/open%20router/models"
  );
  expect(api.settingsProviderModels("proxy", { refresh: true })).toBe(
    "/api/settings/providers/proxy/models?refresh=1"
  );
  expect(api.windowInspect).toBe("/api/windows/inspect");
  expect(api.memoryDreamRuns).toBe("/api/memory/dream/runs");
  expect(api.memoryDreamRun("run 1")).toBe("/api/memory/dream/runs/run%201");
});

test("api paths: feature panes", () => {
  expect(api.featurePanes("feature 1")).toBe("/api/features/feature%201/panes");
});

test("api paths: panes, sessions, and git", () => {
  expect(api.paneById("%12")).toBe("/api/panes/%2512");
  expect(api.paneSplit("%12")).toBe("/api/panes/%2512/split");
  expect(api.tmuxSessions).toBe("/api/tmux/sessions");
  expect(api.windowDetail("dev session", "main/window")).toBe(
    "/api/sessions/dev%20session/windows/main%2Fwindow"
  );
  expect(api.projectBranches("project 1")).toBe("/api/projects/project%201/git/branches");
});

test("api paths: Codex OAuth status encodes request id", () => {
  expect(api.codexAuthStatus("req 1")).toBe("/api/settings/auth/codex/status?requestId=req%201");
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

test("api paths: the activity summary carries the window", () => {
  expect(api.activitySummary(30)).toBe("/api/activity/summary?days=30");
});

test("api base: desktop injection prefixes HTTP and WebSocket paths", () => {
  // bun:test runs without a DOM, so api-base's `typeof window === "undefined"`
  // guard short-circuits. Stub globalThis.window for this case so we can
  // exercise the desktop-config branch.
  const g = globalThis as typeof globalThis & {
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
