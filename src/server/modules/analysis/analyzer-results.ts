import type {
  PaneAnalysis,
  RawTmuxPane,
  WindowAnalysis
} from "../../platform/tmux/tmux-types.js";
import {
  type AnalyzerPaneSnapshot,
  type AnalyzerWindowSnapshot
} from "./analyzer-contracts.js";
import { limitText } from "./analyzer-utils.js";
import { extractWindowFacts, type AnalyzerWindowFacts } from "./analyzer-window-facts.js";

/** A window's status from local heuristics (process inspection and screen
 *  content), with each pane's own: what the pane dot and pane monitors read. */
export function analyzeWindow(window: AnalyzerWindowSnapshot): WindowAnalysis {
  const facts = extractWindowFacts(window);
  return {
    status: facts.status || "unknown",
    taskTitle: limitText(`${window.sessionName}:${window.windowIndex}: ${window.windowName}`, 90),
    panes: facts.panes.map((fact) => paneAnalysisFromFacts(fact))
  };
}

/** A pane's analysis from the facts the window's status is drawn from: the
 *  status its own screen, processes and output recency decide, or unknown
 *  when none of the heuristics matched it. */
function paneAnalysisFromFacts(fact: AnalyzerWindowFacts["panes"][number]): PaneAnalysis {
  const base = unknownPaneAnalysis(fact.pane);
  return fact.localStatus ? { ...base, status: fact.localStatus, confidence: fact.localConfidence } : base;
}

/** A pane no heuristic speaks for: titled by its name or its window, and
 *  summarised by its command and directory. */
function unknownPaneAnalysis(pane: AnalyzerPaneSnapshot | RawTmuxPane): PaneAnalysis {
  const taskTitle = pane.metadata?.name
    || (pane.windowName
    ? `${pane.sessionName}:${pane.windowIndex}: ${pane.windowName}`
    : pane.currentCommand);
  const commandContext = [pane.currentCommand, pane.currentPath].filter(Boolean).join(" in ");
  return {
    paneId: pane.paneId,
    paneIndex: pane.paneIndex,
    status: "unknown",
    confidence: 0.1,
    taskTitle: limitText(taskTitle, 90),
    summary: limitText(commandContext || "No window analysis is available.", 260)
  };
}
