import type { match as pinyinProMatch } from "pinyin-pro";

/** The indexes of the characters of `text` that `letters` spells as pinyin
 *  (full, initials, or mixed; any reading of a character with more than
 *  one), or null. Passed in: the page loads the library only once an @ is
 *  typed, the server has it at once. */
export type PinyinMatch = (text: string, letters: string) => number[] | null;

/** pinyin-pro's `match` as the page and the server both call it: ü typed
 *  as v, as input methods take it ("guolv" for 过滤). */
export function pinyinMatcher(match: typeof pinyinProMatch): PinyinMatch {
  return (text, letters) => match(text, letters, { v: true }) ?? null;
}

/** How a title answers what was typed after @: by holding it (rank 0) or by
 *  its pinyin (rank 1), and which of its characters answered. */
export interface TitleHit {
  rank: 0 | 1;
  marks: number[];
}

/** What an input method puts between syllables while it composes. */
const SEPARATORS = /['\s]+/g;
const HAS_CHINESE = /\p{Script=Han}/u;

/** Whether `title` answers `query` (what follows the @), and how. A title
 *  holding the query, in any case, answers first; a Chinese title also
 *  answers the query read as pinyin, without the input method's separators.
 *  An empty query: every title, nothing marked. */
export function titleHit(title: string, query: string, pinyin: PinyinMatch | null): TitleHit | null {
  if (query === "") return { rank: 0, marks: [] };
  const at = title.toLowerCase().indexOf(query.toLowerCase());
  if (at >= 0) return { rank: 0, marks: Array.from({ length: query.length }, (_, i) => at + i) };
  if (!pinyin || !HAS_CHINESE.test(title)) return null;
  const letters = query.replace(SEPARATORS, "").toLowerCase();
  if (!/^[a-z0-9]*[a-z][a-z0-9]*$/.test(letters)) return null;
  const marks = pinyin(title, letters);
  return marks ? { rank: 1, marks } : null;
}
