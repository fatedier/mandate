import { expect, test } from "bun:test";
import { parseDesignIndex } from "../src/server/modules/canvas/design-index.js";

const ok = (value: unknown) => {
  const parsed = parseDesignIndex(JSON.stringify(value));
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
};
const error = (text: string) => {
  const parsed = parseDesignIndex(text);
  if (!("error" in parsed)) throw new Error("expected a refusal");
  return parsed.error;
};

test("a minimal index normalizes to one implicit page, canvas launch and board defaults", () => {
  const { index, warnings } = ok({ v: 3, boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844 } } });
  expect(warnings).toEqual([]);
  expect(index).toEqual({
    title: null,
    pages: [{ id: "main", name: "" }],
    boards: [{ path: "Main.html", x: 0, y: 0, w: 390, h: 844, title: null, page: "main", expand: null, interactive: false, radius: 0 }],
    notes: [],
    launch: { view: "canvas", page: "main" }
  });
});

test("the full shape: pages, order, notes, launch, and keys the viewer ignores", () => {
  const { index, warnings } = ok({
    v: 3, title: " Checkout redesign ", createdOnFiles: { v: 1, at: "2026-09-28T00:00:00Z" }, designSystems: [],
    launch: { view: "focused", file: "Checkout.html" },
    pages: [{ id: "flows", name: "Flows" }, { id: "empty", name: "Empty states" }],
    boards: {
      "Checkout.html": { x: 470, y: 0, w: 390, h: 844, title: "Checkout", is_interactive: true, radius: 28, guides: [] },
      "Cart.html": { x: 0, y: 0, w: 390, h: 844, title: "Cart", expand: "fill" },
      "screens/Empty.html": { x: 0, y: 0, w: 390, h: 844, page: "empty" }
    },
    order: ["Cart.html", "Checkout.html", "screens/Empty.html"],
    notes: {
      row: { x: 0, y: -300, text: "Cart", kind: "title1", maxW: 860, bold: true },
      why: { x: 0, y: 944, text: "Totals move up", w: 240, fill: "yellow", size: "l" },
      shape: { x: 0, y: 0, text: "", kind: "rect" }
    }
  });
  expect(warnings).toEqual([]);
  expect(index.title).toBe("Checkout redesign");
  expect(index.pages.map((p) => p.id)).toEqual(["flows", "empty"]);
  expect(index.boards.map((b) => b.path)).toEqual(["Cart.html", "Checkout.html", "screens/Empty.html"]);
  expect(index.boards[0]).toMatchObject({ page: "flows", expand: "fill", interactive: false });
  expect(index.boards[1]).toMatchObject({ interactive: true, radius: 28, title: "Checkout" });
  expect(index.boards[2]!.page).toBe("empty");
  // A hand-drawn shape (rect, oval, pen…) is not a note here.
  expect(index.notes.map((n) => [n.id, n.kind])).toEqual([["row", "title1"], ["why", "sticky"]]);
  expect(index.notes[1]).toMatchObject({ w: 240, fill: "yellow", size: "l", page: "flows" });
  expect(index.launch).toEqual({ view: "focused", path: "Checkout.html" });
});

test("an index that cannot be read is refused with what is wrong", () => {
  expect(error("{not json")).toMatch(/^canvas\.json is not valid JSON/);
  expect(error("[]")).toMatch(/^canvas\.json must be an object with a "boards" object/);
  expect(error('{"v":3}')).toMatch(/^canvas\.json must be an object with a "boards" object/);
  expect(error('{"boards":{}}')).toMatch(/lists no artboards/);
  expect(error('{"boards":{"Main.html":{"x":0,"y":0,"w":"390","h":844}}}')).toMatch(/^"Main\.html": x, y, w and h must be numbers/);
});

test("an artboard path must name a file inside the canvas folder", () => {
  for (const bad of ["My Screen.html", "../x.html", "/x.html", "a/../x.html", "x.htm", "x\\y.html", ".hidden.html", "a//b.html"]) {
    expect(error(JSON.stringify({ boards: { [bad]: { x: 0, y: 0, w: 390, h: 844 } } }))).toMatch(/is not an artboard path/);
  }
  expect(ok({ boards: { "screens/v2/Main-phone_2.html": { x: 0, y: 0, w: 390, h: 844 } } }).index.boards[0]!.path).toBe("screens/v2/Main-phone_2.html");
});

test("sizes outside 40–8000 are clamped and warned about", () => {
  const { index, warnings } = ok({ boards: { "Main.html": { x: 0, y: 0, w: 20, h: 9000 } } });
  expect(index.boards[0]).toMatchObject({ w: 40, h: 8000 });
  expect(warnings).toEqual(['"Main.html" is 20×9000: an artboard\'s w and h are 40–8000 px.']);
});

test("overlapping frames on the same page are warned about; on different pages they are not", () => {
  const { warnings } = ok({
    pages: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    boards: {
      "One.html": { x: 0, y: 0, w: 390, h: 844 },
      "Two.html": { x: 300, y: 0, w: 390, h: 844 },
      "Three.html": { x: 0, y: 0, w: 390, h: 844, page: "b" }
    }
  });
  expect(warnings).toEqual(['"One.html" and "Two.html" overlap on the canvas: keep frames 80 px apart within a row and rows 120 px apart.']);
});

test("order, pages, notes and launch that name nothing are warned about and fall back", () => {
  const { index, warnings } = ok({
    pages: [{ id: "flows", name: "Flows" }, { id: "bad id!", name: "x" }],
    boards: { "A.html": { x: 0, y: 0, w: 100, h: 100, page: "nowhere" }, "B.html": { x: 200, y: 0, w: 100, h: 100 } },
    order: ["B.html", "Ghost.html"],
    notes: { n1: { x: 0, y: -300, text: "Row", kind: "title1", page: "nowhere" }, "bad id!": { x: 0, y: 0, text: "x" }, n2: { x: 0, y: 0 } },
    launch: { view: "focused", file: "Ghost.html" }
  });
  expect(index.boards.map((b) => b.path)).toEqual(["B.html", "A.html"]);
  expect(index.boards[1]!.page).toBe("flows");
  expect(index.notes.map((n) => [n.id, n.page])).toEqual([["n1", "flows"]]);
  expect(index.launch).toEqual({ view: "canvas", page: "flows" });
  expect(warnings).toEqual([
    'Page "bad id!" is skipped: a page is {"id","name"} with an id of letters, digits, "_" or "-" (at most 40).',
    '"A.html" names page "nowhere", which is not in "pages"; it shows on the first page.',
    '"order" names "Ghost.html", which is not in "boards".',
    '"A.html" is in "boards" but not in "order"; it is drawn last.',
    'Note "n1" names page "nowhere", which is not in "pages"; it shows on the first page.',
    'Note "bad id!" is skipped: note ids are letters, digits, "_" or "-" (at most 40).',
    'Note "n2" is skipped: a note needs numbers x and y and a string text.',
    '"launch" opens "Ghost.html", which is not in "boards"; the canvas opens on its first page.'
  ]);
});

test("at most 40 pages and 200 notes are kept", () => {
  const pages = Array.from({ length: 41 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const notes = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`n${i}`, { x: i * 300, y: 0, text: "x" }]));
  const { index, warnings } = ok({ pages, notes, boards: { "Main.html": { x: 0, y: 2000, w: 390, h: 844 } } });
  expect(index.pages).toHaveLength(40);
  expect(index.notes).toHaveLength(200);
  expect(warnings).toEqual([
    '"pages" has 41 entries; only the first 40 are kept.',
    '"notes" has 201 entries; only the first 200 are kept.'
  ]);
});

test("a canvas launch on a named page opens there", () => {
  const { index } = ok({ pages: [{ id: "a", name: "A" }, { id: "b", name: "B" }], boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844 } }, launch: { view: "canvas", page: "b" } });
  expect(index.launch).toEqual({ view: "canvas", page: "b" });
});

test("optional fields of the wrong type are ignored with a warning, never a refusal", () => {
  const { index, warnings } = ok({
    title: null,
    order: ["Main.html", 3],
    boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844, title: null, radius: null, page: 2, is_interactive: "yes", expand: true } }
  });
  expect(index.title).toBeNull();
  expect(index.boards[0]).toMatchObject({ title: null, radius: 0, page: "main", interactive: false, expand: null });
  expect(warnings).toEqual([
    '"title" is not a string; it is ignored.',
    '"Main.html": title, page, is_interactive, radius, expand are not the right type; they are ignored.',
    '"order" has an entry that is not a string; it is skipped.'
  ]);
  expect(ok({ order: "Main.html", boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844 } } }).warnings)
    .toEqual(['"order" is not a list of paths; the boards keep their canvas.json order.']);
});

test("pages or notes of the wrong type are ignored with a warning, not refused", () => {
  const { index, warnings } = ok({ pages: null, notes: [], boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844 } } });
  expect(index.pages).toEqual([{ id: "main", name: "" }]);
  expect(index.notes).toEqual([]);
  expect(warnings).toEqual([
    '"pages" is not a list; the canvas has one page.',
    '"notes" is not an object of notes; there are none.'
  ]);
});

test("hand-drawn shapes are dropped silently, even without text; a duplicate page is warned about", () => {
  const { index, warnings } = ok({
    pages: [{ id: "a", name: "A" }, { id: "a", name: "Copy" }],
    notes: { shape: { x: 0, y: 0, kind: "rect", w: 100 }, line: { kind: "arrow" }, "Rectangle 1": { x: 0, y: 0, kind: "rect" } },
    boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844 } }
  });
  expect(index.notes).toEqual([]);
  expect(index.pages).toEqual([{ id: "a", name: "A" }]);
  expect(warnings).toEqual(['Page "a" is listed twice; the second is skipped.']);
});

test("a note keeps its place and text when an optional field is null or not a value it takes", () => {
  const { index, warnings } = ok({
    boards: { "Main.html": { x: 0, y: 0, w: 390, h: 844 } },
    notes: {
      why: { x: 0, y: 944, text: "Totals move up", kind: null, w: null, maxH: -5, size: "24px", bold: "yes", fill: "white", color: "#333" },
      row: { x: 0, y: -300, text: "Checkout", kind: "title1", maxW: 0, size: "huge" }
    }
  });
  expect(index.notes).toEqual([
    { id: "why", kind: "sticky", x: 0, y: 944, text: "Totals move up", page: "main", w: null, maxW: null, maxH: null, size: 24, bold: false, italic: false, color: "#333", fill: null },
    { id: "row", kind: "title1", x: 0, y: -300, text: "Checkout", page: "main", w: null, maxW: null, maxH: null, size: null, bold: false, italic: false, color: null, fill: null }
  ]);
  expect(warnings).toEqual([
    'Note "why": maxH, bold, fill are not valid for a note; they are ignored.',
    'Note "row": maxW, size are not valid for a note; they are ignored.'
  ]);
});

test("frames stacked on one spot are warned about in a few lines, not one per pair", () => {
  const boards = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`B${i}.html`, { x: 0, y: 0, w: 390, h: 844 }]));
  const { warnings } = ok({ boards });
  expect(warnings).toHaveLength(6);
  expect(warnings[0]).toBe('"B0.html" and "B1.html" overlap on the canvas: keep frames 80 px apart within a row and rows 120 px apart.');
  expect(warnings[5]).toBe("40 more pairs of frames overlap: give each frame its own x and y.");
});
