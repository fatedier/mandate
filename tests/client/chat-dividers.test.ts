import { afterAll, beforeAll, expect, test, setSystemTime } from "bun:test";
import { EMPTY_DIVIDER_STATE, placeDivider, type DividerFacts } from "../../src/client/routes/window/chat/chat-dividers.js";

// A divider's date leaves out this year: pin "this year" to the fixtures'.
beforeAll(() => setSystemTime(new Date("2026-10-08T12:00:00")));
afterAll(() => setSystemTime());

const facts = (start: string, extra: Partial<DividerFacts> = {}): DividerFacts =>
  ({ start, end: Date.parse(start), wakeId: null, continues: false, ...extra });

/** The labels a run of rows gets, from a given state. */
function labels(rows: DividerFacts[], state = EMPTY_DIVIDER_STATE): Array<string | null> {
  const out: Array<string | null> = [];
  for (const row of rows) {
    const placed = placeDivider(row, state);
    out.push(placed.label);
    state = placed.next;
  }
  return out;
}

test("a day opens with its date and time; a pause of five minutes since the previous row gets its time", () => {
  expect(labels([
    facts("2026-08-02T10:00:00"),
    facts("2026-08-02T10:04:59"),
    facts("2026-08-02T10:09:59"),
    facts("2026-08-03T00:00:10")
  ])).toEqual(["Aug 2 · 10:00", null, "10:09", "Aug 3 · 00:00"]);
});

test("the pause is measured from where the previous row ended, not where it began", () => {
  expect(labels([
    facts("2026-08-02T10:00:00", { end: Date.parse("2026-08-02T10:08:00") }),
    facts("2026-08-02T10:10:00")
  ])).toEqual(["Aug 2 · 10:00", null]);
});

test("a later step of the same wake never gets a pause divider, however long it took", () => {
  // A reply streams outside the list and lands with the time it finished: a
  // divider must not appear over it then. A new wake after a pause does get one.
  expect(labels([
    facts("2026-08-02T10:00:00", { wakeId: "w1" }),
    facts("2026-08-02T10:07:00", { wakeId: "w1", continues: true }),
    facts("2026-08-02T10:13:00", { wakeId: "w2" })
  ])).toEqual(["Aug 2 · 10:00", null, "10:13"]);
  // A new day still opens with its divider, even mid-wake.
  expect(labels([
    facts("2026-08-02T23:59:00", { wakeId: "w1" }),
    facts("2026-08-03T00:01:00", { wakeId: "w1", continues: true })
  ])).toEqual(["Aug 2 · 23:59", "Aug 3 · 00:01"]);
});
