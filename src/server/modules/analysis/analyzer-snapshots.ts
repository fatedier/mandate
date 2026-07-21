import { sha256 } from "../../platform/crypto/hash.js";
import { isRecentOutput } from "./analyzer-utils.js";
import { tailLines } from "../../platform/text/text.js";
import type { TmuxSnapshotWindow, RawTmuxPane } from "../../platform/tmux/tmux-types.js";
import type { AnalyzerPaneSnapshot, AnalyzerWindowSnapshot } from "./analyzer-contracts.js";

export function makeWindowSnapshot(window: TmuxSnapshotWindow): AnalyzerWindowSnapshot {
  return {
    windowId: window.windowId,
    windowKey: windowScopeId(window),
    sessionName: window.sessionName,
    windowIndex: window.windowIndex,
    windowName: window.windowName,
    windowActive: window.windowActive,
    windowPanes: window.windowPanes,
    windowLayout: window.windowLayout,
    windowZoomed: window.windowZoomed,
    panes: (window.panes || [])
      .map((pane) => makePaneSnapshot(pane))
      .sort((a, b) => a.paneIndex - b.paneIndex)
  };
}

function makePaneSnapshot(pane: RawTmuxPane): AnalyzerPaneSnapshot {
  return {
	    paneId: pane.paneId,
	    paneIndex: pane.paneIndex,
	    ...(pane.metadata ? { metadata: pane.metadata } : {}),
    sessionName: pane.sessionName,
    windowIndex: pane.windowIndex,
    windowName: pane.windowName,
    currentPath: pane.currentPath,
    currentCommand: pane.currentCommand,
    paneActive: pane.paneActive,
    paneWidth: pane.paneWidth,
    paneHeight: pane.paneHeight,
    changedAt: pane.changedAt,
    captureHash: pane.captureHash,
    preview: tailLines(pane.preview || pane.capture || "", 10),
    processes: pane.processes,
    foregroundProcesses: pane.foregroundProcesses,
    capture: tailLines(pane.capture ?? "", 140),
    styledCapture: tailLines(pane.styledCapture || "", 140)
  };
}

export function buildWindowHash(window: AnalyzerWindowSnapshot) {
  return sha256(JSON.stringify({
    windowId: window.windowId,
    windowKey: window.windowKey,
    windowName: window.windowName,
    windowLayout: window.windowLayout,
    windowZoomed: window.windowZoomed,
    panes: window.panes.map((pane) => ({
	      paneId: pane.paneId,
	      paneIndex: pane.paneIndex,
	      metadata: pane.metadata ?? null,
	      paneActive: pane.paneActive,
      currentPath: pane.currentPath,
      currentCommand: pane.currentCommand,
      // Classification depends on whether output is still moving, and that
      // decays with time even when content is frozen. Hashing the bucket
      // forces a re-analysis when a pane crosses the recency threshold —
      // without it, the cache would pin "working" forever after output stops.
      recentOutput: isRecentOutput(pane.changedAt),
      captureHash: pane.captureHash || sha256(`${pane.currentPath}\n${pane.currentCommand}\n${pane.capture}\n${pane.styledCapture}`)
    }))
  }));
}

function windowScopeId(window: Pick<AnalyzerWindowSnapshot | TmuxSnapshotWindow, "sessionName" | "windowIndex">) {
  return `${window.sessionName}:${window.windowIndex}`;
}
