import { expect, test } from "bun:test";
import { PaneMetadataStore } from "../src/server/modules/panes/pane-metadata-store.js";
import type { RawTmuxPane, RawTmuxState } from "../src/server/platform/tmux/tmux-types.js";
import { freshAgentEnv } from "./helpers/fixtures.js";

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
  try {
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
  } finally {
    env.cleanup();
  }
});
