import { useState, type ReactNode } from "react";
import type { DetailLayout } from "./blocks";

/** Past this many characters, or this many laid-out lines, a call's output
 *  is long. Lines count too: forty one-word items are short JSON and a tall
 *  list. */
export const INLINE_CAP_CHARS = 800;
export const INLINE_CAP_ROWS = 24;

/** Text is long past either limit: 200 one-character lines are short in
 *  characters and a tall block. */
export function isLongText(text: string): boolean {
  if (text.length > INLINE_CAP_CHARS) return true;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    lines += 1;
    if (lines > INLINE_CAP_ROWS) return true;
  }
  return false;
}

/** Long output in the transcript gets a box of its own that scrolls, so one
 *  opened call does not push the conversation screens away — but not in the
 *  phone's sheet, which scrolls as a whole: a box scrolling by itself there
 *  takes the drag meant for the sheet. Returns the class that caps the box
 *  (empty when it is not capped, or has been expanded) and the button that
 *  expands and collapses it (null when there is nothing to cap). */
export function useInlineCap(layout: DetailLayout, long: boolean): { boxClass: string; toggle: ReactNode } {
  const [showAll, setShowAll] = useState(false);
  const capped = layout === "inline" && long;
  return {
    boxClass: capped && !showAll ? "max-h-[min(28rem,55vh)] overflow-y-auto" : "",
    toggle: capped ? (
      <button
        type="button"
        onClick={() => setShowAll((v) => !v)}
        className="shrink-0 text-2xs text-chrome transition-colors hover:text-foreground"
      >
        {showAll ? "Collapse" : "Expand"}
      </button>
    ) : null
  };
}
