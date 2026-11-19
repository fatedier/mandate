/** Where a tab carried along its row may go, and when the row scrolls under
 *  it: rects as the browser gives them (TabDrag reads them on every move,
 *  since the row scrolls while a tab is carried). */

/** The carried copy's `x` (its translation from where the tab was), kept
 *  over its own group's tabs and inside the row's window; with less room
 *  than the tab is wide, at the room's left. */
export function carriedX(x: number, at: {
  nodeLeft: number;
  width: number;
  groupLeft: number;
  groupRight: number;
  rowLeft: number;
  rowRight: number;
}): number {
  const lo = Math.max(at.groupLeft, at.rowLeft);
  const hi = Math.max(lo, Math.min(at.groupRight, at.rowRight) - at.width);
  return Math.min(hi - at.nodeLeft, Math.max(lo - at.nodeLeft, x));
}

/** How near the row's edge (a share of its width) the pointer brings the
 *  row scrolling: at a fifth, dnd-kit's own, a pointer resting on a tab to
 *  swap with scrolled it away. */
export const ROW_SCROLL_EDGE = 0.1;

/** Whether the row may scroll under a carried tab: near (or past) an edge,
 *  only while its group goes on past that edge. Elsewhere it does not
 *  scroll anyway. */
export function rowMayScroll(
  pointerX: number,
  row: { left: number; right: number },
  group: { left: number; right: number },
  edge = ROW_SCROLL_EDGE
): boolean {
  const near = (row.right - row.left) * edge;
  if (pointerX >= row.right - near) return group.right > row.right + 1;
  if (pointerX <= row.left + near) return group.left < row.left - 1;
  return true;
}

/** Where a carried tab drops: the slot of its group under the pointer (not
 *  the tab's middle: a wide tab held by its × over a short neighbour drops
 *  there), else the nearest one, so past an end of its group it is that end.
 *  Slots as laid out, not as they slide aside meanwhile; given the row's
 *  window, only what shows in it: past the row's edge, toward the header's
 *  controls, the drop is the last tab in sight, not one out of sight. */
export function dropTarget(
  pointerX: number,
  laid: ReadonlyArray<{ id: string; left: number; right: number }>,
  window?: { left: number; right: number }
): string | null {
  const slots = window
    ? laid.map((s) => ({ id: s.id, left: Math.max(s.left, window.left), right: Math.min(s.right, window.right) })).filter((s) => s.right > s.left)
    : laid;
  let best: { id: string; distance: number } | null = null;
  for (const slot of slots) {
    const distance = pointerX < slot.left ? slot.left - pointerX : pointerX > slot.right ? pointerX - slot.right : 0;
    if (!best || distance < best.distance) best = { id: slot.id, distance };
  }
  return best?.id ?? null;
}

/** How much of the carried copy to cut away on each side: what lies outside
 *  its group's room in the row (on a phone a group can show only a sliver
 *  at the row's edge). */
export function clipInsets(chip: { left: number; right: number }, room: { left: number; right: number }): { left: number; right: number } {
  return { left: Math.max(0, room.left - chip.left), right: Math.max(0, chip.right - room.right) };
}

/** The row's scroll while a tab of `group` is carried (content coordinates,
 *  `pad` the row's own padding): it may bring the rest of the group into
 *  view, but no further, and never back past where it was when the carry
 *  began. */
export function scrollRange(start: number, group: { left: number; right: number }, clientWidth: number, pad: number): { min: number; max: number } {
  return {
    min: Math.max(0, Math.min(start, group.left - pad)),
    max: Math.max(start, group.right + pad - clientWidth)
  };
}

/** The pointer's x in a mouse or touch event: a touch moving reads from its
 *  touches, one that ended from the touch that lifted. */
export function pointerXOf(event: {
  clientX?: number;
  touches?: { item(index: number): { clientX: number } | null };
  changedTouches?: { item(index: number): { clientX: number } | null };
}): number | null {
  if (typeof event.clientX === "number") return event.clientX;
  return event.touches?.item(0)?.clientX ?? event.changedTouches?.item(0)?.clientX ?? null;
}
