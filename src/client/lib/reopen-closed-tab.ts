/** The panels in sight that can reopen a closed tab, the latest mounted last:
 *  the desktop app's Reopen Closed Tab (⌘⇧T) goes to it. A browser keeps
 *  that key for its own tabs, so only the desktop app asks. */
const handlers: Array<() => void> = [];

/** Registers a panel's "reopen my latest closed tab"; returns its removal. */
export function onReopenClosedTab(handler: () => void): () => void {
  handlers.push(handler);
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}

/** Reopens the latest closed tab of the panel in sight; nothing without one. */
export function reopenClosedTab(): void {
  handlers.at(-1)?.();
}
