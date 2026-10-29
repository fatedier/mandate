import { expect, test } from "bun:test";
import {
  mentionLabel,
  mentionsMetadata,
  mentionsOf,
  splitMentions,
  type Mention
} from "../src/shared/mentions.js";

const thread = (id: string, label: string): Mention => ({ kind: "thread", id, label });
const A = thread("thr_a", "Parser errors");

test("splitMentions cuts the text at each mention in order", () => {
  const a = thread("thr_a", "A");
  const b = thread("thr_b", "B");
  expect(splitMentions("跟进 @A，再看 @B。", [a, b])).toEqual(["跟进 ", a, "，再看 ", b, "。"]);
  expect(splitMentions("no mention here", [a])).toEqual(["no mention here"]);
  // A mention that is not in the text is skipped; the next one still cuts.
  expect(splitMentions("look at @B", [a, b])).toEqual(["look at ", b]);
  // The same label twice: each mention takes the next one along.
  const a2 = thread("thr_a2", "A");
  expect(splitMentions("@A and @A", [a, a2])).toEqual([a, " and ", a2]);
});

test("mentionsOf reads what mentionsMetadata wrote and drops malformed entries", () => {
  expect(mentionsOf({ type: "text", text: "@Parser errors", metadata: mentionsMetadata([A]) })).toEqual([A]);
  expect(mentionsOf({ type: "text", text: "x", metadata: { mentions: [{ kind: "thread" }, { kind: "thread", id: "thr_x" }, 3, A] } })).toEqual([A]);
  expect(mentionsOf({ type: "assistant", text: "x" } as never)).toEqual([]);
  expect(mentionsOf({ type: "text", text: "x" })).toEqual([]);
});


test("a mention's label is its title on one line, at most 120 characters, the same for the composer and the server", () => {
  expect(mentionLabel("Parser  test\tplan\n")).toBe("Parser test plan");
  // Every line break any reader honours, and other control characters, too.
  expect(mentionLabel("First\u0085Second\u2028third\x1cfourth\x00end")).toBe("First Second third fourth end");
  expect(mentionLabel("x".repeat(300))).toBe("x".repeat(120));
  // The cut counts whole characters: an emoji at the edge is kept whole, never halved.
  expect(mentionLabel(`${"x".repeat(119)}😀z`)).toBe(`${"x".repeat(119)}😀`);
  // A cut that lands on a space leaves no space at the end.
  expect(mentionLabel(`${"x".repeat(119)} y`)).toBe("x".repeat(119));
  // A label cleaned again stays as it is: what the composer writes, the server keeps.
  for (const title of [" a  b ", `${"x".repeat(119)} y`, "y".repeat(300)]) {
    expect(mentionLabel(mentionLabel(title))).toBe(mentionLabel(title));
  }
});
