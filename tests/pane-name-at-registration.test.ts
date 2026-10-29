import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { currentPaneName } from "../src/server/runtime/pane-watch-state.js";
import { PaneMetadataStore } from "../src/server/modules/panes/pane-metadata-store.js";
import { initializePanesSchema } from "../src/server/modules/panes/schema.js";
import type { RawTmuxPane, RawTmuxState, TmuxSnapshot } from "../src/server/platform/tmux/tmux-types.js";
import { freshAgentEnv } from "./helpers/fixtures.js";

// A pane monitor records its pane's name when it registers. The
// name comes from the pane metadata store, which set_pane_metadata writes at
// once, not from the snapshot's copy, which the poller refreshes only at its
// next pass: a monitor registered right after a rename recorded the old name.

function snapshot(name: string | null): TmuxSnapshot {
  return {
    generatedAt: "2026-10-09T05:00:00.000Z",
    clients: [],
    counts: {},
    sessions: [{
      sessionName: "md-project-1", windows: [{
        windowName: "pr_56", windowIndex: 2,
        panes: [{ paneId: "%112", sessionName: "md-project-1", windowName: "pr_56", ...(name ? { metadata: { name, description: "", updatedAt: "" } } : {}) }]
      }]
    }]
  } as unknown as TmuxSnapshot;
}

function store(): PaneMetadataStore {
  const db = new Database(":memory:");
  initializePanesSchema(db);
  return new PaneMetadataStore(db);
}

test("a monitor registered right after a rename takes the new name, not the snapshot's old one", () => {
  const metadata = store();
  metadata.upsert({ paneId: "%112", sessionName: "md-project-1", windowName: "pr_56", name: "Codex PR56" });
  expect(currentPaneName(snapshot("Previous task"), metadata, "md-project-1:pr_56", "%112")).toBe("Codex PR56");
});

test("a pane the store has no name for has none, whatever the snapshot still says", () => {
  expect(currentPaneName(snapshot("Previous task"), store(), "md-project-1:pr_56", "%112")).toBe(null);
});

test("a name kept for another window is not this pane's", () => {
  const metadata = store();
  metadata.upsert({ paneId: "%112", sessionName: "md-project-1", windowName: "other", name: "Old window's pane" });
  expect(currentPaneName(snapshot(null), metadata, "md-project-1:pr_56", "%112")).toBe(null);
});

test("a pane the snapshot does not hold has no name", () => {
  const metadata = store();
  metadata.upsert({ paneId: "%7", name: "Elsewhere" });
  expect(currentPaneName(snapshot(null), metadata, "md-project-1:pr_56", "%7")).toBe(null);
  expect(currentPaneName(null, metadata, "md-project-1:pr_56", "%112")).toBe(null);
});

function pane(overrides: Partial<RawTmuxPane>): RawTmuxPane {
  return {
    sessionName: "md-test",
    windowId: "@1",
    paneId: "%1",
    windowIndex: 1,
    windowName: "feat1",
    paneIndex: 0,
    paneActive: true,
    windowActive: true,
    currentPath: "/tmp",
    currentCommand: "zsh",
    paneTitle: "",
    panePid: 1,
    paneTty: "/dev/ttys001",
    paneWidth: 80,
    paneHeight: 24,
    captureHash: "hash",
    changedAt: "now",
    preview: "",
    processes: [],
    foregroundProcesses: [],
    ...overrides
  };
}

function state(panes: RawTmuxPane[]): RawTmuxState {
  return {
    sessions: [],
    windows: [],
    panes,
    clients: []
  };
}

test("PaneMetadataStore enriches matching raw panes and ignores stale window metadata", () => {
  const env = freshAgentEnv("md-pane-store-");
  const store = new PaneMetadataStore(env.store.db);
  const metadata = store.upsert({
    paneId: "%1",
    featureId: "f1",
    sessionName: "md-test",
    windowName: "feat1",
    name: "Codex",
    description: "Interactive design discussion"
  });

  const enriched = store.enrichRawState(state([
    pane({ paneId: "%1", windowName: "feat1" }),
    pane({ paneId: "%1", windowName: "other" })
  ]));

  expect(enriched.panes[0].metadata).toEqual({
    name: "Codex",
    description: "Interactive design discussion",
    updatedAt: metadata.updatedAt
  });
  expect(enriched.panes[1].metadata).toBeUndefined();
});
