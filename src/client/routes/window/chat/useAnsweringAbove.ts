import { useEffect, useState, type RefObject } from "react";

/** How long a touch that sent no click (a scroll, a long press) keeps what
 *  was decided before it, once the finger is up. */
const TAP_WITHOUT_CLICK_MS = 600;

/** Whether a field above the composer is typed in (a question's answer):
 *  while a text field in `region` has the focus. On a phone the keyboard is
 *  up exactly then, and the composer steps aside (globals.css).
 *
 *  A tap keeps the answer as it is until
 *  the tap's click has run, wherever the focus goes meanwhile: Chrome focuses
 *  a tapped button as the finger lands, Safari blurs the field in the
 *  mousedown it sends after the finger is up. Then it is decided again: a
 *  Send that sent, a fold that took the field away, both leave no field
 *  with the focus. */
export function useAnsweringAbove(region: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [answering, setAnswering] = useState(false);
  useEffect(() => {
    if (!active) return;
    let tapping = false;
    let noClick: ReturnType<typeof setTimeout> | null = null;
    const typedIn = (node: EventTarget | null) =>
      (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && Boolean(region.current?.contains(node));
    const decide = () => setAnswering(typedIn(document.activeElement));
    const stopWaiting = () => {
      if (noClick) clearTimeout(noClick);
      noClick = null;
    };
    const tapDone = () => {
      if (!tapping) return;
      tapping = false;
      stopWaiting();
      // After the click's own handlers (a send, a fold) have run.
      requestAnimationFrame(decide);
    };
    const focusChanged = () => { if (!tapping) decide(); };
    const down = () => {
      tapping = true;
      stopWaiting();
    };
    const up = () => {
      if (!tapping) return;
      stopWaiting();
      noClick = setTimeout(tapDone, TAP_WITHOUT_CLICK_MS);
    };
    document.addEventListener("focusin", focusChanged);
    document.addEventListener("focusout", focusChanged);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("click", tapDone);
    return () => {
      stopWaiting();
      document.removeEventListener("focusin", focusChanged);
      document.removeEventListener("focusout", focusChanged);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("click", tapDone);
      // Nothing above the composer any more: nothing is typed in there.
      setAnswering(false);
    };
  }, [active, region]);
  return active && answering;
}
