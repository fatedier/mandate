import { expect, test } from "bun:test";
import { scoreThreads } from "../src/server/modules/agent/history-store.js";

type Entry = { rank?: number | null; message_created_at: string };

function group(id: string, entries: Entry[]) {
  return { id, entries: entries as any };
}

function order(groups: Array<{ id: string; entries: any }>): string[] {
  const scores = scoreThreads(groups);
  return [...groups]
    .sort((a, b) => scores.get(b.id)! - scores.get(a.id)!)
    .map((g) => g.id);
}

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-06-01T00:00:00.000Z";

test("the best-matching thread leads even with the fewest hits", () => {
  // Today's inverted formula puts `best` last: one hit and the largest |bm25|.
  const groups = [
    group("best", [{ rank: -12, message_created_at: T1 }]),
    group("most-hits", Array.from({ length: 6 }, () => ({ rank: -7, message_created_at: T2 }))),
    group("weakest", [{ rank: -6.5, message_created_at: T2 }])
  ];
  expect(order(groups)[0]).toBe("best");
});

test("a worthless match ranks below a strong one", () => {
  // bm25 0 is the weakest possible match; today it scores the maximum.
  const groups = [
    group("worthless", [{ rank: 0, message_created_at: T2 }]),
    group("strong", [{ rank: -10, message_created_at: T2 }])
  ];
  expect(order(groups)).toEqual(["strong", "worthless"]);
});

test("hit count breaks a tie in match quality", () => {
  const groups = [
    group("few", [{ rank: -8, message_created_at: T2 }]),
    group("many", Array.from({ length: 4 }, () => ({ rank: -8, message_created_at: T2 })))
  ];
  expect(order(groups)).toEqual(["many", "few"]);
});

test("an unranked group sits between the best and worst ranked groups", () => {
  // Asserted on scores, not order: an order assertion would survive both
  // LIKE_MATCH_RELEVANCE = 1 and = 0, because each collapses into a tie that
  // a stable sort resolves the way the assertion already expects.
  const scores = scoreThreads([
    group("strong", [{ rank: -12, message_created_at: T2 }]),
    group("unranked", [{ rank: null, message_created_at: T2 }]),
    group("weak", [{ rank: -6, message_created_at: T2 }])
  ]);
  expect(scores.get("unranked")!).toBeLessThan(scores.get("strong")!);
  expect(scores.get("unranked")!).toBeGreaterThan(scores.get("weak")!);
});

test("a lone ranked group does not win on a bm25 nothing can be compared against", () => {
  // The shape a mixed search almost always takes: the overview thread is a
  // singleton, so a project-LIKE + global-FTS set has exactly one ranked group.
  // One quality value is not a span -- there is no second bm25 to place it
  // against, and a bm25 is not commensurable with a substring match -- so quality
  // is inert for the whole set and hits decide. Without that guard the lone
  // ranked group took the degenerate span's ceiling of 1 against the unranked
  // group's midpoint and led 0.72 + 0.08 to 0.36 + 0.2 + 0.08 on a bm25 of -1e-6.
  const groups = [
    group("barely-matched", [{ rank: -0.000001, message_created_at: T2 }]),
    group("unranked", Array.from({ length: 3 }, () => ({ rank: null, message_created_at: T2 })))
  ];
  expect(order(groups)).toEqual(["unranked", "barely-matched"]);
});

test("two ranked qualities still separate, even against a fatter unranked group", () => {
  // The guard against over-correcting the above: neutralizing quality outright
  // would let the unranked group's four hits carry it past both ranked groups.
  // Here quality has a real span (|-12| against |-1|), so it stays live: strong
  // leads at 0.72 + 0.08, unranked sits at its midpoint 0.36 + 0.2 + 0.08, and
  // weak trails at 0.08. Ordered, not scored, because the point is the ordering.
  const groups = [
    group("strong", [{ rank: -12, message_created_at: T2 }]),
    group("unranked", Array.from({ length: 4 }, () => ({ rank: null, message_created_at: T2 }))),
    group("weak", [{ rank: -1, message_created_at: T2 }])
  ];
  expect(order(groups)).toEqual(["strong", "unranked", "weak"]);
});

test("an all-unranked set is ordered by hits, and passes today's saturation point", () => {
  // Today hitBoost saturates at 6.25 hits, so 8 and 20 tie and recency decides.
  const groups = [
    group("eight", Array.from({ length: 8 }, () => ({ rank: null, message_created_at: T2 }))),
    group("twenty", Array.from({ length: 20 }, () => ({ rank: null, message_created_at: T1 })))
  ];
  expect(order(groups)).toEqual(["twenty", "eight"]);
});

test("a single group scores 1 and does not divide by zero", () => {
  const scores = scoreThreads([group("only", [{ rank: -9, message_created_at: T1 }])]);
  // Not toBe(1): 0.72 + 0.2 + 0.08 is 0.9999999999999999 in IEEE doubles.
  expect(scores.get("only")!).toBeCloseTo(1, 10);
});

test("a group with an unusable signal costs only itself", () => {
  // Containment, not validation: NaN spreads through Math.min/Math.max and then
  // through every comparison, so without a guard one bad timestamp would score
  // the whole set NaN and leave the caller's sort with an arbitrary order.
  const wellFormed = [
    group("strong", [{ rank: -12, message_created_at: T2 }]),
    group("weak", [{ rank: -6, message_created_at: T1 }])
  ];
  const withUndated = [
    ...wellFormed,
    group("undated", [{ rank: -9, message_created_at: "not a timestamp" }])
  ];

  for (const [, score] of scoreThreads(withUndated)) {
    expect(Number.isFinite(score)).toBe(true);
  }
  // The well-formed groups keep the order they had without it.
  expect(order(withUndated).filter((id) => id !== "undated")).toEqual(order(wellFormed));
});

test("an unusable signal does not move the other groups' scores", () => {
  // Containment specifically, not just finiteness. `undated` is deliberately
  // non-extremal on the two signals it can still be scored on -- same rank and
  // same hit count as `early` -- so it cannot legitimately move anyone's quality
  // or hits term, and only the recency span is left to be affected. The
  // well-formed groups must then come out identical to a set that never
  // contained it. Collapsing the recency span to () => 1 on encountering the bad
  // value, rather than containing it, would change `early` -- that is exactly the
  // difference between an early return and containment, and the reason for the
  // shape of the guard.
  const early = group("early", [
    { rank: -10, message_created_at: T1 },
    { rank: -10, message_created_at: T1 }
  ]);
  const late = group("late", [
    { rank: -4, message_created_at: T2 },
    { rank: -4, message_created_at: T2 }
  ]);
  const undated = group("undated", [
    { rank: -10, message_created_at: "not a timestamp" },
    { rank: -10, message_created_at: "not a timestamp" }
  ]);

  const alone = scoreThreads([early, late]);
  const alongside = scoreThreads([early, late, undated]);
  expect(alongside.get("early")!).toBeCloseTo(alone.get("early")!, 10);
  expect(alongside.get("late")!).toBeCloseTo(alone.get("late")!, 10);
});

test("a group's quality is its best hit, not its worst", () => {
  // `spread` straddles the set: its best rank is the strongest in play and its
  // worst is the weakest, so reading the wrong end of the group flips which
  // group wins on quality. It also has more hits, which keeps the two readings
  // apart rather than letting the hits term rescue the wrong one. Taking the
  // best rank: qualities are 12 and 6, so spread normalizes to 1 and steady to
  // 0, and spread leads 1.0 to 0.08. Taking the worst: qualities become 1 and
  // 6, and steady leads 0.8 to 0.28 despite the thinner match.
  const groups = [
    group("spread", [
      { rank: -12, message_created_at: T2 },
      { rank: -1, message_created_at: T2 }
    ]),
    group("steady", [{ rank: -6, message_created_at: T2 }])
  ];
  // One timestamp across the set, so recency is degenerate and cannot decide it.
  expect(order(groups)).toEqual(["spread", "steady"]);
});

test("scoring does not read the clock", () => {
  const groups = [
    group("a", [{ rank: -9, message_created_at: T1 }]),
    group("b", [{ rank: -4, message_created_at: T2 }])
  ];
  expect([...scoreThreads(groups)]).toEqual([...scoreThreads(groups)]);
});
