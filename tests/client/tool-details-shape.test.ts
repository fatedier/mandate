import { expect, test } from "bun:test";
import {
  argParts,
  humanizeKey,
  isBareAck,
  isProse,
  isTimestamp,
  itemSummary,
  layoutRows,
  partLabel
} from "@/routes/window/chat/tool-details/shape";

test("a key reads as words", () => {
  expect(humanizeKey("phaseDetail")).toBe("Phase detail");
  expect(humanizeKey("paneId")).toBe("Pane ID");
  expect(humanizeKey("fire_at")).toBe("Fire at");
  expect(humanizeKey("includeExited")).toBe("Include exited");
  expect(humanizeKey("timeoutMs")).toBe("Timeout ms");
  expect(humanizeKey("openURL")).toBe("Open URL");
  expect(humanizeKey("URLPath")).toBe("URL path");
  expect(humanizeKey("id")).toBe("ID");
  expect(humanizeKey("limit")).toBe("Limit");
  expect(humanizeKey("___")).toBe("___");
});

test("writing is anything past 60 characters, or with a line break", () => {
  expect(isProse("x".repeat(60))).toBe(false);
  expect(isProse("x".repeat(61))).toBe(true);
  expect(isProse("two\nlines")).toBe(true);
});

test("each argument is placed by its shape", () => {
  const long = "a note long enough to be something someone wrote rather than a value to scan";
  expect(argParts({
    id: "wi_1",
    limit: 10,
    done: false,
    cleared: null,
    note: long,
    cues: ["one", "two"],
    empty: [],
    counts: [1, 2],
    mixed: ["one", 2],
    patch: { title: "T", nested: { deep: 1 } },
    skipped: undefined
  })).toEqual([
    { kind: "option", key: ["id"], value: "wi_1" },
    { kind: "option", key: ["limit"], value: 10 },
    { kind: "option", key: ["done"], value: false },
    { kind: "option", key: ["cleared"], value: null },
    { kind: "prose", key: ["note"], value: long },
    { kind: "list", key: ["cues"], value: ["one", "two"] },
    { kind: "data", key: ["empty"], value: [] },
    { kind: "data", key: ["counts"], value: [1, 2] },
    { kind: "data", key: ["mixed"], value: ["one", 2] },
    // Opened one level; a record inside that is JSON.
    { kind: "option", key: ["patch", "title"], value: "T" },
    { kind: "data", key: ["patch", "nested"], value: { deep: 1 } }
  ]);
});

test("a skipped key, and arguments that are not an object", () => {
  expect(argParts({ description: "x", limit: 1 }, new Set(["description"]))).toEqual([
    { kind: "option", key: ["limit"], value: 1 }
  ]);
  expect(argParts("raw")).toEqual([{ kind: "data", key: ["arguments"], value: "raw" }]);
  expect(argParts(null)).toEqual([{ kind: "data", key: ["arguments"], value: null }]);
  expect(argParts(undefined)).toEqual([]);
  expect(argParts({})).toEqual([]);
});

test("a nested field is labelled by its path", () => {
  expect(partLabel(["patch", "needsUser"])).toBe("Patch · Needs user");
});

test("only a lone ok: true is a bare acknowledgement", () => {
  expect(isBareAck({ ok: true })).toBe(true);
  expect(isBareAck({ ok: true, id: "x" })).toBe(false);
  expect(isBareAck({ ok: false })).toBe(false);
  expect(isBareAck("ok")).toBe(false);
});

test("a timestamp is an ISO date and time that parses", () => {
  expect(isTimestamp("2026-09-09T16:13:51.727Z")).toBe(true);
  expect(isTimestamp("2026-09-09T16:13+08:00")).toBe(true);
  expect(isTimestamp("2026-09-09")).toBe(false);
  expect(isTimestamp("2026-13-45T99:99:99Z")).toBe(false);
  // The calendar, checked by hand: Date.parse would roll these over.
  expect(isTimestamp("2027-02-30T10:00:00Z")).toBe(false);
  expect(isTimestamp("2027-02-29T10:00:00Z")).toBe(false);
  expect(isTimestamp("2028-02-29T10:00:00Z")).toBe(true);
  expect(isTimestamp("2026-04-31T10:00:00Z")).toBe(false);
  expect(isTimestamp("2026-12-31T23:59:59Z")).toBe(true);
  expect(isTimestamp("2026-12-31T24:00:00Z")).toBe(false);
  expect(isTimestamp("2026-12-31T23:60:00Z")).toBe(false);
  expect(isTimestamp("2026-00-10T10:00:00Z")).toBe(false);
  expect(isTimestamp("2026-01-00T10:00:00Z")).toBe(false);
  expect(isTimestamp("")).toBe(false);
});

test("a list item is its title, its id, and up to three short fields", () => {
  expect(itemSummary({
    paneId: "%133",
    name: "Codex review",
    description: "x".repeat(41),
    command: "codex",
    status: "running",
    score: 0.5,
    extra: "too many",
    blank: " ",
    gone: null
  })).toEqual({
    title: "Codex review",
    titleKey: "name",
    id: "%133",
    meta: [["command", "codex"], ["status", "running"], ["score", 0.5]]
  });
  // No title: the id stands in, and a title field that is blank does not count.
  expect(itemSummary({ id: "mem_1", title: "  ", kind: "semantic" })).toEqual({
    title: null,
    titleKey: null,
    id: "mem_1",
    meta: [["kind", "semantic"]]
  });
});

test("a laid-out value's height is counted in lines, not characters", () => {
  // Forty one-letter items are a short JSON and a tall list.
  expect(layoutRows(Array.from({ length: 40 }, () => "x"))).toBe(40);
  expect(layoutRows([{ a: 1 }, { b: 2 }])).toBe(4);
  expect(layoutRows([])).toBe(1);
  expect(layoutRows({ a: 1, b: [1, 2], c: { d: 1, e: 2 }, f: [{ g: 1 }] })).toBe(1 + 1 + (1 + 2) + (1 + 2));
  expect(layoutRows({})).toBe(1);
  // Deep enough to be JSON: its own lines.
  // {"d": 1} four levels down is JSON of three lines.
  expect(layoutRows({ a: { b: { c: { d: 1 } } } })).toBe(1 + 1 + 1 + 3);
});
