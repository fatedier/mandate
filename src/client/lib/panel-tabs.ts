/** A canvas's tab in a right panel (a thread's, Your agent's), beside the
 *  workers' tabs (a feature id, or `archived:` and one). */
export const CANVAS_TAB = "canvas:";

export function canvasTabId(canvasId: string): string {
  return `${CANVAS_TAB}${canvasId}`;
}

/** The canvas a tab shows, or null for any other tab. */
export function canvasIdOfTab(tabId: string): string | null {
  return tabId.startsWith(CANVAS_TAB) && tabId.length > CANVAS_TAB.length ? tabId.slice(CANVAS_TAB.length) : null;
}
