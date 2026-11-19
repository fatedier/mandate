/** A column's width where the pane has room for the whole board. */
export const COLUMN_ROOMY_PX = 220;
/** The narrowest a column is drawn: three of them fit half a laptop's window. */
export const COLUMN_MIN_PX = 170;
/** The gap between two columns. */
export const COLUMN_GAP_PX = 12;
/** How far from the pane's edge a column stepped into view stops: the width
 *  of the edge fade (.fade-x-edges). A desktop board's margin at each side. */
export const BOARD_INSET_PX = 24;

/** The board's own margin at each side: its page's gutter, narrower in
 *  phone mode. */
export function boardInset(phone: boolean): number {
  return phone ? 16 : BOARD_INSET_PX;
}

/** Whether the Board is among the views of a page `width` wide. A desktop
 *  always has it: what does not fit is a step away, and a task opens over
 *  it. In phone mode (one thing on the screen at a time) it is offered where
 *  three columns fit whole, a foldable's or a small tablet's width; a page
 *  not measured yet has no board. */
export function boardOffered(phone: boolean, width: number): boolean {
  return !phone || width >= 3 * COLUMN_MIN_PX + 2 * COLUMN_GAP_PX + 2 * boardInset(true);
}

/**
 * Which of a board's columns are folded away (drawn as their heading alone,
 * above the board), for a pane whose content is `width` wide.
 *
 * `fold` is what the owner said of a column by hand: true folds it, whatever
 * the room; false keeps it open, whatever the room; undefined leaves it to
 * the pane. Left to the pane, a status with no task folds away where the
 * pane is short of room, so the ones with tasks have the row: short of room
 * is when the columns not folded by hand would not all fit at their roomy
 * width (a pane not measured yet is not). Columns that would all fold this
 * way stay as they are. The columns left then narrow to their minimum, and
 * what still does not fit is off to the side.
 */
export function foldedColumns<T>(
  columns: readonly T[],
  width: number,
  is: { isEmpty: (column: T) => boolean; fold: (column: T) => boolean | undefined }
): Set<T> {
  const byHand = columns.filter((column) => is.fold(column) === true);
  const open = columns.filter((column) => is.fold(column) !== true);
  const roomy = open.length * COLUMN_ROOMY_PX + Math.max(0, open.length - 1) * COLUMN_GAP_PX;
  if (width <= 0 || width >= roomy) return new Set(byHand);
  const empty = open.filter((column) => is.fold(column) === undefined && is.isEmpty(column));
  return new Set(empty.length === open.length ? byHand : [...byHand, ...empty]);
}

/** Where a board scrolled to `left` goes for one step: so the nearest column
 *  cut off on that side comes into view whole, `inset` from the pane's edge.
 *  Null when no column is cut off there. */
export function stepTo(
  side: "left" | "right",
  pane: { left: number; width: number; inset: number },
  columns: ReadonlyArray<{ left: number; width: number }>
): number | null {
  if (side === "right") {
    const edge = pane.left + pane.width - pane.inset;
    const cut = columns.find((column) => column.left + column.width > edge + 1);
    return cut ? cut.left + cut.width - pane.width + pane.inset : null;
  }
  const edge = pane.left + pane.inset;
  const cut = [...columns].reverse().find((column) => column.left < edge - 1);
  return cut ? cut.left - pane.inset : null;
}
