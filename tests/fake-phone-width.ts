/** Narrows the window to a phone width. happy-dom's window is 1024px wide, so
 *  `useIsMobile()` — a `(max-width: 767px)` media query read through
 *  `window.matchMedia` — is false by default and every mobile branch is dead
 *  code in tests. Must run before mount: useMediaQuery reads matchMedia once in
 *  a useState initializer.
 *
 *  Captures the descriptor rather than fabricating one. Restoring with a
 *  `{ value }` descriptor would permanently convert `innerWidth` from an
 *  accessor into a static data property for the rest of the test process, and
 *  the damage would surface in some unrelated file as a frozen window width. */
export function fakePhoneWidth(width = 390): () => void {
  const win = globalThis.window as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(win, "innerWidth");
  Object.defineProperty(win, "innerWidth", { value: width, configurable: true });
  return () => {
    if (previous) Object.defineProperty(win, "innerWidth", previous);
    else delete win.innerWidth;
  };
}
