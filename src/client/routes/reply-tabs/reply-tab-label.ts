import { markdownToText } from "@/lib/markdown-text";

/** The longest name a reply tab takes: it is also the tab's tooltip and its
 *  Close button's label, where a paragraph would be read out whole. */
const MAX_NAME = 80;

/** A reply tab's name: the reply's first line, without its marks, as the chat
 *  shows it, cut at 80 characters; "Reply" for one that says nothing in words. */
export function replyTabLabel(text: string): string {
  const first = markdownToText(text).split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!first) return "Reply";
  return first.length > MAX_NAME ? `${cutBetweenCharacters(first, MAX_NAME - 1).trimEnd()}…` : first;
}

const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** At most `max` UTF-16 units of `text`, ending on a whole character as
 *  people see one: an emoji, or a letter with its accent, is never split. */
function cutBetweenCharacters(text: string, max: number): string {
  let cut = "";
  for (const { segment } of characters.segment(text)) {
    if (cut.length + segment.length > max) break;
    cut += segment;
  }
  return cut;
}
