import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { DiffHunkView } from "@/routes/window/changes/DiffHunkView";
import { parseUnifiedDiff } from "@/lib/diff-parse";

const PATCH = [
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,3 @@",
  " ctxline",
  "-oldline",
  "+freshline",
  "+extraline"
].join("\n");

function renderRows(): string[] {
  const html = renderToString(<DiffHunkView hunks={parseUnifiedDiff(PATCH)} />);
  return html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
}

describe("DiffHunkView", () => {
  test("renders the hunk header", () => {
    const html = renderToString(<DiffHunkView hunks={parseUnifiedDiff(PATCH)} />);
    expect(html).toContain("@@ -1,2 +1,3 @@");
  });

  test("renders a paired del/add in one row, old left and new right", () => {
    const paired = renderRows().find((r) => r.includes("oldline"));
    expect(paired).toBeDefined();
    expect(paired!).toContain("freshline");
    expect(paired!.indexOf("oldline")).toBeLessThan(paired!.indexOf("freshline"));
    expect(paired!).toContain("bg-diff-del-bg");
    expect(paired!).toContain("bg-diff-add-bg");
  });

  test("renders an unpaired add with an empty left side", () => {
    const extra = renderRows().find((r) => r.includes("extraline"));
    expect(extra).toBeDefined();
    expect(extra!).not.toContain("bg-diff-del-bg");
  });

  test("renders context text on both sides", () => {
    const ctx = renderRows().find((r) => r.includes("ctxline"));
    expect(ctx).toBeDefined();
    expect(ctx!.match(/ctxline/g)?.length).toBe(2);
  });
});

/** Old and new line numbers deliberately differ, so a context row tells
 *  `newNo ?? oldNo` (40) apart from `oldNo ?? newNo` (27). With the usual
 *  matching numbers both orders render the same digits and the gutter
 *  semantics go untested. */
const SHIFTED_PATCH = [
  "--- a/b.txt",
  "+++ b/b.txt",
  "@@ -27,2 +40,2 @@",
  " ctxline",
  "-oldline",
  "+freshline"
].join("\n");

/** A four-digit line number — the case the gutter has to fit. */
const WIDE_PATCH = ["--- a/c.txt", "+++ b/c.txt", "@@ -1000,1 +1000,1 @@", " ctxline"].join("\n");

function render(unified: boolean, patch: string = SHIFTED_PATCH): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToString(
    <DiffHunkView hunks={parseUnifiedDiff(patch)} unified={unified} />
  );
  return host;
}

function classTokens(el: Element): string[] {
  return el.className.split(/\s+/);
}

describe("DiffHunkView unified mode", () => {
  test("renders one row per diff line, not paired rows", () => {
    const host = render(true);
    const rows = host.querySelectorAll('[data-slot="diff-line"]');
    expect(rows.length).toBe(3);
    expect(host.querySelector("table")).toBeNull();
    // The sign column carries what colour alone would: a colour-blind reader
    // still sees the direction of each line.
    expect(rows[1]!.textContent).toContain("-");
    expect(rows[2]!.textContent).toContain("+");
  });

  test("renders the hunk header", () => {
    expect(render(true).textContent).toContain("@@ -27,2 +40,2 @@");
  });

  test("lines can exceed the scroll container instead of wrapping", () => {
    const scroller = render(true).firstElementChild as HTMLElement;
    expect(classTokens(scroller)).toContain("overflow-x-auto");
    // The content must be allowed to be wider than the scroller. The split
    // view is `w-full table-fixed` inside the same `overflow-x-auto`, which is
    // why its horizontal scroll can never fire and the text wraps instead.
    const content = scroller.firstElementChild as HTMLElement;
    // Exact tokens, never substrings. `expect(className).toContain(
    // "whitespace-pre")` on the raw string is also satisfied by
    // `whitespace-pre-wrap` and `whitespace-pre-line` — both of which wrap,
    // which is precisely the regression this test exists to catch.
    expect(classTokens(content)).toContain("min-w-max");
    expect(classTokens(content)).toContain("whitespace-pre");
  });

  test("gutter shows the new-file line number, falling back to the old one", () => {
    const rows = render(true).querySelectorAll('[data-slot="diff-line"]');
    const gutter = (row: Element) => row.firstElementChild!.textContent!.trim();
    expect(gutter(rows[0]!)).toBe("40"); // context: new side, not the old 27
    expect(gutter(rows[1]!)).toBe("28"); // deletion: only oldNo exists
    expect(gutter(rows[2]!)).toBe("41"); // addition
  });

  test("gutter is wide enough for a four-digit line number", () => {
    const row = render(true, WIDE_PATCH).querySelector('[data-slot="diff-line"]')!;
    expect(row.firstElementChild!.textContent!.trim()).toBe("1000");
    // happy-dom does no layout, so the width can only be asserted as a class.
    // `w-10` (40px) less `pr-2` (8px) leaves 32px for 4 digits at 7.83px each
    // (31.3px). `w-9` leaves 28px, and since the number is `text-right` the
    // overflow lands left of x=0 where scrolling cannot reach it.
    expect(classTokens(row.firstElementChild!)).toContain("w-10");
  });

  test("split mode is unchanged — still a fixed table", () => {
    const host = render(false);
    const table = host.querySelector("table");
    expect(table).not.toBeNull();
    expect(classTokens(table!)).toContain("table-fixed");
    expect(host.querySelectorAll('[data-slot="diff-line"]').length).toBe(0);
  });
});
