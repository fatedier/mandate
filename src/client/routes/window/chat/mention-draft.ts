/** Characters an `@` may follow and still be part of a word (an email's
 *  `me@x.com`, `v2@beta`): there it opens nothing. */
const WORD_CHAR = /[A-Za-z0-9]/;

/** The `@` the caret is typing after, and what follows it up to the caret:
 *  null when the caret is not in one. An `@` counts at the draft's start or
 *  after any character that is not an ASCII letter or digit, so Chinese
 *  typed without a space opens it; the query holds no whitespace. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  if (/\s/.test(query)) return null;
  if (start > 0 && WORD_CHAR.test(before[start - 1]!)) return null;
  return { start, query };
}
