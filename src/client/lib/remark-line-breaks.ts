import type { Root } from "mdast";
import { findAndReplace } from "mdast-util-find-and-replace";

/**
 * Each line break in the text drawn as one, as it was typed (a task's
 * comments), where Markdown would join the lines. Text only: code keeps its
 * own lines.
 */
export function remarkLineBreaks() {
  return (tree: Root) => {
    findAndReplace(tree, [/\r?\n|\r/g, () => ({ type: "break" })]);
  };
}
