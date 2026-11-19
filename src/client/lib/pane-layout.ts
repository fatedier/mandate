/** The side pane's bounds (a thread page's worker panel). */
export const SIDE_PANEL_WIDTH_MIN = 320;
const SIDE_PANEL_WIDTH_DEFAULT = 480;
/** Below this a thread's row shows one side at a time: an even split would
 *  leave each side under 360px. */
export const SPLIT_ROW_MIN_WIDTH = 720;

/** Keep both panes usable on small desktops, while allowing an equal split
 *  beyond the old 900px limit on wide screens. */
export function getSidePanelWidth(availableWidth: number, ratio: number): number {
  if (availableWidth <= 0) return SIDE_PANEL_WIDTH_DEFAULT;
  const minimum = Math.min(SIDE_PANEL_WIDTH_MIN, availableWidth / 2);
  const desired = availableWidth * ratio;
  return Math.max(minimum, Math.min(availableWidth - minimum, desired));
}
