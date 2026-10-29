import { toString } from "mdast-util-to-string";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// The plugins MarkdownView renders with, so a line reads here as it renders
// there: what is bold in the chat is bold to this parser too.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly);

/** The blocks whose text is read whole; any other block is read through its
 *  children (a list, an item, a quote, a table and its rows). */
const LEAF_BLOCKS = new Set(["paragraph", "heading", "code", "html", "tableCell"]);

type MdNode = { type: string; children?: MdNode[] };

/** The words a piece of markdown says, with none of its marks: bold, code
 *  and links keep their text, a heading or a list item its line, and blocks
 *  a line break between them (a question and the list under it do not run
 *  together; on one line it reads as a space). Empty for markup that says
 *  nothing (a bare fence, a rule). */
export function markdownToText(markdown: string): string {
  const lines: string[] = [];
  const read = (node: MdNode) => {
    if (LEAF_BLOCKS.has(node.type)) {
      const text = toString(node);
      // A code block as written: its indentation is its meaning.
      if (text.trim()) lines.push(node.type === "code" ? text : text.trim());
      return;
    }
    for (const child of node.children ?? []) read(child);
  };
  read(parser.parse(markdown) as MdNode);
  return lines.join("\n");
}
