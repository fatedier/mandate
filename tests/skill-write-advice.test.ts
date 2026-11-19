import { expect, test } from "bun:test";
import { skillWriteAdvice } from "../src/server/modules/skills/skill-write-advice.js";

// After a write the writer hears when its change only adds, the skill grew
// past its budget, or the change adds dates or ticket numbers. Advice never
// refuses a write.

const ONLY_ADDS = "This change only adds to the skill: fold what it teaches into the step it corrects or adds to, and take out what that step no longer needs.";
const LOG_MARKS = "The change adds dates or ticket numbers: state the rule without them.";
const SAVED = "The change is saved; change it again if it should read otherwise.";
const STAGED = "To do it otherwise, call manage_skill again on this skill: that replaces this change.";
const BASE = "1. Tag.\n2. Build.\n3. Ship.\n";
const lines = (n: number) => Array.from({ length: n }, (_, i) => `- Step ${i + 1}.`).join("\n");

test("a change that removes no line and adds five or more only adds; fewer, or one that touches a line, does not", () => {
  expect(skillWriteAdvice(BASE, `${BASE}${lines(5)}\n`, "staged")).toEqual([ONLY_ADDS, STAGED]);
  expect(skillWriteAdvice(BASE, `${BASE}${lines(4)}\n`, "staged")).toEqual([]);
  expect(skillWriteAdvice(BASE, `1. Tag.\n2. Build and sign.\n3. Ship.\n${lines(6)}\n`, "saved")).toEqual([]);
  // Appended after a last line with no newline: that line is not changed.
  expect(skillWriteAdvice("1. Tag.\n2. Ship.", `1. Tag.\n2. Ship.\n${lines(5)}`, "saved")).toEqual([ONLY_ADDS, "The change is saved; change it again if it should read otherwise."]);
  // A new skill always only adds: that says nothing.
  expect(skillWriteAdvice(null, `${lines(20)}\n`, "staged")).toEqual([]);
});

test("a skill that grew past 12,000 characters is over its budget; one that shrank is not told", () => {
  const long = `${"x".repeat(12_100)}\n`;
  expect(skillWriteAdvice(BASE, long, "saved")).toEqual(["The skill is now 12,101 characters, over 12,000: fold repeated or superseded steps together, keeping every step that was shown to be needed.", SAVED]);
  expect(skillWriteAdvice(`${long}${long}`, long, "saved")).toEqual([]);
  expect(skillWriteAdvice(null, long, "staged")[0]).toContain("The skill is now 12,101 characters");
});

test("a change that adds a date or a ticket, PR, MR or issue number has log marks; marks already there are not told again", () => {
  for (const mark of ["Seen 2025-03-04.", "See !12.", "Fixed in #56.", "As PR 78 did.", "MR !34 needed it.", "issue 90"]) {
    expect(skillWriteAdvice(BASE, `${BASE}- ${mark}\n`, "staged")).toEqual([LOG_MARKS, STAGED]);
  }
  expect(skillWriteAdvice(`${BASE}- See !12.\n`, `${BASE}- See !12 first.\n`, "staged")).toEqual([]);
  // A mark in place of another is still one added; so is one beside one taken out.
  expect(skillWriteAdvice(`${BASE}- Fixed in #56.\n`, `${BASE}- Fixed in #57.\n`, "staged")).toEqual([LOG_MARKS, STAGED]);
  expect(skillWriteAdvice(`${BASE}- Seen 2025-03-03.\n`, `${BASE}- Seen 2025-03-04.\n`, "staged")).toEqual([LOG_MARKS, STAGED]);
  // Short numbers marked as tickets count too.
  for (const mark of ["See #42.", "As PR 42 did.", "MR !7 needed it."]) {
    expect(skillWriteAdvice(BASE, `${BASE}- ${mark}\n`, "staged")).toEqual([LOG_MARKS, STAGED]);
  }
  // A heading, a step number, a count or a page anchor is no ticket.
  expect(skillWriteAdvice(BASE, `${BASE}## Checks\n- Wait 3000 ms.\n- Read notes/page#12.\n`, "staged")).toEqual([]);
});

test("every finding comes in one reply, then the one closing line", () => {
  const grown = `${BASE}${lines(5)}\n- Seen 2025-03-04.\n${"y".repeat(12_000)}\n`;
  const advice = skillWriteAdvice(BASE, grown, "saved");
  expect(advice).toHaveLength(4);
  expect(advice[0]).toBe(ONLY_ADDS);
  expect(advice[1]).toStartWith("The skill is now ");
  expect(advice.slice(2)).toEqual([LOG_MARKS, SAVED]);
});
