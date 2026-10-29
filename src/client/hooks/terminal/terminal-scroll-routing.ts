/**
 * Where a scroll gesture over the terminal goes: a wheel on a desktop, a
 * finger drag on a phone, the same rules for both.
 *
 * - "history": the terminal's own scrollback, when there is one to scroll
 *   and the program has not asked for the mouse.
 * - "xterm": xterm's own wheel handling, which is what every terminal does:
 *   wheel reports in the program's mouse protocol when it asked for them,
 *   and Up/Down arrows in the alternate screen when it did not.
 * - "wheel-report": SGR wheel reports sent to a program that reads them
 *   without asking, in the alternate screen, where xterm would send arrows.
 *   Codex is that program: in tmux with the mouse off it does not ask for
 *   the mouse, takes an Up arrow as its previous prompt, and scrolls its
 *   fullscreen transcript on wheel reports (measured on 0.158).
 */
type ScrollRoute = "history" | "xterm" | "wheel-report";

/** xterm's mouse modes. X10 reports button presses only, never the wheel,
 *  so it scrolls as if the program had not asked for the mouse. */
type MouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";

export function reportsWheel(mode: MouseTrackingMode): boolean {
  return mode === "vt200" || mode === "drag" || mode === "any";
}

export function scrollRoute(state: { alternate: boolean; mouseTracking: MouseTrackingMode; readsWheel: boolean }): ScrollRoute {
  if (reportsWheel(state.mouseTracking)) return "xterm";
  if (!state.alternate) return "history";
  return state.readsWheel ? "wheel-report" : "xterm";
}

/** Programs that read wheel reports without asking for the mouse, by the
 *  pane's foreground command: Codex as its own binary, as npm's launcher
 *  script (`codex.js`), and as the native binary that script starts, named
 *  by its target (`codex-aarch64-apple-darwin`). */
const READS_UNREQUESTED_WHEEL = /^codex(?:\.[cm]?js|-(?:aarch64|x86_64)-[a-z0-9_-]+)?$/;

export function readsUnrequestedWheel(command: string | undefined): boolean {
  return command !== undefined && READS_UNREQUESTED_WHEEL.test(command);
}

/** A wheel report in SGR encoding: button 64 up, 65 down, at a 1-based cell. */
export function sgrWheelReport(direction: -1 | 1, col: number, row: number): string {
  return `\x1b[<${direction < 0 ? 64 : 65};${col};${row}M`;
}

/** Lines of travel into whole steps of `linesPerStep`, the rest kept for the
 *  next move: a trackpad's many small deltas add up instead of each one
 *  rounding to nothing or to a whole step. A change of `destination` starts
 *  over, so what was left for one program never lands on another. */
export function createWheelStepper(linesPerStep: number) {
  let remainder = 0;
  let lastDestination: string | undefined;
  return {
    add(lines: number, destination?: string): number {
      if (destination !== lastDestination) remainder = 0;
      lastDestination = destination;
      remainder += lines;
      const steps = Math.trunc(remainder / linesPerStep) || 0;
      remainder -= steps * linesPerStep;
      return steps;
    },
    reset() {
      remainder = 0;
    }
  };
}

/** Takes only the answer to the latest of overlapping lookups: an older one
 *  that answers last (for a program that has since exited) is dropped. */
export function createLatestLookup<T>(apply: (value: T) => void) {
  let latest = 0;
  return (lookup: Promise<T | null>) => {
    const mine = ++latest;
    void lookup
      .then((value) => {
        if (mine === latest && value !== null) apply(value);
      })
      .catch(() => {});
  };
}

/**
 * Which program is in the pane, from two sources: the snapshot (or a pane
 * page's periodic re-read), which can be seconds behind, and a live read
 * taken when a program takes the whole screen. For as long as that screen
 * lasts the live read wins; leaving it goes back to the snapshot and drops
 * any live answer still on its way.
 */
export function createProgramTracker() {
  let snapshot: string | undefined;
  let live: string | null = null;
  const lookUp = createLatestLookup<string>((program) => {
    live = program;
  });
  return {
    setSnapshot(program: string | undefined) {
      snapshot = program;
    },
    enterAlternate(lookup: Promise<string | null>) {
      live = null;
      lookUp(lookup);
    },
    leaveAlternate() {
      live = null;
      lookUp(Promise.resolve(null));
    },
    readsWheel(): boolean {
      return readsUnrequestedWheel(live ?? snapshot);
    }
  };
}
