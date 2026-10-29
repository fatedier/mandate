import { expect, test } from "bun:test";
import { countLineChanges, diffLines, fileLines, lineChangesBetween, type DiffLine } from "../src/shared/line-diff.js";

const show = (lines: DiffLine[]) => lines.map((l) => `${l.kind}${l.text}`);

/** Seeded digits in 32-bit integer steps (mulberry32). The obvious
 *  `seed * 1103515245 % 2 ** 31` overflows a double's 53 bits: its low bits
 *  go to zero, and every "random" list came out one letter. */
function digits(seed: number, base: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % base;
  };
}

test("the lines both sides begin and end with are context, and only the middle is aligned", () => {
  const { lines, aligned } = diffLines(["a", "b", "c", "d", "e"], ["a", "b", "X", "d", "e"], 1);
  // One changed line against one: a single pair, within even the smallest limit.
  expect(aligned).toBe(true);
  expect(show(lines)).toEqual([" a", " b", "-c", "+X", " d", " e"]);
});

test("a middle past the limit is removed and added whole, the ends still context", () => {
  const { lines, aligned } = diffLines(["a", "b", "c", "z"], ["a", "c", "b", "z"], 3);
  expect(aligned).toBe(false);
  expect(show(lines)).toEqual([" a", "-b", "-c", "+c", "+b", " z"]);
  // At the limit it aligns.
  const at = diffLines(["a", "b", "c", "z"], ["a", "c", "b", "z"], 4);
  expect(at.aligned).toBe(true);
  expect(countLineChanges(at.lines)).toEqual({ added: 1, removed: 1 });
});

test("one side all of the other, ends overlapping, is still read back as the two sides", () => {
  expect(show(diffLines(["a", "a"], ["a", "a", "a"], 100).lines)).toEqual([" a", " a", "+a"]);
  expect(show(diffLines([], ["x"], 100).lines)).toEqual(["+x"]);
  expect(show(diffLines(["x"], [], 100).lines)).toEqual(["-x"]);
  expect(show(diffLines([], [], 100).lines)).toEqual([]);
});

test("any diff reads back as the two lists it was made from, and counts what it marks", () => {
  const next = digits(11, 4);
  let both = 0;
  for (let round = 0; round < 300; round += 1) {
    const a = Array.from({ length: next() + next() + next() }, () => "wxyz"[next()]!);
    const b = Array.from({ length: next() + next() + next() }, () => "wxyz"[next()]!);
    const { lines } = diffLines(a, b, round % 2 === 0 ? 1_000 : 2);
    expect(lines.filter((l) => l.kind !== "+").map((l) => l.text)).toEqual(a);
    expect(lines.filter((l) => l.kind !== "-").map((l) => l.text)).toEqual(b);
    const counts = countLineChanges(lines);
    expect(counts.added - counts.removed).toBe(b.length - a.length);
    if (counts.added > 0 && counts.removed > 0 && lines.some((l) => l.kind === " ")) both += 1;
  }
  // The inputs vary: most rounds add, remove and keep lines at once.
  expect(both).toBeGreaterThan(100);
});

test("a file's lines end at a final newline, and an empty file has none", () => {
  expect(fileLines("")).toEqual([]);
  expect(fileLines("a")).toEqual(["a"]);
  expect(fileLines("a\n")).toEqual(["a"]);
  expect(fileLines("a\n\n")).toEqual(["a", ""]);
  expect(fileLines("\n")).toEqual([""]);
});

test("counting without the diff gives what the diff marks, either side the longer", () => {
  const next = digits(5, 4);
  let both = 0;
  for (let round = 0; round < 400; round += 1) {
    const a = Array.from({ length: next() + next() + next() + next() }, () => "wxyz"[next()]!);
    const b = Array.from({ length: next() + next() }, () => "wxyz"[next()]!);
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const counted = lineChangesBetween(x, y, 1_000);
      expect(counted).toEqual(countLineChanges(diffLines(x, y, 1_000).lines));
      if (counted!.added > 0 && counted!.removed > 0 && counted!.removed < x.length) both += 1;
    }
  }
  expect(both).toBeGreaterThan(200);
});

test("counting a side left empty costs nothing, and a middle past the limit is not counted", () => {
  const long = Array.from({ length: 3_000_000 }, (_, i) => `line ${i}`);
  expect(lineChangesBetween(long, [], 1)).toEqual({ added: 0, removed: 3_000_000 });
  expect(lineChangesBetween([], long, 1)).toEqual({ added: 3_000_000, removed: 0 });
  expect(lineChangesBetween(["a", "b", "c", "z"], ["a", "c", "b", "z"], 3)).toBe(null);
  expect(lineChangesBetween(["a", "b", "c", "z"], ["a", "c", "b", "z"], 4)).toEqual({ added: 1, removed: 1 });
});
