/** A monospace digit at the diff's `text-xs` (13px); see DiffHunkView. */
const CHAR_PX = 7.83;
/** The file list beside a diff (`w-60`) and the gap after it (`gap-4`). */
const LIST_PX = 240 + 16;
/** The least a diff beside the list is worth: about 65 columns unified. Any
 *  narrower and the list-then-file drill-in shows more code than the two side
 *  by side — the worker panel at a 1440 half split left the diff 322px. */
const DIFF_BESIDE_LIST_MIN_PX = 560;
/** Split halves the diff, each half with a 40px gutter and 16px of padding. It
 *  earns its place only when each half holds 80 columns; below that the same
 *  lines wrap mid-word (at 1440 each half held 60, and most lines wrapped). */
const SPLIT_MIN_DIFF_PX = 2 * (40 + 16 + 80 * CHAR_PX);
/** How far past a threshold the width must go to leave the layout it chose,
 *  more than a classic scrollbar (15-17px). The layout changes the tab's
 *  height, and a vertical scrollbar that comes and goes with it changes the
 *  width: without a margin a tab just past a threshold switched every frame. */
const SETTLE_PX = 24;

export interface ChangesLayout {
  /** The list alone, then one file across the whole tab (the phone's layout). */
  drillIn: boolean;
  /** The two sides of a change next to each other rather than one column. */
  split: boolean;
}

/** How the Changes tab lays out at its own `width`, given the layout it had
 *  (`previous`), which it keeps until the width is `SETTLE_PX` past the
 *  threshold. Unmeasured (0: no layout yet, or hidden) it follows the device,
 *  unified. */
export function changesLayout(width: number, isMobile: boolean, previous: ChangesLayout | null = null): ChangesLayout {
  if (width <= 0) return { drillIn: isMobile, split: false };
  const drillBelow = LIST_PX + DIFF_BESIDE_LIST_MIN_PX + (previous?.drillIn ? SETTLE_PX : 0);
  const drillIn = width < drillBelow;
  const splitFrom = SPLIT_MIN_DIFF_PX - (previous?.split ? SETTLE_PX : 0);
  return { drillIn, split: !drillIn && width - LIST_PX >= splitFrom };
}
