import { diffLines } from "diff";

/** The size past which a skill that grew is told to fold: each load of it
 *  rides in every later call of the conversation. The hard cap is
 *  SKILL_BODY_MAX_CHARS. */
export const SKILL_ADVICE_CHARS = 12_000;
/** A change that removes no line and adds this many is an appended account. */
const ONLY_ADDS_MIN_LINES = 5;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
/** A ticket, PR, MR or issue number: named so, or marked `#`/`!` with two
 *  digits or more (one alone is too often an item's number). */
const TICKET = /\b(?:PR|MR|issue)\s*[#!]?\d{1,6}\b|(?<![\w/])[#!]\d{2,6}\b/gi;

const marksOf = (text: string): string[] => [...(text.match(DATE) ?? []), ...(text.match(TICKET) ?? [])];

/** Whether `after` holds a mark `before` did not, counting repeats: a mark
 *  in place of another is one added. */
function addsMarks(before: string, after: string): boolean {
  const left = new Map<string, number>();
  for (const mark of marksOf(before)) left.set(mark, (left.get(mark) ?? 0) + 1);
  return marksOf(after).some((mark) => {
    const n = left.get(mark) ?? 0;
    if (n === 0) return true;
    left.set(mark, n - 1);
    return false;
  });
}

/** What a writer is told after a change of a skill's text, `before` null
 *  for a new skill: never a refusal. Empty when nothing needs saying; else
 *  each finding, then how to do it otherwise — the agent's change is saved,
 *  a review's or tidy's staged. */
export function skillWriteAdvice(before: string | null, after: string, mode: "saved" | "staged"): string[] {
  const advice: string[] = [];
  if (before !== null) {
    let removed = 0;
    let added = 0;
    for (const part of diffLines(before, after, { ignoreNewlineAtEof: true })) {
      if (part.removed) removed += part.count;
      else if (part.added) added += part.count;
    }
    if (removed === 0 && added >= ONLY_ADDS_MIN_LINES) {
      advice.push("This change only adds to the skill: fold what it teaches into the step it corrects or adds to, and take out what that step no longer needs.");
    }
  }
  if (after.length > (before?.length ?? 0) && after.length > SKILL_ADVICE_CHARS) {
    advice.push(`The skill is now ${after.length.toLocaleString("en-US")} characters, over ${SKILL_ADVICE_CHARS.toLocaleString("en-US")}: fold repeated or superseded steps together, keeping every step that was shown to be needed.`);
  }
  if (addsMarks(before ?? "", after)) advice.push("The change adds dates or ticket numbers: state the rule without them.");
  if (advice.length === 0) return [];
  advice.push(mode === "saved"
    ? "The change is saved; change it again if it should read otherwise."
    : "To do it otherwise, call manage_skill again on this skill: that replaces this change.");
  return advice;
}
