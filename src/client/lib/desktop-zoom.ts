/** Interface zoom for the desktop shell: the browser ladder, stepped by
 *  ⌘+ / ⌘− / ⌘0 (and the app's View menu), remembered per machine in the UI
 *  store. Default 100% on every display — never guessed from the screen: a
 *  laptop that docks to a 27" panel and undocks again would otherwise change
 *  size on its own. The browser build leaves zoom to the browser. */

export const ZOOM_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const ZOOM_DEFAULT = 1;
export const ZOOM_MIN = ZOOM_STEPS[0]!;
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

export type ZoomDirection = "in" | "out" | "reset";

/** The ladder step nearest to `factor` (a hand-edited store or an old value
 *  between steps snaps rather than sticking between two shortcuts). */
export function snapZoom(factor: number): number {
  if (!Number.isFinite(factor)) return ZOOM_DEFAULT;
  let best = ZOOM_DEFAULT;
  let distance = Infinity;
  for (const step of ZOOM_STEPS) {
    const d = Math.abs(step - factor);
    if (d < distance) {
      distance = d;
      best = step;
    }
  }
  return best;
}

export function nextZoom(current: number, direction: ZoomDirection): number {
  if (direction === "reset") return ZOOM_DEFAULT;
  const snapped = snapZoom(current);
  const index = ZOOM_STEPS.indexOf(snapped);
  const next = direction === "in" ? index + 1 : index - 1;
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, next))]!;
}

export function formatZoom(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

/** Which zoom step a keydown asks for, or null. ⌘ on macOS (Ctrl elsewhere),
 *  no Alt: `+` or `=` in, `-` out, `0` reset. Shift is accepted so that ⌘+
 *  (Shift+=) counts as plus, like browsers. */
export function zoomShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): ZoomDirection | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  switch (event.key) {
    case "+":
    case "=":
      return "in";
    case "-":
    case "_":
      return "out";
    case "0":
      return "reset";
    default:
      return null;
  }
}

export type ZoomController = {
  /** One step. `source` is only for the dedupe: the native View menu and the
   *  webview's keydown can both report the same keypress, so a request
   *  arriving within `dedupeMs` of the last one from another source is
   *  dropped. Same-source repeats (holding ⌘+) go through. */
  step: (direction: ZoomDirection, source: "menu" | "keyboard" | "settings") => void;
};

export function createZoomController(opts: {
  get: () => number;
  set: (factor: number) => void;
  now?: () => number;
  dedupeMs?: number;
}): ZoomController {
  const now = opts.now ?? (() => Date.now());
  const dedupeMs = opts.dedupeMs ?? 150;
  let last: { at: number; source: string; direction: ZoomDirection } | null = null;
  return {
    step(direction, source) {
      const at = now();
      if (last && last.source !== source && last.direction === direction && at - last.at < dedupeMs) {
        last = { at, source, direction };
        return;
      }
      last = { at, source, direction };
      opts.set(nextZoom(opts.get(), direction));
    }
  };
}
