import { MENTION_LIMIT, type Mention } from "@shared/mentions";

/** A thread picked into the draft, and where its `@<label>` starts. */
export interface MentionPick {
  mention: Mention;
  start: number;
}

/** The picks after one edit took the box from `before` to `after` (typing,
 *  deleting, cutting, pasting, a pick): a pick whose words the edit touched
 *  is gone, one after the edit moves with the text, one before it stays.
 *  Typing right at a pick's edges leaves its words whole. Where the edit
 *  ended comes from `caret`: the end of what it wrote, where the caret
 *  landed (or the end of what it left selected, as a drop does). Repeated
 *  words make the text alone ambiguous; without a caret, or with one that
 *  does not fit the text, the text decides. */
export function shiftPicks(picks: readonly MentionPick[], before: string, after: string, caret?: number): MentionPick[] {
  if (before === after || picks.length === 0) return [...picks];
  const { from, oldTo } = rangeBeforeCaret(before, after, caret) ?? inferredRange(before, after);
  const delta = after.length - before.length;
  return picks.flatMap((pick) => {
    const end = pick.start + 1 + pick.mention.label.length;
    if (end <= from) return [pick];
    if (pick.start >= oldTo) return [{ ...pick, start: pick.start + delta }];
    return [];
  });
}

/** What the edit replaced in `before` (from..oldTo), when what it wrote
 *  ends at `caret`: everything after the caret was there before, and it
 *  began where the text first differs. Null when the text after the caret
 *  is not what was after the edit (an edit that left the caret elsewhere). */
function rangeBeforeCaret(before: string, after: string, caret: number | undefined): { from: number; oldTo: number } | null {
  if (caret === undefined) return null;
  const oldTo = caret + before.length - after.length;
  if (before.slice(oldTo) !== after.slice(caret)) return null;
  const bound = Math.min(oldTo, caret);
  let from = 0;
  while (from < bound && before[from] === after[from]) from += 1;
  return { from, oldTo };
}

/** What changed, read from the text: the longest unchanged start and end. */
function inferredRange(before: string, after: string): { from: number; oldTo: number } {
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return { from: prefix, oldTo: before.length - suffix };
}

/** What the send names: each pick whose `@<label>` is still where it was
 *  written, in text order, at most MENTION_LIMIT. */
export function picksInText(text: string, picks: readonly MentionPick[]): Mention[] {
  return [...picks]
    .filter((pick) => text.startsWith(`@${pick.mention.label}`, pick.start))
    .sort((a, b) => a.start - b.start)
    .slice(0, MENTION_LIMIT)
    .map((pick) => pick.mention);
}
