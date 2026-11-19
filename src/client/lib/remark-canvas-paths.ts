import type { Link, Root } from "mdast";
import { findAndReplace, type RegExpMatchObject } from "mdast-util-find-and-replace";

/** A canvas's path as the canvas tools return it: its id is `cnv_` and
 *  eleven letters, digits, `-` or `_` (newId), and nothing of the kind runs on
 *  after it. A path that names no canvas, such as a source file's
 *  (`modules/canvas/canvas-store.ts`), is not one. */
const CANVAS_PATH = /\/canvas\/cnv_[A-Za-z0-9_-]{11}(?![A-Za-z0-9_-])/g;

/** What may stand right before a path that is the path itself, not the end of
 *  something longer: a word (`docs/canvas/…`, `localhost:4175/canvas/…`), a
 *  path (`~/…`, `./…`, `x//…`). Other letters, such as Han, may: CJK text runs
 *  into the path without a space. */
const PART_OF_SOMETHING_BEFORE = /[A-Za-z0-9_/.~-]/;

/**
 * A canvas's path written bare in the text, as agents also write it, made the
 * link to that canvas, as if written `[/canvas/<id>](/canvas/<id>)`. Only text
 * is read: a path in code is left to the code's own rendering, and one in a
 * link's words stays its words. A path that runs on into something longer
 * (`/canvas/x/embed`, `/canvas/x.md`, `docs/canvas/x`) is not one.
 */
export function remarkCanvasPaths() {
  return (tree: Root) => {
    findAndReplace(tree, [CANVAS_PATH, linkPath], { ignore: ["link", "linkReference"] });
  };
}

function linkPath(path: string, match: RegExpMatchObject): Link | false {
  const before = match.input.charAt(match.index - 1);
  const after = match.input.slice(match.index + path.length, match.index + path.length + 2);
  if (before && PART_OF_SOMETHING_BEFORE.test(before)) return false;
  // A sentence may end on it ("see /canvas/x."); a file name or a deeper
  // path may not.
  if (after.startsWith("/") || /^\.[A-Za-z0-9]/.test(after)) return false;
  return { type: "link", url: path, title: null, children: [{ type: "text", value: path }] };
}
