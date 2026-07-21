import { useEffect, useState } from "react";

export interface VisualViewportInfo {
  /** Pixels between the bottom of the visual viewport and the bottom of the
   *  layout viewport — i.e. how tall the soft keyboard is. 0 when no
   *  keyboard / API unavailable. */
  keyboardOffset: number;
  /** Best-effort soft keyboard height. Unlike keyboardOffset, this also
   *  detects browsers that shrink the layout viewport via
   *  interactive-widget=resizes-content, where the bottom gap is 0. */
  keyboardHeight: number;
  /** Current visual viewport height — use it as the bottom sheet's height
   *  while the keyboard is up so chat content fills the available area
   *  instead of getting clipped under the keyboard. */
  visualHeight: number | null;
}

// On mobile, opening the soft keyboard shrinks the visualViewport but does
// not (always) shrink the layout viewport — so a `position: fixed; bottom: 0`
// sheet keeps its original anchor and the input gets hidden behind the
// keyboard. We listen on visualViewport so the bottom sheet can:
//   - shift up so its bottom edge sits at the keyboard top
//   - resize so its height matches the visible area above the keyboard
export function useVisualViewport(): VisualViewportInfo {
  const [info, setInfo] = useState<VisualViewportInfo>({
    keyboardOffset: 0,
    keyboardHeight: 0,
    visualHeight: null
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
        keyboardHeight: Math.max(offset, visualShrink),
        visualHeight: vv.height
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
