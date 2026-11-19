/** Characters of a long name that are never cut: its end carries the
 *  extension and suffixes like "_test" that tell a test from the code. */
const TAIL = 12;
/** Names up to this long are never cut in the middle (a 4-character head
 *  would be all ellipsis). */
const SPLIT_ABOVE = TAIL + 4;

/** Characters as a person sees them (grapheme clusters): an emoji, a letter
 *  with its combining mark, a ZWJ sequence each count as one, and a cut never
 *  falls inside one. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A changed file's row label: the name, as `head` (cut with an ellipsis when
 *  the row is narrow) and `tail` (never cut), then its directory. `base` is
 *  the whole name, for what a screen reader reads. */
export function splitFileName(path: string): { base: string; head: string; tail: string | null; dir: string | null } {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dir = slash === -1 ? null : path.slice(0, slash);
  const chars = Array.from(graphemes.segment(base), (s) => s.segment);
  if (chars.length <= SPLIT_ABOVE) return { base, head: base, tail: null, dir };
  return { base, head: chars.slice(0, -TAIL).join(""), tail: chars.slice(-TAIL).join(""), dir };
}
