import { toString } from "mdast-util-to-string";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkCanvasPaths } from "@/lib/remark-canvas-paths";
import { canvasPathOf } from "@/lib/canvas-link";
import { CELL_JOIN, LEAF_BLOCKS, type MdNode } from "@shared/markdown-text";

// The words alone are read the same way on the server (a notice's line).
export { markdownToText } from "@shared/markdown-text";

/** A stretch of a line's words, and where it links when it is a link. */
export interface TextRun {
  text: string;
  href?: string;
}

// As MarkdownView reads what an agent wrote: a canvas's path bare in the
// text is a link too.
const agentParser = unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly).use(remarkCanvasPaths);

type MdLeaf = MdNode & { value?: string; url?: string; identifier?: string };

/** markdownToText's words, with its links kept as links: the same text,
 *  split where a link (or a canvas's path, bare or as code) begins and ends. */
export function markdownToRuns(markdown: string): TextRun[] {
  const tree = agentParser.runSync(agentParser.parse(markdown)) as MdLeaf;
  // A link written by reference (`[words][p]`) points where its definition says.
  const definitions = new Map<string, string>();
  const define = (node: MdLeaf) => {
    if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) define(child);
  };
  define(tree);
  const blocks: TextRun[][] = [];
  const inline = (node: MdLeaf, into: TextRun[]) => {
    // A line the writer broke, as markdownToText keeps it.
    if (node.type === "break") {
      into.push({ text: "\n" });
      return;
    }
    const url = node.type === "link" ? node.url : node.type === "linkReference" && node.identifier ? definitions.get(node.identifier) : undefined;
    if (url) {
      into.push({ text: toString(node), href: url });
      return;
    }
    // A canvas's path written as code is its link too, as the chat draws it.
    const path = node.type === "inlineCode" && node.value ? canvasPathOf(node.value, window.location.href) : null;
    if (path) {
      into.push({ text: node.value!, href: path });
      return;
    }
    if (node.children) for (const child of node.children) inline(child, into);
    else into.push({ text: toString(node) });
  };
  const read = (node: MdLeaf) => {
    if (LEAF_BLOCKS.has(node.type)) {
      // A block that holds no inline children (code, HTML) is its text, as
      // markdownToText reads it.
      if (!node.children) {
        const text = toString(node);
        if (text.trim()) blocks.push([{ text: node.type === "code" ? text : text.trim() }]);
        return;
      }
      const runs: TextRun[] = [];
      if (node.type === "tableRow") {
        // Its cells on one line, the empty ones left out, as markdownToText joins them.
        for (const cell of node.children ?? []) {
          const cellRuns: TextRun[] = [];
          for (const child of cell.children ?? []) inline(child, cellRuns);
          const said = trimRuns(cellRuns);
          if (said.length === 0) continue;
          if (runs.length > 0) runs.push({ text: CELL_JOIN });
          runs.push(...said);
        }
      } else {
        for (const child of node.children ?? []) inline(child, runs);
      }
      const trimmed = trimRuns(runs);
      if (trimmed.length > 0) blocks.push(trimmed);
      return;
    }
    for (const child of node.children ?? []) read(child);
  };
  read(tree);
  return blocks.flatMap((runs, index) => (index === 0 ? runs : [{ text: "\n" }, ...runs]));
}

/** The runs with the block's leading and trailing blanks gone, as
 *  markdownToText trims each block; neighbouring words joined. */
function trimRuns(runs: TextRun[]): TextRun[] {
  const joined: TextRun[] = [];
  for (const run of runs) {
    const last = joined[joined.length - 1];
    if (last && !last.href && !run.href) last.text += run.text;
    else joined.push({ ...run });
  }
  while (joined.length > 0 && !joined[0]!.href && !joined[0]!.text.trim()) joined.shift();
  while (joined.length > 0 && !joined[joined.length - 1]!.href && !joined[joined.length - 1]!.text.trim()) joined.pop();
  if (joined[0] && !joined[0].href) joined[0].text = joined[0].text.trimStart();
  const end = joined[joined.length - 1];
  if (end && !end.href) end.text = end.text.trimEnd();
  return joined;
}
