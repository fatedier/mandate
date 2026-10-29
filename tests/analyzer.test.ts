import { expect, test } from "bun:test";
import {
  Analyzer,
  screenForAnalysis
} from "../src/server/modules/analysis/analyzer.js";
import { extractWindowFacts } from "../src/server/modules/analysis/analyzer-window-facts.js";
import { buildWindowHash } from "../src/server/modules/analysis/analyzer-snapshots.js";
import type { AnalyzerWindowSnapshot } from "../src/server/modules/analysis/analyzer-contracts.js";
import { analyseWindow } from "./helpers/analysis.js";
import type { PaneProcessInfo, RawTmuxPane, TmuxSnapshotPane, TmuxSnapshotWindow, WindowStatus } from "../src/server/platform/tmux/tmux-types.js";

let nextPid = 200;
function proc(command: string): PaneProcessInfo {
  return { pid: nextPid++, ppid: 100, state: "S", command };
}

const basePane: RawTmuxPane = {
  sessionName: "example-project",
  windowId: "@2",
  paneId: "%1",
  windowIndex: 2,
  windowName: "bin",
  paneIndex: 1,
  paneActive: true,
  windowActive: true,
  currentPath: "/Users/alice/example-project",
  currentCommand: "node",
  paneTitle: "",
  panePid: 100,
  paneTty: "/dev/ttys001",
  paneWidth: 80,
  paneHeight: 24,
  captureHash: "",
  changedAt: "2026-05-01T00:00:00.000Z",
  preview: "",
  processes: [],
  foregroundProcesses: [proc("node /Users/alice/.nvm/versions/node/v22.22.0/bin/codex")]
};

test("screenForAnalysis separates dim Codex suggestions from semantic text", () => {
  const screen = [
    "  Sample build completed successfully.",
    "",
    "\x1B[48;2;75;75;75m",
    "\x1B[1m›\x1B[0m\x1B[48;2;75;75;75m \x1B[2mFind and fix a bug in @filename\x1B[0m\x1B[48;2;75;75;75m",
    "",
    "\x1B[2m\x1B[49m  gpt-5.5 xhigh · new · Context 47% used\x1B[0m"
  ].join("\n");

  const result = screenForAnalysis(screen);

  expect(result.semanticText).toContain("Sample build completed successfully.");
  expect(result.semanticText).not.toMatch(/Find and fix a bug/);
  expect(result.agentUiChrome.suggestions).toEqual(["Find and fix a bug in @filename"]);
  expect(result.agentUiChrome.promptVisible).toBe(true);
  expect(result.agentUiChrome.footers.length).toBe(1);
});

test("screenForAnalysis keeps progress chrome as semantic text (activity is measured, not parsed)", () => {
  const result = screenForAnalysis(
    ["• Working (1m 11s · esc to interrupt)", "", "› /goal @bin/goal.md"].join("\n")
  );

  // The retired progress-verb vocabulary is gone: chrome lines stay in the
  // semantic text and "is it active" comes from changedAt recency instead.
  expect(result.semanticText).toContain("Working (1m 11s");
});

test("screenForAnalysis keeps non-dim chevron output as semantic text", () => {
  const result = screenForAnalysis("build output\n› real terminal output\nplain footer");

  expect(result.semanticText).toMatch(/› real terminal output/);
  expect(result.agentUiChrome.promptVisible).toBe(false);
  expect(result.agentUiChrome.suggestions).toEqual([]);
});

test("local fallback does not infer pane status when AI is disabled", () => {
  const analyzer = new Analyzer();
  const analysis = analyzer.getPaneAnalysis({
    ...basePane,
    capture:
      "The sample output is ready for review.\n\n› Summarize recent commits\n\ngpt-5.5 xhigh · main · Context 68% used",
    captureHash: "codex-node-prompt",
    currentCommand: "node",
    preview: "",
    styledCapture: "",
    foregroundProcesses: [
      proc("node /Users/alice/.nvm/versions/node/v22.22.0/bin/codex"),
      proc("/Users/alice/.nvm/versions/node/v22.22.0/lib/node_modules/@openai/codex/vendor/codex/codex")
    ],
    processes: []
  });

  expect(analysis.status).toBe("unknown");
});

const FAINT = "\x1b[2m";
const RESET = "\x1b[0m";

/** A window in the shape the snapshot hands the analyzer: a codex pane
 *  mid-task (composer visible, output still changing) beside a plain shell. */
function workingWindow(): TmuxSnapshotWindow {
  const analysis = new Analyzer().getPaneAnalysis(basePane);
  const agent: TmuxSnapshotPane = {
    ...basePane,
    paneId: "%7",
    paneIndex: 0,
    currentCommand: "codex",
    changedAt: new Date(Date.now() - 2000).toISOString(),
    foregroundProcesses: [proc("codex")],
    styledCapture: [
      "• Waiting for background terminal (2m 14s • esc to interrupt) · 1 background terminal running",
      "",
      `${FAINT}› Use /skills to list available skills${RESET}`,
      ""
    ].join("\n"),
    analysis
  };
  const shell: TmuxSnapshotPane = {
    ...basePane,
    paneId: "%8",
    paneIndex: 1,
    paneActive: false,
    currentCommand: "zsh",
    changedAt: "2026-05-01T00:00:00.000Z",
    foregroundProcesses: [proc("-zsh")],
    capture: "alice@host example-project % ",
    analysis
  };
  return {
    sessionName: "example-project",
    windowId: "@2",
    windowIndex: 2,
    windowName: "bin",
    windowActive: true,
    windowPanes: 2,
    windowLayout: "",
    windowZoomed: false,
    panes: [agent, shell],
    aggregate: null
  };
}

test("the window analysis gives each pane the status its own facts decide", () => {
  const analysis = new Analyzer().getWindowAnalysis(workingWindow());
  expect(analysis.status).toBe("working");
  const byPane = Object.fromEntries(analysis.panes.map((pane) => [pane.paneId, pane.status]));
  expect(byPane).toEqual({ "%7": "working", "%8": "idle_shell" });
});

test("getCachedAnalysis answers for a pane of an analysed window, with when its output last changed", () => {
  const analyzer = new Analyzer();
  const window = workingWindow();
  analyzer.getWindowAnalysis(window);
  expect(analyzer.getCachedAnalysis("%7")).toMatchObject({ paneId: "%7", status: "working", changedAt: window.panes[0]!.changedAt });
  expect(analyzer.getCachedAnalysis("%8")?.status).toBe("idle_shell");
  expect(analyzer.getCachedAnalysis("%404")).toBe(null);
});

test("getCachedAnalysis reads the window a pane is in now, and its latest changedAt, when that window's analysis came from the cache", () => {
  const analyzer = new Analyzer();
  const shell = (capture: string, changedAt: string) => ({ paneId: "%1", currentCommand: "zsh", foreground: ["-zsh"], capture, changedAt });
  analyseWindow(analyzer, [shell("host % ", "2026-05-01T00:00:00.000Z")], 0);
  analyseWindow(analyzer, [shell("Do you want to proceed? [y/N] ", "2026-05-02T00:00:00.000Z")], 7);
  // Moved back to index 0 with its first screen: the same hash, so the
  // window's analysis is the cached one.
  analyseWindow(analyzer, [shell("host % ", "2026-05-03T00:00:00.000Z")], 0);
  expect(analyzer.getCachedAnalysis("%1")).toMatchObject({ status: "idle_shell", changedAt: "2026-05-03T00:00:00.000Z" });
});

// A codex pane mid-task with its composer visible: the timer chrome redraws
// every second, so changedAt stays fresh while it works and freezes when it
// stops. The verb wording is deliberately one the old vocabulary never knew.
function codexPane(overrides: { changedAt: string; capture?: string }): AnalyzerWindowSnapshot["panes"][number] {
  return {
    paneId: "%9",
    paneIndex: 0,
    sessionName: "md-project-2",
    windowIndex: 1,
    windowName: "cache_expiry",
    currentPath: "/work/project-2",
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
    windowKey: "md-project-2:cache_expiry",
    sessionName: "md-project-2",
    windowIndex: 1,
    windowName: "cache_expiry",
    windowActive: true,
    windowPanes: 1,
    windowLayout: "",
    windowZoomed: false,
    panes: [pane]
  } as AnalyzerWindowSnapshot;
}

// agoMs is how long ago the output last changed; the time is computed when
// the row runs, not when the table is built.
const composerCases: { name: string; agoMs: number; capture?: string; status: WindowStatus }[] = [
  { name: "agent with visible composer and fresh output classifies as working", agoMs: 2000, status: "working" },
  { name: "agent with visible composer and frozen output classifies as done", agoMs: 5 * 60_000, status: "done" },
  { name: "an approval prompt outranks output recency", agoMs: 2000,
    capture: "This command requires approval\nDo you want to proceed?", status: "waiting_user" }
];

test.each(composerCases)("$name", ({ agoMs, capture, status }) => {
  const facts = extractWindowFacts(
    windowWith(codexPane({ changedAt: new Date(Date.now() - agoMs).toISOString(), capture }))
  );
  expect(facts.deterministicStatus).toBe(status);
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
