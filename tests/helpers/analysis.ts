import { Analyzer } from "../../src/server/modules/analysis/analyzer.js";
import type { PaneProcessInfo, RawTmuxPane, TmuxSnapshotPane } from "../../src/server/platform/tmux/tmux-types.js";

type AnalysedPane = Partial<RawTmuxPane> & Pick<RawTmuxPane, "paneId" | "currentCommand"> & {
  /** The pane's foreground process command lines. */
  foreground?: string[];
};

/** Feeds `analyzer` one tmux window (session md-test, `windowIndex`) holding
 *  `panes` in order, as pane indexes 0..n, the way the poller does, so its
 *  cache answers for them. */
export function analyseWindow(analyzer: Analyzer, panes: AnalysedPane[], windowIndex = 1): void {
  const snapshotPanes = panes.map(({ foreground = [], ...fields }, paneIndex): TmuxSnapshotPane => {
    const pane: RawTmuxPane = {
      sessionName: "md-test", windowId: "@3", windowIndex, windowName: "feat1", paneIndex,
      paneActive: paneIndex === 0, windowActive: true, currentPath: "/tmp", paneTitle: "", panePid: 100,
      paneTty: "/dev/ttys002", paneWidth: 80, paneHeight: 24, captureHash: "",
      changedAt: "2026-05-01T00:00:00.000Z", preview: "", processes: [],
      foregroundProcesses: foreground.map((command, i): PaneProcessInfo => ({ pid: 300 + i, ppid: 100, state: "S", command })),
      ...fields
    };
    return { ...pane, analysis: analyzer.getPaneAnalysis(pane) };
  });
  analyzer.getWindowAnalysis({
    sessionName: "md-test", windowId: "@3", windowIndex, windowName: "feat1", windowActive: true,
    windowPanes: snapshotPanes.length, windowLayout: "", windowZoomed: false, aggregate: null, panes: snapshotPanes
  });
}
