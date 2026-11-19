import {
  INITIAL_FIT_NEARLY_STABLE_AFTER_MS,
  INITIAL_FIT_NEARLY_STABLE_ROWS,
  INITIAL_FIT_SETTLE_MAX_MS,
  INITIAL_FIT_STABLE_SAMPLES
} from "./tmux-runtime-constants.js";

/** The rows that differ between two captures of one screen (as
 *  capturePaneRows takes them, a line per row); null when they have
 *  different row counts (the pane still being resized). */
function changedRows(a: string, b: string): number[] | null {
  const before = a.split("\n");
  const after = b.split("\n");
  if (before.length !== after.length) return null;
  return before.flatMap((row, i) => (row === after[i] ? [] : [i]));
}

/**
 * Whether a pane's screen has settled after a fit resized its window, from
 * captures taken a sample apart: a full-screen program redraws for the new
 * size a moment later, and the first paint should show it redrawn.
 *
 * Settled: the last samples alike. From INITIAL_FIT_NEARLY_STABLE_AFTER_MS
 * on, also alike but for the same one or two rows: a working agent's spinner
 * or timer never leaves two samples alike, while a redraw changes many rows,
 * and one that starts in that first half second is waited for. At the latest,
 * whatever the screen, after INITIAL_FIT_SETTLE_MAX_MS.
 */
export class FitSettle {
  private readonly samples: string[] = [];

  /** With this sample, taken `elapsedMs` after the resize. One tmux did not
   *  answer starts over. */
  sample(capture: string | null, elapsedMs: number): boolean {
    if (capture === null) {
      this.samples.length = 0;
      return false;
    }
    this.samples.push(capture);
    if (this.samples.length > INITIAL_FIT_STABLE_SAMPLES) this.samples.shift();
    if (elapsedMs >= INITIAL_FIT_SETTLE_MAX_MS) return true;
    if (this.samples.length < INITIAL_FIT_STABLE_SAMPLES) return false;
    if (this.samples.every((s) => s === this.samples[0])) return true;
    if (elapsedMs < INITIAL_FIT_NEARLY_STABLE_AFTER_MS) return false;
    const changed = new Set<number>();
    for (let i = 1; i < this.samples.length; i++) {
      const rows = changedRows(this.samples[i - 1]!, this.samples[i]!);
      if (rows === null) return false;
      for (const row of rows) changed.add(row);
    }
    return changed.size <= INITIAL_FIT_NEARLY_STABLE_ROWS;
  }
}
