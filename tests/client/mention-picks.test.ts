import { expect, test } from "bun:test";
import { mentionQueryAt } from "@/routes/window/chat/mention-draft";
import { picksInText, shiftPicks, type MentionPick } from "@/routes/window/chat/mention-picks";

// ── the @ query being typed (mention-draft) ──────────────────────────

test("@ opens at the start, after a space, and after Chinese text, not inside an email", () => {
  expect(mentionQueryAt("@pa", 3)).toEqual({ start: 0, query: "pa" });
  expect(mentionQueryAt("ask @parser", 11)).toEqual({ start: 4, query: "parser" });
  expect(mentionQueryAt("跟进@parser", 9)).toEqual({ start: 2, query: "parser" });
  expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionQueryAt("me@x.com", 8)).toBe(null);
  expect(mentionQueryAt("v2@beta", 7)).toBe(null);
});

test("the query ends at the caret and holds no whitespace", () => {
  expect(mentionQueryAt("@parser errors", 7)).toEqual({ start: 0, query: "parser" });
  expect(mentionQueryAt("@parser errors", 14)).toBe(null);
  expect(mentionQueryAt("plain text", 10)).toBe(null);
  // The @ nearest the caret counts: an earlier mention is left as written.
  expect(mentionQueryAt("@General and @pa", 16)).toEqual({ start: 13, query: "pa" });
});

test("while an input method composes, only the letters it shows may hold spaces", () => {
  // Composing "fa bu" from just after the @: its letters, separators and all.
  expect(mentionQueryAt("@fa bu", 6, 1)).toEqual({ start: 0, query: "fa bu" });
  expect(mentionQueryAt("Ship @fa bu", 11, 6)).toEqual({ start: 5, query: "fa bu" });
  // A space typed before it began ends the query, as when nothing composes:
  // a mention written earlier is not asked again by the words after it.
  expect(mentionQueryAt("@Opal na", 8, 6)).toBe(null);
  expect(mentionQueryAt("@Opal na pa", 11, 6)).toBe(null);
  // A space right after the @ is still no query.
  expect(mentionQueryAt("@ fa", 4, 1)).toBe(null);
});

// ── the picks in the text (mention-picks) ────────────────────────────

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
