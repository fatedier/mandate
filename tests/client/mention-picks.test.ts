import { expect, test } from "bun:test";
import { picksInText, shiftPicks, type MentionPick } from "@/routes/window/chat/mention-picks";

const pick = (label: string, start: number, id = `thr_${label}`): MentionPick => ({ mention: { kind: "thread", id, label }, start });
const at = (picks: MentionPick[]) => picks.map((p) => [p.mention.label, p.start]);

test("an edit before a pick moves it; an edit after it leaves it; an edit in its words drops it", () => {
  const text = "go @Same now";
  const p = [pick("Same", 3)];
  expect(at(shiftPicks(p, text, `well, ${text}`))).toEqual([["Same", 9]]);
  expect(at(shiftPicks(p, text, `${text} please`))).toEqual([["Same", 3]]);
  expect(at(shiftPicks(p, text, "go @Sam now"))).toEqual([]);
  expect(at(shiftPicks(p, text, "go Same now"))).toEqual([]);
});

test("typing right at a pick's edges keeps it, at its start moving it along", () => {
  const p = [pick("Same", 0)];
  expect(at(shiftPicks(p, "@Same", "x@Same"))).toEqual([["Same", 1]]);
  expect(at(shiftPicks(p, "@Same", "@Same!"))).toEqual([["Same", 0]]);
});

test("emptying the box, or pasting over a pick, drops it; picks outside the paste stay", () => {
  const p = [pick("A", 0), pick("B", 6)];
  expect(at(shiftPicks(p, "@A or @B", ""))).toEqual([]);
  expect(at(shiftPicks(p, "@A or @B", "pasted @B"))).toEqual([["B", 7]]);
});

test("the picks still written go to the send in text order, at most ten", () => {
  const text = "@B then @A";
  expect(picksInText(text, [pick("A", 8), pick("B", 0)]).map((m) => m.label)).toEqual(["B", "A"]);
  // A pick whose words are not where it says is not sent.
  expect(picksInText("@B then @X", [pick("A", 8), pick("B", 0)]).map((m) => m.label)).toEqual(["B"]);
  const many = Array.from({ length: 12 }, (_, i) => pick("G", i * 3));
  expect(picksInText("@G ".repeat(12), many)).toHaveLength(10);
});

// Repeated words make "what changed" ambiguous from the text alone: where
// the caret landed (the end of what the edit wrote) says.
test("where the caret landed decides which pick an edit touched, where the text alone cannot", () => {
  const before = "@General @General notes ";
  const picks = [pick("General", 0, "thr_g"), pick("General notes", 9, "thr_gn")];
  // The first "@General " cut: the caret lands at 0.
  expect(shiftPicks(picks, before, "@General notes ", 0).map((p) => [p.mention.id, p.start])).toEqual([["thr_gn", 0]]);
  // "@Same " pasted between two: the caret lands after the pasted words.
  const pasted = shiftPicks([pick("Same", 0, "thr_a"), pick("Same", 6, "thr_b")], "@Same @Same ", "@Same @Same @Same ", 12);
  expect(pasted.map((p) => [p.mention.id, p.start])).toEqual([["thr_a", 0], ["thr_b", 12]]);
});

test("a caret that does not fit the text is not trusted: the text decides", () => {
  // "a" became "x" after the mention, while the caret was read at 2.
  expect(at(shiftPicks([pick("Same", 0)], "@Same ab", "@Same xb", 2))).toEqual([["Same", 0]]);
});
