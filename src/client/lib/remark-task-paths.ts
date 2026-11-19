import type { Link, Root } from "mdast";
import { findAndReplace, type RegExpMatchObject } from "mdast-util-find-and-replace";

/** A task's path as the personal agent writes it: its id is `tsk_` and eleven
 *  letters, digits, `-` or `_` (newId), nothing of the kind after it. */
export const TASK_PATH = /\/tasks\/tsk_[A-Za-z0-9_-]{11}(?![A-Za-z0-9_-])/g;
const TASK_PATH_WHOLE = /^\/tasks\/(tsk_[A-Za-z0-9_-]{11})$/;

/** What may stand right before a path that is part of something longer. */
const PART_OF_SOMETHING_BEFORE = /[A-Za-z0-9_/.~-]/;

/** The task a link's address names, or null. */
export function taskIdOfPath(href: string | undefined): string | null {
  return typeof href === "string" ? TASK_PATH_WHOLE.exec(href)?.[1] ?? null : null;
}

/**
 * A task's path written bare in an agent's text made the link to that task,
 * as remarkCanvasPaths does for canvases: text only, never code or a link's
 * words, and not a path that runs on into something longer.
 */
export function remarkTaskPaths() {
  return (tree: Root) => {
    findAndReplace(tree, [TASK_PATH, linkPath], { ignore: ["link", "linkReference"] });
  };
}

function linkPath(path: string, match: RegExpMatchObject): Link | false {
  const before = match.input.charAt(match.index - 1);
  const after = match.input.slice(match.index + path.length, match.index + path.length + 2);
  if (before && PART_OF_SOMETHING_BEFORE.test(before)) return false;
  if (after.startsWith("/") || /^\.[A-Za-z0-9]/.test(after)) return false;
  return { type: "link", url: path, title: null, children: [{ type: "text", value: path }] };
}
