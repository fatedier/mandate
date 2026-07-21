import { tailLines } from "../text/text.js";
import { tmuxWindowKey } from "./tmux-state.js";
import type {
  AnalyzerLike,
  TmuxSnapshotPane,
  TmuxSnapshotSession,
  TmuxSnapshotWindow,
  RawTmuxState,
  TmuxCaptureOptions,
  WindowAnalysis,
  WindowStatus
} from "./tmux-types.js";

export function buildTmuxSnapshot(
  rawState: RawTmuxState,
  analyzer: AnalyzerLike,
  options: Pick<TmuxCaptureOptions, "monitorWindowKeys"> = {}
) {
  const monitorWindowKeys = options.monitorWindowKeys instanceof Set ? options.monitorWindowKeys : null;
  const sessionsByName = new Map<string, TmuxSnapshotSession>();
  const windowsById = new Map<string, TmuxSnapshotWindow>();

  for (const session of rawState.sessions) {
    sessionsByName.set(sessionKey(session), {
      ...session,
      activeClient: rawState.clients.find((client) =>
        client.sessionName === session.sessionName
      ) ?? null,
      windows: []
    });
  }

  for (const window of rawState.windows) {
    if (monitorWindowKeys && !monitorWindowKeys.has(tmuxWindowKey(window))) {
      continue;
    }
    const snapshotWindow: TmuxSnapshotWindow = {
      ...window,
      panes: [],
      aggregate: null
    };
    windowsById.set(window.windowId, snapshotWindow);
    const session = sessionsByName.get(sessionKey(window));
    if (session) {
      session.windows.push(snapshotWindow);
    }
  }

  for (const pane of rawState.panes) {
    const snapshotPane: TmuxSnapshotPane = {
      ...pane,
      analysis: analyzer.getPaneAnalysis(pane)
    };
    const window = windowsById.get(pane.windowId);
    if (window) {
      window.panes.push(snapshotPane);
    }
  }

  for (const window of windowsById.values()) {
    window.panes.sort((a, b) => a.paneIndex - b.paneIndex);
    const analysis = analyzer.getWindowAnalysis(window);
    window.analysis = analysis;
    applyWindowPaneAnalyses(window, analysis);
    window.aggregate = aggregateWindow(window, analysis);
    stripPaneCaptures(window);
  }

  const sessions = Array.from(sessionsByName.values()).sort((a, b) => (
    a.sessionName.localeCompare(b.sessionName)
  ));
  for (const session of sessions) {
    session.windows.sort((a, b) => a.windowIndex - b.windowIndex);
  }

  return {
    generatedAt: new Date().toISOString(),
    sessions,
    clients: rawState.clients,
    counts: countStatuses(sessions)
  };
}

function sessionKey(value: { sessionName: string }) {
  return value.sessionName;
}

function applyWindowPaneAnalyses(window: TmuxSnapshotWindow, analysis: WindowAnalysis) {
  const panes = Array.isArray(analysis?.panes) ? analysis.panes : [];
  const byPaneId = new Map(panes.filter((pane) => pane.paneId).map((pane) => [pane.paneId, pane]));
  const byPaneIndex = new Map(panes.filter((pane) => Number.isFinite(Number(pane.paneIndex))).map((pane) => [Number(pane.paneIndex), pane]));
  for (const pane of window.panes) {
    pane.analysis = byPaneId.get(pane.paneId) || byPaneIndex.get(pane.paneIndex) || pane.analysis;
  }
}

function stripPaneCaptures(window: TmuxSnapshotWindow) {
  for (const pane of window.panes) {
    pane.capture = undefined;
    pane.styledCapture = undefined;
  }
}

function aggregateWindow(window: TmuxSnapshotWindow, analysis: WindowAnalysis) {
  const activePane = window.panes.find((pane) => pane.paneActive) ?? window.panes[0] ?? null;
  const sourcePane = window.panes.find((pane) => (
    analysis?.primaryPaneId ? pane.paneId === analysis.primaryPaneId : false
  )) ?? window.panes.find((pane) => (
    Number.isFinite(Number(analysis?.primaryPaneIndex)) && pane.paneIndex === Number(analysis.primaryPaneIndex)
  )) ?? activePane;
  const status = analysis?.status ?? "unknown";

  return {
    status,
    paneId: sourcePane?.paneId ?? activePane?.paneId ?? "",
    paneIndex: sourcePane?.paneIndex ?? activePane?.paneIndex ?? 0,
    title: analysis?.taskTitle || `${window.sessionName}:${window.windowIndex}: ${window.windowName}`,
    summary: analysis?.summary || (activePane?.preview ? tailLines(activePane.preview, 5) : "") || "",
    suggestedAction: analysis?.suggestedAction || "",
    confidence: analysis?.confidence ?? 0,
    urgency: analysis?.urgency ?? "low",
    currentPath: sourcePane?.currentPath || activePane?.currentPath || "",
    currentCommand: sourcePane?.currentCommand || activePane?.currentCommand || "",
    pending: Boolean(analysis?.pending),
    stale: Boolean(analysis?.stale),
    analysisState: analysis?.analysisState || (analysis?.pending ? "stale" : "fresh"),
    nextAnalysisAt: analysis?.nextAnalysisAt || ""
  };
}

function countStatuses(sessions: TmuxSnapshotSession[]) {
  const counts = {
    totalWindows: 0,
    waiting_user: 0,
    done: 0,
    working: 0,
    running_service: 0,
    idle_shell: 0,
    unknown: 0
  };

  for (const session of sessions) {
    for (const window of session.windows) {
      counts.totalWindows += 1;
      const status: WindowStatus = window.aggregate?.status ?? "unknown";
      counts[status] = (counts[status] ?? 0) + 1;
    }
  }

  return counts;
}
