import { expect, test } from "bun:test";
import {
  Analyzer,
  screenForAnalysis
} from "../src/server/modules/analysis/analyzer.js";

const basePane = {
  paneId: "%1",
  paneIndex: 1,
  sessionName: "example-project",
  windowIndex: 2,
  windowName: "bin",
  currentCommand: "node",
  foregroundProcesses: [{ command: "node /Users/alice/.nvm/versions/node/v22.22.0/bin/codex" }]
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
      { command: "node /Users/alice/.nvm/versions/node/v22.22.0/bin/codex" },
      {
        command:
          "/Users/alice/.nvm/versions/node/v22.22.0/lib/node_modules/@openai/codex/vendor/codex/codex"
      }
    ],
    processes: []
  });

  expect(analysis.status).toBe("unknown");
  expect(analysis.pending).toBe(false);
});
