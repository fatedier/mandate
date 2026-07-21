import { describe, expect, test } from "bun:test";
import { canvasOutline, removeCanvasBlock } from "../src/server/modules/canvas/canvas-outline.js";

/**
 * A canvas is maintained like a source file — 4,412 `edit` calls against 438
 * `write` across assistant messages touching canvas paths. Inserting anchors on
 * any nearby tag; deleting means matching a whole block, so nothing is ever
 * deleted. These two functions make removal cost what insertion costs.
 *
 * The structure they address was measured, not assumed: of 484 headings in 97
 * real canvases the nearest ancestor is a `<div>` 70% of the time, so the
 * addressable level is the container's direct children rather than whatever
 * wraps a heading.
 */

const doc = (main: string, wrapper = "main") =>
  `<!doctype html><html><head><style>.a{color:red}</style></head>` +
  `<body><${wrapper}>${main}</${wrapper}></body></html>`;

const SAMPLE = doc(`
  <header><h1>Title</h1></header>
  <section><h2>Response path</h2><p>hello <b>world</b></p></section>
  <div class="grid"><div><h2>Test matrix</h2><p>abc</p></div></div>
  <footer>notes</footer>
`);

describe("canvasOutline", () => {
  test("addresses the container's direct children", async () => {
    const outline = await canvasOutline(SAMPLE);
    expect(outline.container).toBe("main");
    expect(outline.blocks.map((b) => [b.index, b.tag, b.label])).toEqual([
      [1, "header", "Title"],
      [2, "section", "Response path"],
      [3, "div", "Test matrix"],
      [4, "footer", "notes"]
    ]);
  });

  test("finds a heading nested below the block, not only a direct child", async () => {
    // 70% of headings sit inside a div inside their block. Block 3 above is
    // exactly that shape.
    const outline = await canvasOutline(SAMPLE);
    expect(outline.blocks[2]!.label).toBe("Test matrix");
  });

  test("counts visible characters, not markup", async () => {
    const heavy = doc(`<section class="rounded-xl bg-slate-900 ring-1 ring-white/10 p-6">
      <h2>Short</h2><p><b>abc</b></p></section>`);
    const outline = await canvasOutline(heavy);
    // "Short" + "abc" = 8, plus the space the whitespace collapse leaves.
    expect(outline.blocks[0]!.chars).toBeLessThan(12);
  });

  test("falls back to a text prefix when a block has no heading", async () => {
    // 31% of blocks in the real corpus carry no heading, and 225 of them shared
    // an empty label with a sibling — which would let a stale index pass the
    // guard. The prefix took that to 11.
    const outline = await canvasOutline(doc(`
      <div><p>First unlabelled block</p></div>
      <div><p>Second unlabelled block</p></div>
    `));
    expect(outline.blocks.map((b) => b.label)).toEqual([
      "First unlabelled block",
      "Second unlabelled block"
    ]);
  });

  test("a block that is itself a heading names itself", async () => {
    const outline = await canvasOutline(doc(`<h1>Bare title</h1><section><p>x</p></section>`));
    expect(outline.blocks[0]!.label).toBe("Bare title");
  });

  test("takes the first heading in a block, not the last", async () => {
    // Blocks routinely carry sub-headings; the label has to name the block, and
    // a label that drifted to the last h3 would name a detail inside it.
    const outline = await canvasOutline(doc(`
      <section><h2>Caching</h2><h3>schemaVersion</h3><h3>ETag</h3></section>
    `));
    expect(outline.blocks[0]!.label).toBe("Caching");
  });

  test("reports body as the container when there is no single wrapper", async () => {
    // 4 of 97 real canvases have no wrapper. Indices mean nothing without
    // knowing which element they count within.
    const outline = await canvasOutline(
      `<body><section><h2>A</h2></section><section><h2>B</h2></section></body>`
    );
    expect(outline.container).toBe("body");
    expect(outline.blocks.map((b) => b.label)).toEqual(["A", "B"]);
  });

  test("survives a void element among the blocks themselves", async () => {
    // The block level is where a divider or image sits, and `onEndTag` throws
    // for those. Probing beats listing: the real corpus threw on <path>, <rect>
    // and <circle>, none of which are in the HTML void list.
    const outline = await canvasOutline(doc(`
      <section><h2>Before</h2></section>
      <hr/>
      <section><h2>After</h2></section>
    `));
    expect(outline.blocks.map((b) => b.label)).toEqual(["Before", "After"]);
  });

  test("survives self-closed foreign content", async () => {
    // `onEndTag` throws for these. Listing void tags missed inline SVG and
    // broke 5 of 171 real canvases; the code probes instead.
    const outline = await canvasOutline(doc(`
      <section><h2>Chart</h2><svg><path d="M0 0"/><circle r="2"/></svg></section>
      <section><h2>After</h2></section>
    `));
    expect(outline.blocks.map((b) => b.label)).toEqual(["Chart", "After"]);
  });

  test("ignores head content", async () => {
    const outline = await canvasOutline(SAMPLE);
    expect(outline.blocks.some((b) => b.label.includes("color:red"))).toBe(false);
  });
});

describe("removeCanvasBlock", () => {
  test("takes the named block and leaves its siblings intact", async () => {
    const result = await removeCanvasBlock(SAMPLE, 3, "Test matrix");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.removed.label).toBe("Test matrix");
    expect(result.outline.blocks.map((b) => b.label)).toEqual([
      "Title",
      "Response path",
      "notes"
    ]);
    expect(result.html).toContain("Response path");
    expect(result.html).toContain("hello");
    expect(result.html).not.toContain("Test matrix");
  });

  test("refuses when the label at that position has moved", async () => {
    // The whole reason the label is required: positions shift the moment
    // anything is removed, so an outline read a few steps ago may describe a
    // document that no longer exists. Without this, "remove block 3" run twice
    // deletes two unrelated blocks.
    const once = await removeCanvasBlock(SAMPLE, 3, "Test matrix");
    expect(once.ok).toBe(true);
    if (!once.ok) return;

    const twice = await removeCanvasBlock(once.html, 3, "Test matrix");
    expect(twice.ok).toBe(false);
    if (twice.ok) return;
    expect(twice.error).toContain("notes");
    expect(twice.error).toContain("Test matrix");
  });

  test("removes nothing when it refuses", async () => {
    const refused = await removeCanvasBlock(SAMPLE, 2, "Test matrix");
    expect(refused.ok).toBe(false);
    const untouched = await canvasOutline(SAMPLE);
    expect(untouched.blocks).toHaveLength(4);
  });

  test("reports the addressable range for an index that is out of it", async () => {
    const result = await removeCanvasBlock(SAMPLE, 9, "anything");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("1-4");
  });

  test("compares labels with whitespace collapsed", async () => {
    const result = await removeCanvasBlock(SAMPLE, 2, "  Response   path \n");
    expect(result.ok).toBe(true);
  });

  test("removing the last block leaves an addressable, empty canvas", async () => {
    const one = doc(`<section><h2>Only</h2></section>`);
    const result = await removeCanvasBlock(one, 1, "Only");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline.blocks).toHaveLength(0);
  });

  test("refuses when the position is ambiguous across nested containers", async () => {
    // `main > :nth-child(2)` matches inside a nested <main> too. Removing both
    // would silently take a block the caller never named.
    const nested =
      `<body><main><section><h2>A</h2></section>` +
      `<section><h2>B</h2><main><p>x</p><p>y</p></main></section></main></body>`;
    const result = await removeCanvasBlock(nested, 2, "B");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("matched 2");
  });

  test("removes the block at the given position, not the first match", async () => {
    // Fed so that position and insertion order disagree: without honouring the
    // index, taking "Repeat" would take block 1.
    const repeated = doc(`
      <section><h2>Repeat</h2><p>first</p></section>
      <section><h2>Middle</h2></section>
      <section><h2>Repeat</h2><p>third</p></section>
    `);
    const result = await removeCanvasBlock(repeated, 3, "Repeat");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("first");
    expect(result.html).not.toContain("third");
  });
});
