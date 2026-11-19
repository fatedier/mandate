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

const OVERLAYS =
  '[role="dialog"]:not([hidden]):not([data-state="closed"]), ' +
  '[role="alertdialog"]:not([hidden]):not([data-state="closed"]), ' +
  '[role="menu"][data-state="open"], [role="listbox"][data-state="open"]';

/** Overlays own Escape before workspace zoom or page navigation. This also
 *  covers Canvas, whose modal can be open while focus is still in the page. */
export function hasOpenKeyboardOverlay(): boolean {
  return [...document.querySelectorAll(OVERLAYS)].some((overlay) => !hiddenWithItsPage(overlay));
}

/** The first element a selector finds that is not hidden with its page. */
export function shownMatch(selector: string): Element | null {
  return [...document.querySelectorAll(selector)].find((el) => !hiddenWithItsPage(el)) ?? null;
}

/** In a page kept while another shows (shell/KeptPage): React hides what
 *  that page drew, its portals too, with an inline display none. A dialog
 *  left open there, or the page's side pane, is not on screen. */
export function hiddenWithItsPage(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === "none") return true;
  }
  return false;
}
