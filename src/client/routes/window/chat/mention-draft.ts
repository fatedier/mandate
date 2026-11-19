/** Characters an `@` may follow and still be part of a word (an email's
 *  `me@x.com`, `v2@beta`): there it opens nothing. */
const WORD_CHAR = /[A-Za-z0-9]/;

/** The `@` the caret is typing after, and what follows it up to the caret:
 *  null when the caret is not in one. An `@` counts at the draft's start or
 *  after any character that is not an ASCII letter or digit, so Chinese
 *  typed without a space opens it. The query holds no whitespace, except in
 *  the letters an input method is composing (from `composingFrom` on), which
 *  puts spaces between the syllables it shows ("fa bu"). A space typed
 *  before it began ends the query as ever: a mention already written is not
 *  asked again by the words composed after it. */
export function mentionQueryAt(text: string, caret: number, composingFrom: number | null = null): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  // What was typed before the input method began; all of it when none composes.
  const typed = composingFrom === null ? query : query.slice(0, Math.max(0, composingFrom - start - 1));
  // A space right after the @ is no query, composed or not.
  if (/\s/.test(typed) || /^\s/.test(query)) return null;
  if (start > 0 && WORD_CHAR.test(before[start - 1]!)) return null;
  return { start, query };
}
