import { tmuxWindowKey } from "./tmux-state.js";
import type {
  AnalyzerLike,
  PaneAnalysis,
  RawTmuxPane,
  RawTmuxWindow,
  TmuxSnapshotPane,
  TmuxSnapshotSession,
  TmuxSnapshotWindow,
  RawTmuxState,
  TmuxCaptureOptions
} from "./tmux-types.js";

export function buildTmuxSnapshot(
  rawState: RawTmuxState,
  analyzer: AnalyzerLike,
  options: Pick<TmuxCaptureOptions, "monitorWindowKeys"> = {}
) {
  const monitorWindowKeys = options.monitorWindowKeys instanceof Set ? options.monitorWindowKeys : null;
  const sessionsByName = new Map<string, TmuxSnapshotSession>();
  const windowsById = new Map<string, { window: RawTmuxWindow; panes: RawTmuxPane[] }>();

  for (const session of rawState.sessions) {
    sessionsByName.set(session.sessionName, { ...session, windows: [] });
  }

  for (const window of rawState.windows) {
    if (monitorWindowKeys && !monitorWindowKeys.has(tmuxWindowKey(window))) {
      continue;
    }
    windowsById.set(window.windowId, { window, panes: [] });
  }

  for (const pane of rawState.panes) {
    windowsById.get(pane.windowId)?.panes.push(pane);
  }

  for (const { window, panes } of windowsById.values()) {
    panes.sort((a, b) => a.paneIndex - b.paneIndex);
    const analysis = analyzer.getWindowAnalysis({ ...window, panes });
    const byPaneId = new Map(analysis.panes.map((pane) => [pane.paneId, pane]));
    const snapshotWindow: TmuxSnapshotWindow = {
      ...window,
      panes: panes.map((pane) => snapshotPane(pane, byPaneId.get(pane.paneId))),
      aggregate: { status: analysis.status, title: analysis.taskTitle }
    };
    sessionsByName.get(window.sessionName)?.windows.push(snapshotWindow);
  }

  const sessions = Array.from(sessionsByName.values()).sort((a, b) => (
    a.sessionName.localeCompare(b.sessionName)
  ));
  for (const session of sessions) {
    session.windows.sort((a, b) => a.windowIndex - b.windowIndex);
  }

  return {
    generatedAt: new Date().toISOString(),
    sessions
  };
}

/** A pane as the snapshot sends it: its analysis, and no captured screen.
 *  Every pane the window held is in its analysis; a missing one reads as
 *  unknown rather than failing the poll. */
function snapshotPane(pane: RawTmuxPane, analysis: PaneAnalysis | undefined): TmuxSnapshotPane {
  return {
    ...pane,
    capture: undefined,
    styledCapture: undefined,
    analysis: analysis ?? {
      paneId: pane.paneId,
      paneIndex: pane.paneIndex,
      status: "unknown",
      confidence: 0,
      taskTitle: "",
      summary: ""
    }
  };
}
