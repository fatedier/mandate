import type { Link, Parent, Root, RootContent, Text } from "mdast";
import type { VFile } from "vfile";

/** Punctuation and spaces outside ASCII (Chinese and Japanese punctuation,
 *  full-width forms, curly quotes, dashes, the ideographic space), by their
 *  Unicode class: none is part of an address an agent writes bare, and each
 *  can stand right after one with no space. Letters, kana and marks such as
 *  `々` are not: an address may hold them. */
const WIDE_PUNCTUATION = /[\p{P}\p{Zs}]/u;

/** What GFM drops from the end of a bare address (with `(`, which no address
 *  ends on, and an unmatched `)`). The address that ran on into Chinese text
 *  after one of these ended there. */
const ENDING_PUNCTUATION = /[?!.,:;*_~()]/;
const DROPPED_AT_END = /[?!.,:;*_~(]/;

/** Where a bare address ends in what GFM took for it, which runs to the next
 *  space or `<`: at the first Chinese punctuation mark, or at other non-ASCII
 *  text when the character before it is punctuation that would have ended the
 *  address (`…/models,匿名`). Non-ASCII text after a `/` or a letter stays: an
 *  address may hold it (`…/wiki/中文`). Punctuation it would end on is
 *  dropped, as GFM drops it. */
export function bareAddressEnd(text: string): number {
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch.charCodeAt(0) > 0x7f && WIDE_PUNCTUATION.test(ch)) { end = i; break; }
    if (ch.charCodeAt(0) > 0x7f && i > 0 && ENDING_PUNCTUATION.test(text[i - 1]!)) { end = i; break; }
  }
  if (end === text.length) return end;
  for (;;) {
    const last = text[end - 1];
    if (last === undefined) return end;
    const kept = text.slice(0, end);
    const unmatched = last === ")" && kept.split(")").length > kept.split("(").length;
    if (!DROPPED_AT_END.test(last) && !unmatched) return end;
    end--;
  }
}

/**
 * A bare address in CJK text, as GFM reads it, runs on through the
 * punctuation and words after it (`https://x/a。然后` linked to "a。然后"):
 * GFM ends one only at a space. Cut where the address ends, the rest back
 * into the text. Only bare addresses: one written as a link (`[…](…)`,
 * `<…>`) is the writer's, all of it.
 */
export function remarkAutolinkEnds() {
  return (tree: Root, file: VFile) => {
    const source = String(file.value ?? "");
    walk(tree, source);
  };
}

function walk(parent: Parent, source: string): void {
  for (let i = 0; i < parent.children.length; i++) {
    const node = parent.children[i]!;
    if (node.type === "link") {
      const rest = cut(node, source);
      if (rest) parent.children.splice(i + 1, 0, rest);
      continue;
    }
    if ("children" in node) walk(node as Parent, source);
  }
}

/** Shortens a bare address's link; what it gave up, as text. */
function cut(link: Link, source: string): Text | null {
  const only = link.children.length === 1 ? link.children[0] : undefined;
  if (only?.type !== "text") return null;
  const words = only.value;
  // Bare: its words are its address (`www.` gains a scheme), and the source
  // has no `[` or `<` where it starts.
  const prefix = link.url === words ? "" : link.url === `http://${words}` ? "http://" : null;
  if (prefix === null || !/^(https?:\/\/|www\.)/i.test(words)) return null;
  const start = link.position?.start.offset;
  if (start === undefined || source[start] === "[" || source[start] === "<") return null;
  const end = bareAddressEnd(words);
  if (end === words.length || end === 0) return null;
  only.value = words.slice(0, end);
  link.url = prefix + only.value;
  return { type: "text", value: words.slice(end) } satisfies RootContent;
}
