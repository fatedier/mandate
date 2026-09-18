import type { SessionDto } from "@shared/api-contracts";
import type { RecentPane } from "@/store/ui";
import { paneRowsFromSessionWindow, type PaneRowData } from "@/routes/sessions/PaneRowList";

export const SWITCHER_RECENT_MAX = 5;

export type SwitcherRecentRow = PaneRowData & { sessionName: string; windowName: string; at: string };
export interface SwitcherWindowGroup { windowName: string; index: number; active: boolean; panes: PaneRowData[] }
export interface SwitcherModel { recent: SwitcherRecentRow[]; windows: SwitcherWindowGroup[] }

/** Recent first (this device's history across every session, newest first,
 *  current pane excluded, entries whose pane no session has any more
 *  dropped), then every window of the current session in tmux order. A
 *  Recent row from another session carries that session's project name (or
 *  its tmux name) in its prefix so a cross-project switch reads as one.
 *  Pure: the sheet only renders it. */
export function buildSwitcherModel(input: {
  sessions: SessionDto[];
  sessionName: string;
  recent: RecentPane[];
  currentPaneId: string;
  changedAtById?: Record<string, string | undefined>;
  now?: number;
}): SwitcherModel {
  const { sessions, sessionName, recent, currentPaneId, changedAtById = {}, now = Date.now() } = input;
  const session = sessions.find((s) => s.name === sessionName) ?? null;
  if (!session) return { recent: [], windows: [] };
  const windows: SwitcherWindowGroup[] = [...session.windows]
    .sort((a, b) => a.index - b.index)
    .map((w) => ({ windowName: w.name, index: w.index, active: w.active, panes: paneRowsFromSessionWindow(w, changedAtById, now) }));
  const recentRows: SwitcherRecentRow[] = [];
  for (const entry of recent) {
    if (entry.paneId === currentPaneId) continue;
    if (recentRows.some((r) => r.paneId === entry.paneId)) continue;
    const hit = findPane(sessions, entry.sessionName, entry.paneId, changedAtById, now);
    if (!hit) continue;
    const sameSession = hit.session.name === sessionName;
    const owner = hit.session.projectName ?? hit.session.name;
    recentRows.push({
      ...hit.row,
      prefix: sameSession ? hit.windowName : `${owner} / ${hit.windowName}`,
      sessionName: hit.session.name,
      windowName: hit.windowName,
      at: entry.at
    });
    if (recentRows.length === SWITCHER_RECENT_MAX) break;
  }
  return { recent: recentRows, windows };
}

/** The pane's current row, looked up by session + pane id (the session named
 *  by the history entry; the window is re-derived, so a `join-pane` since
 *  then still resolves). */
function findPane(
  sessions: SessionDto[],
  sessionName: string,
  paneId: string,
  changedAtById: Record<string, string | undefined>,
  now: number
): { session: SessionDto; windowName: string; row: PaneRowData } | null {
  const session = sessions.find((s) => s.name === sessionName);
  if (!session) return null;
  for (const w of session.windows) {
    const row = paneRowsFromSessionWindow(w, changedAtById, now).find((r) => r.paneId === paneId);
    if (row) return { session, windowName: w.name, row };
  }
  return null;
}
