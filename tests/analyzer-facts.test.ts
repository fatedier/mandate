import { expect, test } from "bun:test";
import { extractWindowFacts } from "../src/server/modules/analysis/analyzer-window-facts.js";
import { buildWindowHash } from "../src/server/modules/analysis/analyzer-snapshots.js";
import type { AnalyzerWindowSnapshot } from "../src/server/modules/analysis/analyzer-contracts.js";

const FAINT = "\x1b[2m";
const RESET = "\x1b[0m";

// A codex pane mid-task with its composer visible: the timer chrome redraws
// every second, so changedAt stays fresh while it works and freezes when it
// stops. The verb wording is deliberately one the old vocabulary never knew.
function codexPane(overrides: { changedAt: string; capture?: string }): AnalyzerWindowSnapshot["panes"][number] {
  return {
    paneId: "%9",
    paneIndex: 0,
    sessionName: "md-yamux",
    windowIndex: 1,
    windowName: "stream_reset",
    currentPath: "/work/yamux",
    currentCommand: "codex",
    paneActive: true,
    paneWidth: 120,
    paneHeight: 40,
    changedAt: overrides.changedAt,
    captureHash: "h1",
    preview: "",
    processes: [],
    foregroundProcesses: [{ pid: 100, ppid: 1, command: "codex", state: "S+" }],
    capture: "",
    styledCapture:
      overrides.capture ??
      [
        "• Waiting for background terminal (2m 14s • esc to interrupt) · 1 background terminal running",
        "",
        `${FAINT}› Use /skills to list available skills${RESET}`,
        ""
      ].join("\n")
  } as AnalyzerWindowSnapshot["panes"][number];
}

function windowWith(pane: AnalyzerWindowSnapshot["panes"][number]): AnalyzerWindowSnapshot {
  return {
    windowId: "@1",
    windowKey: "md-yamux:stream_reset",
    sessionName: "md-yamux",
    windowIndex: 1,
    windowName: "stream_reset",
    windowActive: true,
    windowPanes: 1,
    windowLayout: "",
    windowZoomed: false,
    panes: [pane]
  } as AnalyzerWindowSnapshot;
}

test("agent with visible composer and fresh output classifies as working", () => {
  const facts = extractWindowFacts(
    windowWith(codexPane({ changedAt: new Date(Date.now() - 2000).toISOString() }))
  );
  expect(facts.deterministicStatus).toBe("working");
});

test("agent with visible composer and frozen output classifies as done", () => {
  const facts = extractWindowFacts(
    windowWith(codexPane({ changedAt: new Date(Date.now() - 5 * 60_000).toISOString() }))
  );
  expect(facts.deterministicStatus).toBe("done");
});

test("an approval prompt outranks output recency", () => {
  const facts = extractWindowFacts(
    windowWith(
      codexPane({
        changedAt: new Date(Date.now() - 2000).toISOString(),
        capture: "This command requires approval\nDo you want to proceed?"
      })
    )
  );
  expect(facts.deterministicStatus).toBe("waiting_user");
});

test("window hash flips when output recency crosses the threshold, even with identical content", () => {
  const fresh = buildWindowHash(
    windowWith(codexPane({ changedAt: new Date(Date.now() - 2000).toISOString() }))
  );
  const stale = buildWindowHash(
    windowWith(codexPane({ changedAt: new Date(Date.now() - 5 * 60_000).toISOString() }))
  );
  expect(fresh).not.toBe(stale);
});
