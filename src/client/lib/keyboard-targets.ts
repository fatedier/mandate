function isTerminalKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.classList.contains("xterm-helper-textarea") ||
    target.closest(".xterm") !== null;
}

export function shouldIgnoreGlobalEscape(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  if (hasOpenKeyboardOverlay()) return true;
  if (isTerminalKeyboardTarget(event.target)) return true;

  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (path.some((target) => isTerminalKeyboardTarget(target))) return true;

  return isTerminalKeyboardTarget(document.activeElement);
}

/** Overlays own Escape before workspace zoom or page navigation. This also
 *  covers Canvas, whose modal can be open while focus is still in the page. */
export function hasOpenKeyboardOverlay(): boolean {
  return document.querySelector(
    '[role="dialog"]:not([hidden]):not([data-state="closed"]), ' +
    '[role="alertdialog"]:not([hidden]):not([data-state="closed"]), ' +
    '[role="menu"][data-state="open"], [role="listbox"][data-state="open"]'
  ) !== null;
}
