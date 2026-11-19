/** The transcript scroller's decisions, as plain numbers in and out: whether
 *  the view follows new content, when older messages are asked for, and
 *  where scrollTop goes when they land. The hook that reads the scroller and
 *  writes it is useTranscriptViewport. */

/** One reading of the scroller: scrollTop, scrollHeight and clientHeight. */
export interface ScrollBox {
  top: number;
  height: number;
  client: number;
}

/** Within this of the end, the reader is at it, and the view follows again. */
export const AT_END_PX = 2;
/** The reader's own scroll up farther than this from the end stops following. */
export const DETACH_PX = 24;

export function distanceFromEnd(box: ScrollBox): number {
  return box.height - box.top - box.client;
}

/** Whether the scroller moved up by more than the layout explains, however
 *  little: content that got shorter or a view that got taller only pull
 *  scrollTop back to the new largest value, and a rubber band past the end
 *  (WebKit) recovers by itself, so the earlier reading is taken as at most
 *  its own end. Within AT_END_PX of the end is at it, never up. */
export function movedUpByReader(before: ScrollBox, now: ScrollBox): boolean {
  if (distanceFromEnd(now) <= AT_END_PX) return false;
  const start = Math.min(before.top, before.height - before.client);
  const pulled = Math.min(start, now.height - now.client);
  return pulled - now.top > 0;
}

/** Whether the view follows new content after a scroll event, by what the
 *  reader did rather than how far from the end they are: a
 *  distance alone read a resize that grew the content by more than it as the
 *  reader leaving, and a reader just short of the end as following.
 *
 *  Only a scroll up stops it: scrollTop smaller while the content did not
 *  shrink and the view did not grow (those clamp scrollTop by themselves).
 *  Reaching the end resumes it, from wherever. Anything else keeps it. */
export function followAfterScroll(following: boolean, before: ScrollBox | null, now: ScrollBox): boolean {
  const distance = distanceFromEnd(now);
  if (distance <= AT_END_PX) return true;
  if (!following) return false;
  const scrolledUp = before !== null && now.top < before.top && now.height >= before.height && now.client <= before.client;
  return !(scrolledUp && distance > DETACH_PX);
}

/** Whether older messages are asked for now: there are more, none is on its
 *  way, the last did not fail, every loaded row is drawn, and the reader is
 *  within a screen of the top or the content does not fill the view. A view
 *  with no height (a hidden pane) measures nothing. */
export function shouldLoadOlder(
  box: ScrollBox,
  state: { hasMore: boolean; failed: boolean; loading: boolean; windowed: boolean }
): boolean {
  if (!state.hasMore || state.failed || state.loading || state.windowed) return false;
  if (box.client === 0) return false;
  return box.top < box.client || box.height <= box.client;
}

/** Where scrollTop goes once older rows have landed above the reader: on by
 *  as far as the row they were on moved down in the content (`anchorTop` is
 *  its top in content coordinates), so it stays where it was on screen. With
 *  no row to measure, on by how much the content grew. */
export function scrollTopAfterPrepend(
  before: { top: number; height: number; anchorTop: number | null },
  after: { height: number; anchorTop: number | null }
): number {
  const moved = before.anchorTop !== null && after.anchorTop !== null
    ? after.anchorTop - before.anchorTop
    : after.height - before.height;
  return before.top + moved;
}
