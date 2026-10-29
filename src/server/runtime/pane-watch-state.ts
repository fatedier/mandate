import type { TmuxSnapshot } from "../platform/tmux/tmux-types.js";
import type { PaneMetadataStore } from "../modules/panes/pane-metadata-store.js";
import type { WindowWatchTargetState } from "../modules/agent/window-watch-manager.js";

// What a pane watch reads of the latest tmux snapshot: whether its pane is
// still there and when it last changed, and the pane's name.

export function currentPaneWatchState(
  snapshot: TmuxSnapshot | null,
  windowKey: string,
  paneId: string
): WindowWatchTargetState {
  if (!snapshot) return { status: "snapshot_unavailable" };
  const pane = findWatchedPane(snapshot, windowKey, paneId);
  return pane ? { status: "ok", changedAt: pane.changedAt || null } : { status: "not_found" };
}

/** The name set_pane_metadata gave the pane a watch names, for the watch to
 *  record when it registers. Read from the store, which the tool writes at
 *  once, and matched to the pane's window as the poller matches it; not from
 *  the snapshot's copy, which catches up only at the next poll, so a monitor
 *  registered right after a rename recorded the old name. The snapshot's copy
 *  only stands in where no store was given (tests). */
export function currentPaneName(
  snapshot: TmuxSnapshot | null,
  paneMetadata: Pick<PaneMetadataStore, "metadataForPane"> | undefined,
  windowKey: string,
  paneId: string
): string | null {
  const pane = snapshot ? findWatchedPane(snapshot, windowKey, paneId) : null;
  if (!pane) return null;
  const name = paneMetadata ? paneMetadata.metadataForPane(pane)?.name : pane.metadata?.name;
  return name?.trim() || null;
}

/** The pane a watch's window key and pane id name in a snapshot, or null. */
function findWatchedPane(snapshot: TmuxSnapshot, windowKey: string, paneId: string) {
  const parsed = parseWindowWatchKey(windowKey);
  if (!parsed) return null;
  const session = snapshot.sessions.find(
    (item) => item.sessionName === parsed.sessionName
  );
  if (!session) return null;
  const numericSelector = Number(parsed.selector);
  const window = session.windows.find(
    (item) =>
      item.windowName === parsed.selector ||
      (Number.isFinite(numericSelector) && item.windowIndex === Math.floor(numericSelector))
  );
  return window?.panes.find((p) => p.paneId === paneId) ?? null;
}

export function parseWindowWatchKey(
  windowKey: string
): { sessionName: string; selector: string } | null {
  const parts = windowKey.split(":");
  if (parts.length < 2) return null;
  const selector = parts.pop() ?? "";
  const sessionName = parts.join(":");
  return sessionName && selector ? { sessionName, selector } : null;
}
