import { useEffect, useState } from "react";

interface VisualViewportInfo {
  /** Pixels between the bottom of the visual viewport and the bottom of the
   *  layout viewport — i.e. how tall the soft keyboard is. 0 when no
   *  keyboard / API unavailable. */
  keyboardOffset: number;
  /** Best-effort soft keyboard height. Unlike keyboardOffset, this also
   *  detects browsers that shrink the layout viewport via
   *  interactive-widget=resizes-content, where the bottom gap is 0. */
  keyboardHeight: number;
}

// On mobile, opening the soft keyboard shrinks the visualViewport but does
// not (always) shrink the layout viewport — so something fixed to the bottom
// keeps its anchor and ends up behind the keyboard. Listening on
// visualViewport says how far the keyboard covers.
export function useVisualViewport(): VisualViewportInfo {
  const [info, setInfo] = useState<VisualViewportInfo>({
    keyboardOffset: 0,
    keyboardHeight: 0
  });

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let maxVisualHeight = vv.height;
    const update = () => {
      const offset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      maxVisualHeight = Math.max(maxVisualHeight, vv.height);
      const visualShrink = Math.max(0, Math.round(maxVisualHeight - vv.height));
      setInfo({
        keyboardOffset: offset,
        keyboardHeight: Math.max(offset, visualShrink)
      });
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return info;
}
