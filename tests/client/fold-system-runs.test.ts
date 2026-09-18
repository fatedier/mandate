import { expect, test } from "bun:test";
import { describeFold, foldSystemRuns } from "@/routes/window/chat/fold-system-runs";

type Row = { id: string; sys: string | null; at: string };
const row = (id: string, sys: string | null, at = "2026-09-15T04:00:00.000Z"): Row => ({ id, sys, at });
const classify = (r: Row) => (r.sys ? { label: r.sys, createdAt: r.at } : null);
const keyOf = (r: Row) => r.id;

test("a single system row stays a row", () => {
  const out = foldSystemRuns([row("u1", null), row("h1", "HEARTBEAT"), row("u2", null)], classify, keyOf);
  expect(out.map((e) => e.kind)).toEqual(["item", "item", "item"]);
});

test("two or more consecutive system rows fold into one entry keyed by the first", () => {
  const out = foldSystemRuns(
    [row("u1", null), row("h1", "HEARTBEAT", "2026-09-15T04:00:00.000Z"), row("c1", "CONTEXT", "2026-09-15T04:30:00.000Z"), row("h2", "HEARTBEAT", "2026-09-15T05:00:00.000Z"), row("u2", null)],
    classify, keyOf
  );
  expect(out.map((e) => e.kind)).toEqual(["item", "fold", "item"]);
  const fold = out[1] as Extract<(typeof out)[number], { kind: "fold" }>;
  expect(fold.key).toBe("h1");
  expect(fold.items.map((r) => r.id)).toEqual(["h1", "c1", "h2"]);
  // counts per label, first-seen order
  expect(fold.counts).toEqual([{ label: "HEARTBEAT", count: 2 }, { label: "CONTEXT", count: 1 }]);
  expect(fold.start).toBe("2026-09-15T04:00:00.000Z");
  expect(fold.end).toBe("2026-09-15T05:00:00.000Z");
});

test("a non-system row breaks the run", () => {
  const out = foldSystemRuns([row("h1", "HEARTBEAT"), row("u1", null), row("h2", "HEARTBEAT")], classify, keyOf);
  expect(out.map((e) => e.kind)).toEqual(["item", "item", "item"]);
});

test("a run at the very end folds too", () => {
  const out = foldSystemRuns([row("u1", null), row("h1", "HEARTBEAT"), row("h2", "HEARTBEAT")], classify, keyOf);
  expect(out.map((e) => e.kind)).toEqual(["item", "fold"]);
});

test("describeFold names each label in plain words with a time range", () => {
  const clock = (iso: string) => iso.slice(11, 16);
  expect(describeFold(
    [{ label: "HEARTBEAT", count: 3 }, { label: "CONTEXT", count: 4 }],
    "2026-09-15T12:00:00.000Z", "2026-09-15T14:04:00.000Z", clock
  )).toBe("3 heartbeats · 4 context snapshots · 12:00 – 14:04");
  expect(describeFold([{ label: "WATCH", count: 1 }, { label: "ALARM", count: 2 }], null, null, clock))
    .toBe("1 watch event · 2 alarms");
  expect(describeFold([{ label: "SOMETHING NEW", count: 2 }], "2026-09-15T12:00:00.000Z", "2026-09-15T12:00:00.000Z", clock))
    .toBe("2 something new events · 12:00");
});
