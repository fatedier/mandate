import { toString } from "mdast-util-to-string";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// The plugins the chat's Markdown renders with, so a line reads here as it
// renders there: what is bold in the chat is bold to this parser too.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly);

/** The blocks whose text is read whole; any other block is read through its
 *  children (a list, an item, a quote, a table). A table's row is one line. */
export const LEAF_BLOCKS: ReadonlySet<string> = new Set(["paragraph", "heading", "code", "html", "tableRow"]);

/** What stands between a table row's cells on its one line. */
export const CELL_JOIN = " · ";

export type MdNode = { type: string; children?: MdNode[] };

/** The words inside a block. A line the writer broke stays broken (read
 *  plainly, the break is dropped and the words either side run together). */
function wordsOf(node: MdNode): string {
  if (node.type === "break") return "\n";
  return node.children ? node.children.map(wordsOf).join("") : toString(node);
}

/** A leaf block's words: a table row's are its cells', the empty ones left out. */
function blockText(node: MdNode): string {
  if (node.type !== "tableRow") return wordsOf(node);
  return (node.children ?? []).map((cell) => wordsOf(cell).trim()).filter(Boolean).join(CELL_JOIN);
}

/** The words a piece of markdown says, with none of its marks: bold, code
 *  and links keep their text, a heading or a list item its line, and blocks
 *  a line break between them (a question and the list under it do not run
 *  together; on one line it reads as a space). Empty for markup that says
 *  nothing (a bare fence, a rule). */
export function markdownToText(markdown: string): string {
  const lines: string[] = [];
  const read = (node: MdNode) => {
    if (LEAF_BLOCKS.has(node.type)) {
      const text = blockText(node);
      // A code block as written: its indentation is its meaning.
      if (text.trim()) lines.push(node.type === "code" ? text : text.trim());
      return;
    }
    for (const child of node.children ?? []) read(child);
  };
  read(parser.parse(markdown) as MdNode);
  return lines.join("\n");
}
