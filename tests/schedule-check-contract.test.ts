import { expect, test } from "bun:test";
import { decideCheck, parseCheckOutput, SCHEDULE_LIMITS, type CheckParse, type SeenItems } from "../src/server/modules/schedules/check-contract.js";

const run = (stdout: string, over: Partial<{ stderr: string; exitCode: number; timedOut: boolean }> = {}) =>
  ({ stdout, stderr: "", exitCode: 0, timedOut: false, ...over });

function ok(parse: CheckParse): Extract<CheckParse, { ok: true }> {
  if (!parse.ok) throw new Error(`expected ok, got: ${parse.error}`);
  return parse;
}

test("parse takes the last non-empty line", () => {
  const parsed = ok(parseCheckOutput(run('noise\n\u001b[31mred\u001b[0m\r\n{"wake":false}\n\n')));
  expect(parsed.wake).toBe(false);
  expect(parsed.context).toBe("noise\nred");
  expect(parsed.items).toBeNull();
  expect(parsed.message).toBeNull();
  expect(parsed.state).toBeUndefined();
});

test("a full answer reads back", () => {
  const parsed = ok(parseCheckOutput(run(JSON.stringify({
    wake: true, message: "2 new dry beds", state: { last: "x" },
    items: [{ id: "sig:qwer", title: "Dry soil (12x)" }, { id: "moisture:bed-5:2026-11-07", version: "2" }]
  }))));
  expect(parsed).toMatchObject({
    wake: true, message: "2 new dry beds", state: { last: "x" },
    items: [{ id: "sig:qwer", title: "Dry soil (12x)", version: null }, { id: "moisture:bed-5:2026-11-07", title: null, version: "2" }]
  });
});

test("non-zero exit, timeout and a bad last line fail", () => {
  const exit = parseCheckOutput(run('{"wake":true}', { exitCode: 2, stderr: "boom" }));
  expect(exit).toEqual({ ok: false, error: expect.stringContaining("exit 2") });
  expect(exit.ok ? "" : exit.error).toContain("boom");
  const late = parseCheckOutput(run("", { timedOut: true }));
  expect(late.ok ? "" : late.error).toContain("timed out");
  expect(parseCheckOutput(run("wake: yes")).ok).toBe(false);
  expect(parseCheckOutput(run('{"wake":"yes"}')).ok).toBe(false);
  expect(parseCheckOutput(run("[1,2]")).ok).toBe(false);
  expect(parseCheckOutput(run("")).ok).toBe(false);
});

test("what a check reports is taken whatever its length; what it keeps or keys by is held to its limit", () => {
  const read = (body: unknown) => parseCheckOutput(run(JSON.stringify(body)));
  // A long message and many items are the wake's to fit (cut there, the whole saved).
  const long = "x".repeat(5000);
  expect(read({ wake: true, message: long })).toMatchObject({ ok: true, message: long });
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `i${i}` }));
  expect(ok(read({ wake: true, items: many })).items).toHaveLength(80);
  // A title is what a row shows: cut, never a failed run.
  const title = ok(read({ wake: true, items: [{ id: "a", title: "t".repeat(SCHEDULE_LIMITS.itemTitleMaxChars + 50) }] })).items![0]!.title!;
  expect([title.length, title.endsWith("…")]).toEqual([SCHEDULE_LIMITS.itemTitleMaxChars, true]);
  // The state is kept for the next run, and an id is what delivered items are known by.
  expect(read({ wake: true, state: { blob: "x".repeat(SCHEDULE_LIMITS.stateMaxBytes) } })).toEqual({ ok: false, error: expect.stringContaining("state") });
  expect(read({ wake: true, items: [{ id: "x".repeat(SCHEDULE_LIMITS.itemIdMaxChars + 1) }] })).toEqual({ ok: false, error: expect.stringContaining("id") });
  expect(read({ wake: true, items: [{ id: "" }] }).ok).toBe(false);
});

const decide = (body: unknown, seen: SeenItems = []) => decideCheck(ok(parseCheckOutput(run(JSON.stringify(body)))), seen);

test("a run that lists more items than the seen list holds keeps them all seen, so the same list wakes nothing again", () => {
  const items = Array.from({ length: SCHEDULE_LIMITS.seenMax + 1 }, (_, i) => ({ id: `sig:${i}` }));
  const first = decide({ wake: true, items });
  expect([first.kind, first.seen.length]).toEqual(["wake", SCHEDULE_LIMITS.seenMax + 1]);
  expect(decide({ wake: true, items }, first.seen).kind).toBe("quiet");
  // Older ones the run no longer lists are what give way.
  const next = decide({ wake: true, items: [...items.slice(1), { id: "sig:new" }] }, first.seen);
  expect([next.kind, next.newItems.map((i) => i.id), next.seen.length, next.seen.some(([id]) => id === "sig:0")]).toEqual(["wake", ["sig:new"], SCHEDULE_LIMITS.seenMax + 1, false]);
});

test("wake without items wakes", () => {
  expect(decide({ wake: true, message: "moisture low" })).toMatchObject({ kind: "wake", newItems: [] });
});

test("an explicitly empty item list is quiet", () => {
  expect(decide({ wake: true, items: [] })).toMatchObject({ kind: "quiet", newItems: [] });
});

test("items must be an array when given", () => {
  expect(parseCheckOutput(run('{"wake":true,"items":null}')).ok).toBe(false);
});

test("an id listed twice in one run counts once", () => {
  const decided = decide({ wake: true, items: [{ id: "sig:a", title: "first" }, { id: "sig:a", title: "again" }, { id: "sig:b" }] });
  expect(decided.newItems.map((i) => [i.id, i.title])).toEqual([["sig:a", "first"], ["sig:b", null]]);
  expect(decided.seen).toEqual([["sig:a", null], ["sig:b", null]]);
});

test("wake with only seen items is quiet", () => {
  const seen: SeenItems = [["sig:a", null]];
  expect(decide({ wake: true, items: [{ id: "sig:a" }] }, seen)).toMatchObject({ kind: "quiet", newItems: [] });
});

test("a changed version is new again", () => {
  const seen: SeenItems = [["sig:a", "1"]];
  const decided = decide({ wake: true, items: [{ id: "sig:a", version: "2" }, { id: "sig:b" }] }, seen);
  expect(decided.kind).toBe("wake");
  expect(decided.newItems.map((i) => i.id)).toEqual(["sig:a", "sig:b"]);
  expect(decided.seen).toEqual([["sig:a", "2"], ["sig:b", null]]);
});

test("wake false with new items is quiet and does not mark them seen", () => {
  const decided = decide({ wake: false, items: [{ id: "sig:new" }] });
  expect(decided).toEqual({ kind: "quiet", newItems: [], seen: [] });
});

test("seen keeps the newest 2000", () => {
  const seen: SeenItems = Array.from({ length: SCHEDULE_LIMITS.seenMax }, (_, i) => [`old${i}`, null]);
  const decided = decide({ wake: true, items: [{ id: "fresh" }] }, seen);
  expect(decided.seen).toHaveLength(SCHEDULE_LIMITS.seenMax);
  expect(decided.seen[0]).toEqual(["old1", null]);
  expect(decided.seen.at(-1)).toEqual(["fresh", null]);
});
