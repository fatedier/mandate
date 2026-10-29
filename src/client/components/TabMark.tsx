import { useLayoutEffect, useRef } from "react";

/** The tab a row has chosen: a real tab panel's, or a view switcher's. */
const CHOSEN = '[role="tab"][aria-selected="true"], [aria-current="page"]';

/**
 * The fill under a row's chosen tab: one for the row, sliding to the tab
 * chosen next (220 ms on the house curve) instead of one tab's fill going
 * out as another's comes in. It is there at once the first time, and moves
 * at once when the chosen tab moves for any other reason (a tab before it
 * closing or coming, a name changing, a font loading); asked for less
 * motion, it always moves at once. With no tab
 * chosen it is not shown. Its row is positioned (it lies in the row's
 * scroll) and so are the tabs, which draw over it. `selected` names the tab
 * chosen, for knowing when to move.
 */
export function TabMark({ selected }: { selected: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shownOnce = useRef(false);
  const placedFor = useRef<string | null>(null);
  // After every drawing of the row: a tab before the chosen one may have
  // closed, come or changed its name. It slides only to a tab chosen anew.
  useLayoutEffect(() => {
    const mark = ref.current;
    const row = mark?.parentElement;
    if (!mark || !row) return;
    const place = (slide: boolean) => {
      const tab = row.querySelector<HTMLElement>(CHOSEN);
      if (!tab) {
        mark.style.visibility = "hidden";
        return;
      }
      const width = `${tab.offsetWidth}px`;
      const height = `${tab.offsetHeight}px`;
      const transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop}px)`;
      // Where it already is: left alone, so a slide not yet painted runs on.
      if (mark.style.visibility === "" && mark.style.width === width && mark.style.height === height && mark.style.transform === transform) return;
      mark.style.transitionDuration = slide ? "" : "0s";
      mark.style.visibility = "";
      mark.style.width = width;
      mark.style.height = height;
      mark.style.transform = transform;
      shownOnce.current = true;
    };
    place(shownOnce.current && placedFor.current !== selected);
    placedFor.current = selected;
    // A size changing with nothing drawn anew (a font loading): the row, and
    // every tab in it, as one before the chosen one moves it too.
    const resized = new ResizeObserver(() => place(false));
    resized.observe(row);
    for (const tab of row.querySelectorAll('[role="tab"], button, a')) resized.observe(tab);
    return () => resized.disconnect();
  });
  return (
    <span
      ref={ref}
      aria-hidden
      data-slot="tab-mark"
      className="pointer-events-none absolute left-0 top-0 rounded-sm bg-sel transition-[transform,width,height] duration-220 ease-(--ease-ui) motion-reduce:transition-none"
    />
  );
}
