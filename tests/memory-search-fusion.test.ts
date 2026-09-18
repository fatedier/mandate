import { expect, test } from "bun:test";
import { fuseByRank } from "../src/server/modules/memory/local-provider-helpers.js";

function order(lists: Array<{ path: any; ids: string[] }>): string[] {
  const fused = fuseByRank(lists);
  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([id]) => id);
}

test("a single list keeps its order exactly", () => {
  expect(order([{ path: "fts", ids: ["a", "b", "c"] }])).toEqual(["a", "b", "c"]);
});

test("the first entry of a list scores 1 / (k + 1)", () => {
  // Pins both k and that ranks start at 1. The rank base is invisible to every
  // ordering assertion -- shifting it moves all scores and reorders nothing --
  // so only an absolute score catches a change to it, and these are the scores
  // `search()` hands back to callers.
  const fused = fuseByRank([{ path: "fts", ids: ["a", "b"] }]);
  expect(fused.get("a")!.score).toBeCloseTo(1 / 61, 12);
  expect(fused.get("b")!.score).toBeCloseTo(1 / 62, 12);
});

test("an entry both paths found beats one only a single path ranked higher", () => {
  // `both` is 3rd and 4th; `solo` is 1st in fts and absent from vector.
  const lists = [
    { path: "fts" as const, ids: ["solo", "x", "both"] },
    { path: "vector" as const, ids: ["y", "z", "w", "both"] }
  ];
  const fused = fuseByRank(lists);
  expect(fused.get("both")!.score).toBeGreaterThan(fused.get("solo")!.score);
});

test("k = 60 makes multi-path agreement outweigh a single first place", () => {
  // This is the tradeoff the constant buys, checked at the worst case the fusion
  // inputs can produce: search() truncates both lists to `limit`, whose ceiling is
  // 20, so rank 20 is the deepest an entry can sit. Agreement there still has to
  // beat the entry one path put first, which needs 2/(k + 20) > 1/(k + 1) -- true
  // only for k > 18. At rank 2 the same comparison holds for every k > 0, so it
  // would pin nothing.
  const pad = (prefix: string) => Array.from({ length: 18 }, (_, i) => `${prefix}${i}`);
  const lists = [
    { path: "fts" as const, ids: ["first", ...pad("f"), "deep"] },
    { path: "vector" as const, ids: ["other", ...pad("v"), "deep"] }
  ];
  const fused = fuseByRank(lists);
  expect(fused.get("deep")!.score).toBeGreaterThan(fused.get("first")!.score);

  // And it really is k carrying it: at 18 the two sides are exactly equal.
  const tight = fuseByRank(lists, 18);
  expect(tight.get("deep")!.score).toBe(tight.get("first")!.score);
});

test("an empty list contributes nothing and shifts no other ranks", () => {
  const withEmpty = fuseByRank([
    { path: "fts", ids: ["a", "b"] },
    { path: "vector", ids: [] }
  ]);
  const without = fuseByRank([{ path: "fts", ids: ["a", "b"] }]);
  expect(withEmpty.get("a")!.score).toBe(without.get("a")!.score);
  expect(withEmpty.get("b")!.score).toBe(without.get("b")!.score);
  expect(withEmpty.size).toBe(2);
});

test("reason is the path that ranked the entry best", () => {
  const fused = fuseByRank([
    { path: "fts", ids: ["x", "y", "shared"] },
    { path: "vector", ids: ["shared", "z"] }
  ]);
  expect(fused.get("shared")!.path).toBe("vector");
});

test("an equal best rank resolves by fts, then vector, then like", () => {
  // Both list orders, deliberately. With only the vector-first case, changing the
  // comparison to `rank <= current.bestRank` survives: it hands the tie to
  // whichever list was processed last, which in that order is also fts.
  const vectorFirst = fuseByRank([
    { path: "vector", ids: ["tied"] },
    { path: "fts", ids: ["tied"] }
  ]);
  expect(vectorFirst.get("tied")!.path).toBe("fts");

  const ftsFirst = fuseByRank([
    { path: "fts", ids: ["tied"] },
    { path: "vector", ids: ["tied"] }
  ]);
  expect(ftsFirst.get("tied")!.path).toBe("fts");
});

test("scores strictly decrease with rank inside one list", () => {
  const fused = fuseByRank([{ path: "fts", ids: ["a", "b", "c"] }]);
  expect(fused.get("a")!.score).toBeGreaterThan(fused.get("b")!.score);
  expect(fused.get("b")!.score).toBeGreaterThan(fused.get("c")!.score);
});

test("no list at all fuses to nothing", () => {
  expect(fuseByRank([]).size).toBe(0);
});
