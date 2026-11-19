/** The longest a captured pane is kept without being captured again,
 *  whatever tmux says: the bound on how late a change tmux does not report
 *  (none is known) can show, and when that is checked. */
export const PANE_REFRESH_MS = 60_000;

/** A second unexplained change within this long of the first is tmux not
 *  reporting changes; one alone can be a race (see noteRefreshChange). */
const UNEXPLAINED_WINDOW_MS = 10 * 60_000;

/** What a capture of a pane gave, kept for the polls that need not capture
 *  it. Not its processes: those are read on every poll (a child can end
 *  without output, and the analysis reads them). */
export interface HeldCapture {
  /** When the capture began. */
  startedAtMs: number;
  /** The poll that took it (beginPoll's count). */
  poll: number;
  /** Taken by a refresh that found an unexplained change: it may be the
   *  spoiled one, so a change found against it is not counted again. */
  suspect: boolean;
  /** The pane's own facts at the time (paneFacts): any change captures it again. */
  facts: string;
  capture: string;
  styledCapture: string;
  captureHash: string;
  preview: string;
}

/**
 * The poll's captures, kept between polls. tmux sets a window's activity time
 * on every chunk of output any of its panes receives (input.c,
 * input_parse_buffer → window_update_activity; also when the window is made
 * current), to the second in formats. A pane is captured again when its
 * window's activity is at or after the second its last capture began (the
 * same second counts: output later in it is not missed), when its own facts
 * changed (size, command, folder, process, history length: a resize reflows
 * without output, clear-history empties the history), when its window is
 * asked for, or when its last capture is PANE_REFRESH_MS old.
 *
 * A capture made only because the last one was old that finds the pane
 * changed, with tmux reporting no output since, is a change tmux did not
 * report; a second within UNEXPLAINED_WINDOW_MS, in a capture another poll
 * took, means it does not report them: from then on every pane is captured
 * on every poll, as before.
 */
export interface PaneCaptureCache {
  trustActivity: boolean;
  readonly panes: Map<string, HeldCapture>;
  /** The polls begun so far. */
  poll: number;
  /** The last unexplained change: when it was found, and the poll that took
   *  the capture it disagreed with. */
  unexplained: { at: number; poll: number } | null;
  now(): number;
}

export function createPaneCaptureCache(options: { now?: () => number } = {}): PaneCaptureCache {
  return { trustActivity: true, panes: new Map(), poll: 0, unexplained: null, now: options.now ?? Date.now };
}

/** A poll begins: the captures it takes are told apart from earlier ones'. */
export function beginPoll(cache: PaneCaptureCache): number {
  cache.poll += 1;
  return cache.poll;
}

/** Why a pane is captured on this poll, or null to keep what was captured. */
export type CaptureReason = "new" | "asked" | "untrusted" | "changed" | "activity" | "refresh";

export function captureReason(
  cache: PaneCaptureCache,
  paneId: string,
  facts: string,
  windowActivitySec: number | undefined,
  asked: boolean
): CaptureReason | null {
  const held = cache.panes.get(paneId);
  if (!held) return "new";
  if (asked) return "asked";
  if (!cache.trustActivity) return "untrusted";
  if (held.facts !== facts) return "changed";
  // A window whose activity cannot be read is captured, as before.
  if (windowActivitySec === undefined || !Number.isFinite(windowActivitySec)) return "untrusted";
  if (windowActivitySec >= Math.floor(held.startedAtMs / 1000)) return "activity";
  if (cache.now() - held.startedAtMs >= PANE_REFRESH_MS) return "refresh";
  return null;
}

/** What a pane's capture depends on besides output: its window (whose
 *  activity speaks for it; a pane moved keeps its own content), its size, its
 *  command, folder and process, its history length, and the capture's depth. */
export function paneFacts(
  pane: { windowId: string; paneWidth: number; paneHeight: number; currentCommand: string; currentPath: string; panePid: number },
  historySize: string | undefined,
  captureLines: number
): string {
  return [pane.windowId, pane.paneWidth, pane.paneHeight, pane.currentCommand, pane.currentPath, pane.panePid, historySize ?? "", captureLines].join("\u0000");
}

/** A pane as tmux reports it right after a capture: its window's activity
 *  and its facts. */
export interface PaneNow { activitySec: number; facts: string }

/** A refresh found the pane changed: told when tmux had reported no output
 *  since the capture before and the pane's facts are still the ones held —
 *  both read after this capture, so output, a resize or clear-history
 *  between the poll's list and the capture explain the change. A pane that
 *  could not be read judges nothing. One unexplained change is let pass: a
 *  capture can disagree with the facts held with it (a resize between the
 *  poll's list and the capture, undone before the next poll), and this
 *  capture replaces it. Such a race spoils captures one poll took, perhaps
 *  several panes' at once, or the refresh's own capture (the resize undone
 *  before the facts are read again): only a change in a capture another
 *  poll took counts as a second, and a change found against a capture taken
 *  by such a refresh (suspect) is not counted at all. Returns whether the
 *  new capture is suspect. */
export function noteRefreshChange(cache: PaneCaptureCache, held: HeldCapture, now: PaneNow | null): boolean {
  if (now === null || now.activitySec >= Math.floor(held.startedAtMs / 1000) || now.facts !== held.facts) return false;
  if (held.suspect) return false;
  if (!cache.trustActivity) return true;
  const at = cache.now();
  const last = cache.unexplained;
  if (last === null || at - last.at > UNEXPLAINED_WINDOW_MS) {
    cache.unexplained = { at, poll: held.poll };
    return true;
  }
  if (held.poll === last.poll) return true;
  cache.trustActivity = false;
  console.log("[mandate] tmux poll: a pane changed with no output reported by tmux; every pane is captured on every poll from now on");
  return true;
}
