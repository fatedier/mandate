interface PillSnapInput {
  pointerX: number;
  pointerY: number;
  pillHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  safeAreaInsets: { top: number; right: number; bottom: number; left: number };
  /** Margin in px between the pill and the viewport edge (and safe-area). */
  margin: number;
}

interface PillSnapResult {
  side: "left" | "right";
  /** Top-edge y position in px, already clamped so the pill stays on-screen
   *  with the requested margin + safe-area applied on top + bottom. */
  topPx: number;
}

/** Pure: given a pointer release position and pill geometry, decide which
 *  vertical edge the pill should snap to and a clamped top-px value. */
export function computePillSnap(input: PillSnapInput): PillSnapResult {
  const side: "left" | "right" =
    input.pointerX < input.viewportWidth / 2 ? "left" : "right";
  const minTop = input.safeAreaInsets.top + input.margin;
  const rawMaxTop =
    input.viewportHeight - input.pillHeight - input.safeAreaInsets.bottom - input.margin;
  // When the pill plus safe-area + margins exceeds the viewport, rawMaxTop falls
  // below minTop. Pin it so the pill anchors at the top safe-area instead of
  // silently overflowing the bottom.
  const maxTop = Math.max(minTop, rawMaxTop);
  const desired = input.pointerY - input.pillHeight / 2;
  const topPx = Math.max(minTop, Math.min(maxTop, desired));
  return { side, topPx };
}
